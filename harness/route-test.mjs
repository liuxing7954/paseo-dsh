/**
 * Route test: find which provider/model routes in a profile actually complete a
 * turn.
 *
 * The route list is read from the profile's own catalog, so nothing here is
 * tied to one machine: every model `dsh --profile <name>` knows about is tried,
 * and the results tell you which ones to point the composer at.
 *
 * This also demonstrates why `assistant/attempt` matters: a route that fails
 * mid-stream reports it there rather than through an error item, so a probe that
 * only watches assistant messages sees silence instead of the reason.
 *
 * Usage:
 *   node harness/route-test.mjs
 *   DSH_PASEO_PROFILE=my-profile node harness/route-test.mjs
 */
import { spawn } from 'node:child_process';

const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn one bridge process and return JSON-RPC plus a raw event sink. */
function bridge(onEvent) {
  const child = spawn('dsh', ['--profile', PROFILE], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.method === 'session.event') onEvent?.(frame.params.event);
      if (frame.id !== undefined && pending.has(frame.id)) {
        const entry = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(frame.error.message));
        else entry.resolve(frame.result);
      }
    }
  });
  child.stderr.on('data', () => {});

  return {
    child,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error('timeout'));
        }, 90000);
      }),
  };
}

/** Every route the profile reports. */
async function listRoutes() {
  const { child, request } = bridge();
  try {
    const catalog = await request('paseo/catalog', {});
    return (catalog.models ?? []).map((model) => ({ provider: model.provider, model: model.id }));
  } finally {
    child.kill();
    await sleep(300);
  }
}

async function tryRoute({ provider, model }) {
  let text = '';
  let failure = null;
  const { child, request } = bridge((event) => {
    if (event.type === 'assistant/attempt') {
      for (const record of event.data.stream ?? []) {
        if (record.type !== 'chunk') continue;
        if (record.chunk?.type === 'text') text += record.chunk.text ?? '';
        if (record.chunk?.type === 'finish' && record.chunk.reason?.kind === 'error') {
          failure = record.chunk.reason.failure?.message ?? 'error';
        }
      }
    }
    if (event.type === 'turn/end' && event.data.reason?.kind === 'error') {
      failure = event.data.reason.error?.message ?? 'error';
    }
  });
  try {
    await request('initialize', { cwd: process.cwd(), provider, model });
    await request('session/prompt', {
      sessionId: `route-${Date.now()}`,
      contentBlocks: [{ type: 'text', text: 'Reply with exactly: PONG' }],
    });
    await sleep(25000);
  } catch (error) {
    failure ??= error.message;
  }
  child.kill();
  await sleep(300);
  return { provider, model, text: text.trim().slice(0, 60), failure: failure?.slice(0, 110) ?? null };
}

const routes = await listRoutes();
if (routes.length === 0) {
  console.error(`profile "${PROFILE}" reports no models; check its cordis.patch.yml`);
  process.exit(2);
}
console.log(`profile "${PROFILE}": ${routes.length} route(s)\n`);

for (const route of routes) {
  const result = await tryRoute(route);
  const verdict = result.text ? 'WORKS ' : 'FAILS ';
  console.log(
    `${verdict} ${result.provider}/${result.model}  text=${JSON.stringify(result.text)}  err=${result.failure ?? '-'}`,
  );
}
