require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
const { createDshProvider } = require('../server/provider.ts');
const { ProviderEventSchema, PROVIDER_CAPABILITIES } = require('@getpaseo/plugin/server/provider');

// --- Bridge side: which sessions are asked, and what counts as activity -----

/**
 * A root context whose waterfall answers from `reports` (session id -> what DSH
 * would report) and records every session it was asked about.
 */
function fakeCtx({ live, reports = {}, parents = {} }) {
  const asked = [];
  const ctx = {
    agents: { list: () => live.map(id => ({ id, session: { id } })) },
    async waterfall(event, payload, base) {
      assert.equal(event, 'workspace/session-activity');
      asked.push(payload.sessionId);
      return payload.sessionId in reports ? reports[payload.sessionId] : base();
    },
  };
  return { ctx, asked, parentOf: id => parents[id] };
}

test('a root asks every live agent, because releasing it ends the whole process', async () => {
  const { runtimeActivity } = await import('../../dsh-bridge/lib/activity.js');
  const { ctx, asked, parentOf } = fakeCtx({
    live: ['root', 'child', 'unrelated-fork'],
    reports: { child: [{ kind: 'job', items: [{ id: 'job-1', label: 'sleep 40' }] }] },
    parents: { child: 'root' },
  });
  const activity = await runtimeActivity(ctx, { sessionId: 'root', wholeProcess: true, parentOf });
  assert.deepEqual(asked.sort(), ['child', 'root', 'unrelated-fork']);
  assert.deepEqual(activity, [{ sessionId: 'child', kind: 'job', items: [{ id: 'job-1', label: 'sleep 40' }] }],
    'a job an idle child still owns must keep the root process alive');
});

test('a root whose agent was never created is still asked, and reports nothing', async () => {
  const { runtimeActivity } = await import('../../dsh-bridge/lib/activity.js');
  const { ctx, asked, parentOf } = fakeCtx({ live: [] });
  assert.deepEqual(await runtimeActivity(ctx, { sessionId: 'root', wholeProcess: true, parentOf }), []);
  assert.deepEqual(asked, ['root']);
});

test('a child asks only its own subtree, because releasing it drains only that subtree', async () => {
  const { runtimeActivity } = await import('../../dsh-bridge/lib/activity.js');
  const { ctx, asked, parentOf } = fakeCtx({
    live: ['root', 'a', 'a-1', 'a-1-x', 'b'],
    reports: { root: [{ kind: 'turn' }], b: [{ kind: 'subagent', items: [{ id: 'b-1' }] }] },
    parents: { a: 'root', 'a-1': 'a', 'a-1-x': 'a-1', b: 'root' },
  });
  assert.deepEqual(await runtimeActivity(ctx, { sessionId: 'a', wholeProcess: false, parentOf }), [],
    "the parent's running turn and a sibling's work are not this child's to keep");
  assert.deepEqual(asked.sort(), ['a', 'a-1', 'a-1-x']);
});

test('a lineage cycle ends the walk instead of hanging', async () => {
  const { runtimeActivity } = await import('../../dsh-bridge/lib/activity.js');
  const { ctx, asked, parentOf } = fakeCtx({ live: ['x', 'y'], parents: { x: 'y', y: 'x' } });
  await runtimeActivity(ctx, { sessionId: 'a', wholeProcess: false, parentOf });
  assert.deepEqual(asked, ['a']);
});

test('every reported family counts, a malformed one included', async () => {
  const { runtimeActivity } = await import('../../dsh-bridge/lib/activity.js');
  const { ctx, parentOf } = fakeCtx({
    live: ['root'],
    reports: { root: [{ kind: 'turn' }, { kind: 'schedule', items: [{ id: 7, label: '' }, null] }, {}, null] },
  });
  assert.deepEqual(await runtimeActivity(ctx, { sessionId: 'root', wholeProcess: true, parentOf }), [
    { sessionId: 'root', kind: 'turn' },
    { sessionId: 'root', kind: 'schedule', items: [{ id: '7' }, { id: '' }] },
    { sessionId: 'root', kind: 'unknown' },
    { sessionId: 'root', kind: 'unknown' },
  ]);
});

test('a runtime that cannot say what runs fails instead of answering "nothing"', async () => {
  const { runtimeActivity } = await import('../../dsh-bridge/lib/activity.js');
  const scope = { sessionId: 'root', wholeProcess: true, parentOf: () => undefined };
  await assert.rejects(runtimeActivity({ agents: { list: () => [] } }, scope), /cannot report session activity/);
  await assert.rejects(runtimeActivity({ waterfall: async () => [] }, scope), /agent registry is unavailable/);
  await assert.rejects(runtimeActivity({ agents: { list: () => [] }, waterfall: async () => undefined }, scope),
    /answered session root with undefined, not a list/);
});

test('the bridge answers paseo/activity for its root and its own children, nothing else', async t => {
  // server.js imports DSH packages, so resolve them from the installed DSH the
  // same way child-bridge.test.cjs does; skip where DSH is not installed.
  const { pathToFileURL } = require('node:url');
  const { registerHooks } = require('node:module');
  const { resolveDshCommand } = await import('../server/dsh-command.mjs');
  const entry = resolveDshCommand(process.env.DSH_BINARY ?? 'dsh', process.env).args[0];
  if (!entry || !fs.existsSync(entry)) return t.skip('local @deepseek-ai/dsh package directory not resolved');
  const dshNodeModules = path.resolve(path.dirname(entry), '..', 'node_modules');
  if (!fs.existsSync(path.join(dshNodeModules, '@deepseek-ai', 'dsh-brand'))) return t.skip('DSH internal dependencies not colocated');
  const parentURL = pathToFileURL(path.join(dshNodeModules, '_resolver.mjs')).href;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('file:')) {
        try { return nextResolve(specifier, { ...context, parentURL }); } catch {}
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hook.deregister?.());

  const { PaseoHarnessServer } = await import('../../dsh-bridge/lib/server.js');
  const listeners = new Map(), sessions = new Map();
  const session = (id, parentSession, origin) => {
    const value = { id, header: { id, cwd: process.cwd(), ...(parentSession ? { parentSession } : {}), ...(origin ? { origin } : {}) }, seq: 0, snapshotEvents: () => [] };
    sessions.set(id, value);
    return value;
  };
  const root = session('root');
  const children = [session('child', 'root', 'subagent'), session('grandchild', 'child', 'subagent'), session('fork', 'root', 'fork')];
  const agent = s => ({ id: s.id, session: s, status: 'idle' });
  const reports = { root: [{ kind: 'turn' }], grandchild: [{ kind: 'job', items: [{ id: 'job-1', label: 'sleep 40' }] }] };
  const ctx = {
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return () => {}; },
    get(name) {
      if (name === 'llm') return { listProviders: () => [{ id: 'mock', name: 'Mock' }], resolveCallConfig: async () => ({}) };
      if (name === 'sessions') return { get: id => sessions.get(String(id)) };
      return undefined;
    },
    agents: {
      get: id => (sessions.has(String(id)) ? agent(sessions.get(String(id))) : undefined),
      create: async () => ({ agent: agent(root), dispose: async () => {} }),
      list: () => [root, ...children].map(agent),
    },
    waterfall: async (_event, { sessionId }, base) => reports[sessionId] ?? base(),
  };
  const server = new PaseoHarnessServer(ctx, { notify() {} });
  await server.initialize({ cwd: process.cwd(), provider: 'mock', model: 'mock-model', sessionId: 'root' });
  for (const child of children) for (const fn of listeners.get('session/created') ?? []) fn(child);
  t.after(() => server.shutdown());

  const kinds = result => result.activity.map(entry => `${entry.kind}@${entry.sessionId}`).sort();
  assert.deepEqual(kinds(await server.handleRequest('paseo/activity', { sessionId: 'root' })), ['job@grandchild', 'turn@root'],
    'releasing the root ends the process, so the whole process is in scope');
  assert.deepEqual(kinds(await server.handleRequest('paseo/activity', { sessionId: 'child' })), ['job@grandchild'],
    "a child answers for its subtree, not for the root's turn");
  await assert.rejects(server.handleRequest('paseo/activity', { sessionId: 'fork' }), /unknown session: fork/);
  await assert.rejects(server.handleRequest('paseo/activity', { sessionId: 'elsewhere' }), /unknown session: elsewhere/);
  await assert.rejects(server.handleRequest('paseo/activity', {}), /requires sessionId/);
});

// --- Provider side: the answer Paseo gets ----------------------------------

/**
 * A deterministic bridge over real stdio. `paseo/activity` answers whatever the
 * test last wrote to the activity file; a file holding `error` makes the bridge
 * fail the call, and `malformed` makes it answer without a list.
 */
async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activity-')));
  const log = path.join(dir, 'rpc.jsonl');
  const state = path.join(dir, 'activity.json');
  fs.writeFileSync(state, '[]');
  const cli = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(cli, `
const fs=require('node:fs');
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
const root='native-root';
const meta={sessionId:'native-child',parentSessionId:root,origin:'subagent',cwd:process.cwd()};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(process.env.TEST_RPC_LOG)fs.appendFileSync(process.env.TEST_RPC_LOG,JSON.stringify(r)+'\\n');
 if(!r.method)return;
 let result={};
 if(r.method==='paseo/config/set')result={provider:'fixture',model:'fixture',reasoningEffort:null};
 if(r.method==='paseo/catalog')result={providers:[{id:'fixture',name:'Fixture'}],models:[{provider:'fixture',id:'fixture',name:'Fixture'}],defaultProvider:'fixture',defaultModel:'fixture'};
 if(r.method==='paseo/activity'){
  const answer=fs.readFileSync(process.env.TEST_ACTIVITY,'utf8');
  if(answer==='error')return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'workspace/session-activity threw'}});
  result=answer==='malformed'?{}:{activity:JSON.parse(answer)};
 }
 send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='shutdown')return process.exit(0);
 if(r.method==='session/prompt'&&r.params.contentBlocks?.[0]?.text==='child'){
  notify('session.event',{sessionId:root,event:{type:'tool/call',data:{callId:'spawn',name:'subagent',arguments:'{}'}}});
  notify('session.child',{...meta,toolCallId:'spawn',toolName:'subagent'});
  notify('session.event',{...meta,event:{type:'subagent/descriptor',data:{version:1,mode:'continuable',label:'Child',provider:'spawn'}}});
 }
});`);
  const spawn = childProcess.spawn;
  childProcess.spawn = (_command, args, options) => spawn(process.execPath, [cli, ...args], options);
  t.after(() => { childProcess.spawn = spawn; });
  const connection = await createDshProvider().connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [], invalid = [];
  connection.onEvent(e => { const parsed = ProviderEventSchema.safeParse(e); if (!parsed.success) invalid.push(parsed.error.message); events.push(e); });
  t.after(async () => { await connection.close();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 'paseo-root', history: 'skip',
    persistence: { version: 1, data: { sessionId: 'native-root' } },
    config: { cwd: dir, env: { TEST_RPC_LOG: log, TEST_ACTIVITY: state }, persist: true, settings: {} } });
  async function until(predicate) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) { const hit = events.find(predicate); if (hit) return hit; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('missing event');
  }
  let asks = 0;
  /** Ask Paseo's question and return every event that answers it. */
  async function ask(sessionId, activity) {
    fs.writeFileSync(state, typeof activity === 'string' ? activity : JSON.stringify(activity));
    const requestId = 'stop-' + ++asks;
    await connection.send({ type: 'session.can_stop_runtime', requestId, sessionId });
    await until(e => e.requestId === requestId);
    return events.filter(e => e.requestId === requestId);
  }
  const activityCalls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(r => r.method === 'paseo/activity').map(r => r.params);
  return { connection, events, invalid, until, ask, activityCalls };
}

test('the provider declares the veto and answers it from DSH activity', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.ok(f.connection.capabilities.includes('session.can_stop_runtime'));
  const opened = await f.until(e => e.type === 'session.opened' && e.sessionId === 'paseo-root');
  assert.ok(opened.capabilities.includes('session.can_stop_runtime'));

  assert.deepEqual(await f.ask('paseo-root', []),
    [{ type: 'session.can_stop_runtime', requestId: 'stop-1', sessionId: 'paseo-root', canStop: true }]);
  assert.deepEqual(await f.ask('paseo-root', [{ sessionId: 'native-root', kind: 'job', items: [{ id: 'job-1', label: 'sleep 40' }] }]),
    [{ type: 'session.can_stop_runtime', requestId: 'stop-2', sessionId: 'paseo-root', canStop: false }]);
  assert.deepEqual(f.activityCalls(), [{ sessionId: 'native-root' }, { sessionId: 'native-root' }],
    'the bridge must be asked about the native DSH session, not the Paseo id');
  assert.deepEqual(f.invalid, []);
});

test('a child is asked about under its own native id and declares the veto', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.until(e => e.type === 'session.opened' && e.sessionId === 'paseo-root');
  await f.connection.send({ type: 'session.prompt', sessionId: 'paseo-root',
    prompt: { clientMessageId: 'msg-child', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'child' }] } } });
  const opened = await f.until(e => e.type === 'session.opened' && e.parentSessionId === 'paseo-root');
  assert.ok(opened.capabilities.includes('session.can_stop_runtime'));
  const answer = await f.ask(opened.sessionId, [{ sessionId: 'native-child', kind: 'job', items: [{ id: 'job-2' }] }]);
  assert.deepEqual(answer, [{ type: 'session.can_stop_runtime', requestId: 'stop-1', sessionId: opened.sessionId, canStop: false }]);
  assert.deepEqual(f.activityCalls(), [{ sessionId: 'native-child' }]);
  assert.deepEqual(f.invalid, []);
});

test('every failure keeps the runtime: request.failed, never canStop or request.completed', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.until(e => e.type === 'session.opened' && e.sessionId === 'paseo-root');
  for (const [sessionId, activity] of [['nobody', []], ['paseo-root', 'error'], ['paseo-root', 'malformed']]) {
    const answer = await f.ask(sessionId, activity);
    assert.equal(answer.length, 1, `${sessionId}/${activity} must get exactly one answer`);
    assert.equal(answer[0].type, 'request.failed', `${sessionId}/${activity} answered ${JSON.stringify(answer[0])}`);
  }
  assert.deepEqual(f.invalid, []);
});
