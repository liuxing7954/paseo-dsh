/**
 * Catalog probe: list every provider, model and reasoning level a profile can
 * serve, as DSH itself reports them.
 *
 * Usage:
 *   node harness/catalog.mjs
 *   DSH_PASEO_PROFILE=my-profile node harness/catalog.mjs
 */
import { spawn } from 'node:child_process';

const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';
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
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    if (f.id !== undefined && pending.has(f.id)) {
      const entry = pending.get(f.id);
      pending.delete(f.id);
      if (f.error) entry.reject(new Error(f.error.message));
      else entry.resolve(f.result);
    }
  }
});
child.stderr.on('data', () => {});

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => pending.delete(id) && reject(new Error('timeout')), 90000);
  });

try {
  await request('initialize', { cwd: process.cwd() });
  const catalog = await request('paseo/catalog', {});
  console.log('providers:');
  for (const p of catalog.providers) console.log(`  ${p.id.padEnd(20)} ${p.name}`);
  console.log('\nmodels:');
  for (const m of catalog.models) {
    const reasoning = m.reasoning
      ? `default=${m.reasoning.defaultEffort ?? '-'} efforts=[${m.reasoning.efforts.map((e) => e.id).join(', ')}]`
      : 'no reasoning control';
    console.log(`  ${m.provider.padEnd(18)} ${m.id.padEnd(24)} ${m.name.padEnd(20)} ${reasoning}`);
  }
  console.log('\ndefaults:', JSON.stringify({
    provider: catalog.defaultProvider,
    model: catalog.defaultModel,
    reasoningEffort: catalog.defaultReasoningEffort,
    planMode: catalog.planMode,
  }));
  await request('shutdown', {});
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
}
child.kill();
