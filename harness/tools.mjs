/**
 * Tool-visibility probe: dumps every JSON-RPC frame from a minimal turn so the
 * model's visible tool catalog can be inspected.
 *
 * Usage: node harness/tools.mjs
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const SESSION_ID = `tools-${Date.now()}`;
const OUT = new URL('./frames.jsonl', import.meta.url).pathname;
const out = createWriteStream(OUT);

const child = spawn('dsh', ['--profile', process.env.DSH_PASEO_PROFILE ?? 'paseo'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

const pending = new Map();
let nextId = 1;
let buffer = '';
let asked = 0;

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 180000);
  });
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    out.write(`${line}\n`);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.method === 'paseo/question') {
      asked += 1;
      console.log('>>> paseo/question arrived:', JSON.stringify(frame.params).slice(0, 300));
      send({ jsonrpc: '2.0', id: frame.id, result: { answers: [] } });
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(frame.error.message));
      else entry.resolve(frame.result);
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`));

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // No provider/model: the bridge falls back to the profile's own default.
  await request('initialize', { cwd: process.cwd() });
  console.log('initialized');

  await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [
      {
        type: 'text',
        text:
          'Do not call any tool. Reply with the exact names of every tool available to you, ' +
          'one per line, prefixed with "TOOL: ". Include ask_user_question if you have it.',
      },
    ],
  });

  await sleep(45000);
  console.log(`\npaseo/question arrivals: ${asked}`);
  console.log(`frames written to ${OUT}`);
  try {
    await request('shutdown', {});
  } catch {
    /* expected */
  }
  await sleep(1000);
  out.end();
  child.kill();
}

main().catch((error) => {
  console.error('FAILED:', error);
  out.end();
  child.kill();
  process.exitCode = 1;
});
