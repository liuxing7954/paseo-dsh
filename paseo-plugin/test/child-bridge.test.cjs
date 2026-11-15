const assert = require('node:assert/strict');
const { test } = require('node:test');


test('concurrent PTC calls retain exact child provenance, nested lineage and workflow IPC correlation', async () => {
  const { Subsessions } = await import('../../dsh-bridge/lib/subsessions.js');
  const listeners = new Map(), sessions = new Map(), notifications = [];
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    get(name) { return name === 'sessions' ? { get: id => sessions.get(id) } : undefined; } };
  const roots = new Set(['root']);
  const tracker = new Subsessions(ctx, id => roots.has(id), (method, payload) => notifications.push({ method, payload }));
  const make = (id, parentSession, origin = 'subagent') => {
    const session = { id, header: { parentSession, origin } }; sessions.set(id, session);
    listeners.get('session/created')(session); return session;
  };
  const root = make('root', undefined, undefined);
  const execute = (callId, next) => listeners.get('tools/execute')({ agent: { session: root }, callId, rootCallId: 'program', name: 'delegate' }, next);
  await Promise.all(['program:ptc:1', 'program:ptc:2'].map((id, i) => execute(id, async () => {
    await new Promise(resolve => setTimeout(resolve, 5 * (1 - i)));
    const child = make('child-' + i, 'root');
    assert.equal(tracker.envelope(child).toolCallId, id);
    assert.equal(tracker.envelope(child).rootToolCallId, 'program');
  })));
  const nested = make('nested', 'child-0'); assert(tracker.owns(nested));
  assert(!tracker.owns(make('ordinary-fork', 'root', 'fork')));
  assert(!tracker.owns(make('foreign', 'elsewhere')));
  await execute('workflow-call', async () => listeners.get('workflow/start')({ id: 'run' }));
  const member = make('workflow-member', 'root');
  assert.equal(tracker.envelope(member).toolCallId, undefined);
  listeners.get('workflow/agent-start')({ id: 'run' }, { childId: member.id });
  assert.equal(notifications.at(-1).payload.toolCallId, 'workflow-call');
  listeners.get('workflow/end')({ id: 'run' });
  tracker.dispose(); assert.equal(listeners.size, 0);
});

test('bridge prompt refuses steering when root or child agent is not running without enqueueing a duplicate turn', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { registerHooks } = require('node:module');
  const { resolveDshCommand } = await import('../server/dsh-command.mjs');
  const resolved = resolveDshCommand(process.env.DSH_BINARY ?? 'dsh', process.env);
  const entry = resolved.args[0];
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
  let rootStatus = 'idle', childStatus = 'idle';
  const rootCalls = [], childCalls = [];
  const rootSession = { id: 'root', header: { id: 'root', cwd: process.cwd() }, seq: 0, snapshotEvents: () => [] };
  const childSession = { id: 'child-1', header: { id: 'child-1', parentSession: 'root', origin: 'subagent', cwd: process.cwd() }, seq: 0 };
  sessions.set('root', rootSession);
  sessions.set('child-1', childSession);

  const rootAgent = {
    id: 'root',
    session: rootSession,
    get status() { return rootStatus; },
    steer(msg) {
      rootCalls.push(['steer', msg]);
      const seq = ++rootSession.seq;
      for (const fn of listeners.get('session/event') ?? []) fn(rootSession, { type: 'user/message', seq, data: { id: String(msg.id), source: msg.source, content: msg.content } });
    },
    followup(msg) {
      rootCalls.push(['followup', msg]);
      rootStatus = 'running';
      const seq = ++rootSession.seq;
      for (const fn of listeners.get('session/event') ?? []) fn(rootSession, { type: 'user/message', seq, data: { id: String(msg.id), source: msg.source, content: msg.content } });
    },
    cancel() { rootStatus = 'idle'; },
  };
  const childAgent = { id: 'child-1', session: childSession, get status() { return childStatus; } };

  const ctx = {
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return () => {}; },
    get(name) {
      if (name === 'llm') return { listProviders: () => [{ id: 'mock', name: 'Mock' }], resolveCallConfig: async () => ({}) };
      if (name === 'sessions') return { get: id => sessions.get(String(id)) };
      if (name === 'subagents') return { prompt: async req => { childCalls.push(req); return { messageId: 'cm-1' }; } };
      return undefined;
    },
    agents: {
      get: id => String(id) === 'root' ? rootAgent : (String(id) === 'child-1' ? childAgent : undefined),
      create: async () => ({ agent: rootAgent, dispose: async () => {} }),
    },
  };

  const server = new PaseoHarnessServer(ctx, { notify() {} });
  await server.initialize({ cwd: process.cwd(), provider: 'mock', model: 'mock-model', sessionId: 'root' });
  for (const fn of listeners.get('session/created') ?? []) fn(childSession);

  // Idle root steer -> refused before calling agent.steer()
  assert.deepEqual(await server.prompt({ sessionId: 'root', delivery: 'steer', contentBlocks: [{ type: 'text', text: 'late' }] }), { disposition: 'unavailable' });
  assert.equal(rootCalls.length, 0);

  // Followup starts root turn -> disposition: 'started'
  const started = await server.prompt({ sessionId: 'root', delivery: 'auto', contentBlocks: [{ type: 'text', text: 'go' }] });
  assert.equal(started.disposition, 'started');
  assert.equal(started.seq, 1);
  assert.equal(rootCalls.length, 1);
  assert.equal(rootCalls[0][0], 'followup');

  // Running root steer -> disposition: 'steered'
  const steered = await server.prompt({ sessionId: 'root', delivery: 'steer', contentBlocks: [{ type: 'text', text: 'mid-turn' }] });
  assert.equal(steered.disposition, 'steered');
  assert.equal(steered.seq, 2);
  assert.equal(rootCalls.length, 2);
  assert.equal(rootCalls[1][0], 'steer');

  // Idle child steer -> refused before calling subagents.prompt()
  assert.deepEqual(await server.prompt({ sessionId: 'child-1', delivery: 'steer', contentBlocks: [{ type: 'text', text: 'child-late' }] }), { disposition: 'unavailable' });
  assert.equal(childCalls.length, 0);

  // Running child steer -> forwarded with delivery: 'steer'
  childStatus = 'running';
  await server.prompt({ sessionId: 'child-1', delivery: 'steer', contentBlocks: [{ type: 'text', text: 'child-live' }] });
  assert.equal(childCalls.length, 1);
  assert.equal(childCalls[0].delivery, 'steer');

  await server.shutdown();
});
