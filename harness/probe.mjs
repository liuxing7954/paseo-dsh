/**
 * Standalone probe for the `dsh --profile paseo` bridge.
 *
 * Drives the JSON-RPC surface directly, without Paseo in the loop, so the
 * bridge can be debugged in isolation. It exercises:
 *   1. initialize
 *   2. a prompt that makes the model call ask_user_question
 *   3. the server -> client `paseo/question` request (answered with option B)
 *   4. paseo/plan/get + paseo/plan/set
 *   5. paseo/config/set (thinking effort)
 *
 * Usage: node harness/probe.mjs
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const RAW = new URL('./frames-probe.jsonl', import.meta.url).pathname;
const rawOut = createWriteStream(RAW);

const SESSION_ID = `probe-${Date.now()}`;
const PROMPT =
  'Use the ask_user_question tool to ask me which deployment target to use. ' +
  'Give exactly three options: staging, canary, production. Then report which one I chose.';

const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';

const child = spawn('dsh', ['--profile', PROFILE], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

const pending = new Map();
const questions = [];
let nextId = 1;
let buffer = '';
let sawAssistantText = '';
let turnState = null;

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 180000);
  });
}

function log(...args) {
  console.log(...args);
}

function handleFrame(frame) {
  if (frame.method === 'session.event') {
    const { event } = frame.params;
    const type = event?.type ?? '?';
    if (type === 'assistant/chunk' || type === 'assistant/chunk/delta') return;
    log(`  <event ${type}>`);
    if (type === 'tool/call') {
      log('    tool/call:', JSON.stringify(frame.params.event).slice(0, 400));
    }
    return;
  }
  if (frame.method === 'session.status') {
    log(`  <status ${frame.params.status}>`);
    return;
  }
  if (frame.method === 'paseo/question') {
    const { sessionId, questions: asked, timed } = frame.params;
    questions.push(frame.params);
    log('\n>>> paseo/question (server -> client request)');
    log('    sessionId:', sessionId, 'timed:', timed);
    log('    payload:', JSON.stringify(asked, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    // Answer the second option when present, exercising option routing.
    const first = asked[0] ?? {};
    const options = first.options ?? [];
    const chosen = options[1] ?? options[0] ?? { label: 'yes' };
    const answers = asked.map((q) => ({ id: q.id, selected: [chosen.label] }));
    log(`<<< answering with: ${chosen.label}\n`);
    send({ jsonrpc: '2.0', id: frame.id, result: { answers } });
    return;
  }
  if (frame.id !== undefined && pending.has(frame.id)) {
    const entry = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(`${frame.error.message}`));
    else entry.resolve(frame.result);
  }
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    rawOut.write(`${line}\n`);
    try {
      handleFrame(JSON.parse(line));
    } catch (error) {
      log('  [stdout non-frame]', line.slice(0, 200));
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`));
child.on('exit', (code, signal) => log(`\n[dsh exited] code=${code} signal=${signal}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('--- initialize ---');
  // No provider/model: the bridge falls back to the profile's own default, so
  // this probe stays valid on any machine.
  const init = await request('initialize', { cwd: process.cwd() });
  log('initialize ->', JSON.stringify(init));

  log('\n--- session/prompt ---');
  const promptResult = await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [{ type: 'text', text: PROMPT }],
  });
  log('session/prompt accepted ->', JSON.stringify(promptResult));

  // Wait for the question round trip and the turn to settle.
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && questions.length === 0) await sleep(500);
  if (questions.length === 0) log('!! no paseo/question arrived');

  await sleep(20000);

  log('\n--- paseo/plan/get ---');
  log(JSON.stringify(await request('paseo/plan/get', { sessionId: SESSION_ID })));

  log('\n--- paseo/plan/set active=true ---');
  log(JSON.stringify(await request('paseo/plan/set', { sessionId: SESSION_ID, active: true })));

  log('\n--- paseo/plan/get ---');
  log(JSON.stringify(await request('paseo/plan/get', { sessionId: SESSION_ID })));

  log('\n--- paseo/config/set reasoningEffort=low ---');
  log(JSON.stringify(await request('paseo/config/set', { sessionId: SESSION_ID, reasoningEffort: 'low' })));

  log('\n--- paseo/catalog ---');
  log(JSON.stringify(await request('paseo/catalog', {})).slice(0, 600));

  log(`\n=== questions received: ${questions.length} ===`);
  log('--- shutdown ---');
  try {
    await request('shutdown', {});
  } catch {
    /* shutdown may close the transport first */
  }
  await sleep(1500);
  child.kill();
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  child.kill();
  process.exitCode = 1;
});
