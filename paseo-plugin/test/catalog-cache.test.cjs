// The catalog cache must follow DSH's configuration: an edit to the profile or
// the credentials reaches the next read and the next open, unchanged inputs are
// served without starting DSH, and a closed connection stops its probes and
// publishes nothing.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { createDshProvider } = require('../server/provider.ts');
const { PROVIDER_CAPABILITIES, ProviderEventSchema } = require('@getpaseo/plugin/server/provider');

// A DSH that builds its catalog from the profile patch ("<label>|<effort,...>")
// and the workspace it runs in. A `delay` file in the workspace holds the answer
// back, without being an input of the catalog.
function fixtureCli(log) {
  return `
const fs=require('node:fs'),path=require('node:path');
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const profile=process.argv[process.argv.indexOf('--profile')+1];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(!r.method)return;
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,cwd:process.cwd(),method:r.method,params:r.params})+'\\n');
 const answer=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='paseo/catalog'){
  const [label,efforts]=fs.readFileSync(path.join(process.env.DSH_HOME,'profiles',profile,'cordis.patch.yml'),'utf8').trim().split('|');
  const delay=fs.existsSync('delay')?Number(fs.readFileSync('delay','utf8')):0;
  const model={provider:'fixture',id:'model',name:label+' @ '+path.basename(process.cwd()),reasoning:{defaultEffort:'low',efforts:efforts.split(',').map(id=>({id,name:id}))}};
  return setTimeout(()=>answer({providers:[{id:'fixture',name:'Fixture'}],models:[model],defaultProvider:'fixture',defaultModel:'model'}),delay);
 }
 answer(r.method==='paseo/config/set'?{provider:'fixture',model:'model',reasoningEffort:r.params.reasoningEffort??null}:r.method==='paseo/commands'?{commands:[]}:{});
 if(r.method==='shutdown')process.exit(0);
});`;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-')));
  const home = path.join(root, 'home');
  const patch = path.join(home, 'profiles', 'paseo', 'cordis.patch.yml');
  const credentials = path.join(home, '.credentials.yaml');
  const workspace = (name) => { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, 'Alpha|low,medium');
  fs.writeFileSync(credentials, 'refs:\n  FIXTURE_KEY: one\n');
  const log = path.join(root, 'rpc.jsonl');
  const cli = path.join(root, 'fixture.cjs');
  fs.writeFileSync(cli, fixtureCli(log));

  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_BINARY: process.env.DSH_BINARY, DSH_PASEO_PROFILE: process.env.DSH_PASEO_PROFILE };
  process.env.DSH_HOME = home;
  process.env.DSH_BINARY = process.execPath;
  delete process.env.DSH_PASEO_PROFILE;
  const spawn = cp.spawn, children = [];
  t.mock.method(cp, 'spawn', (_command, args, options) => {
    const child = spawn(process.execPath, [cli, ...args], options);
    child.closed = once(child, 'close');
    children.push(child);
    return child;
  });

  const connections = [];
  async function connect() {
    const connection = await createDshProvider().connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
    const events = [];
    connection.onEvent((event) => { ProviderEventSchema.parse(event); events.push(event); });
    connections.push(connection);
    return { connection, events };
  }
  t.after(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map((child) => child.closed));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  const frames = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []);
  /** Processes that answered a catalog read: one per probe. */
  const probes = () => [...new Set(frames().filter((r) => r.method === 'paseo/catalog').map((r) => r.pid))];
  const childOf = (pid) => children.find((child) => child.pid === pid);
  return { patch, credentials, workspace, connect, frames, probes, childOf };
}

async function readCatalog(c, requestId, cwd) {
  await c.connection.send({ type: 'catalog', requestId, cwd });
  const failed = c.events.find((e) => e.type === 'request.failed' && e.requestId === requestId);
  assert(!failed, failed && failed.error.message);
  const event = c.events.find((e) => e.type === 'catalog' && e.requestId === requestId);
  assert(event, `no catalog for ${requestId}`);
  return event.catalog;
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('discovery stops its process, and cached reads do not spawn', async (t) => {
  const f = fixture(t);
  const cwd = f.workspace('ws');
  const first = await f.connect();
  const catalog = await readCatalog(first, 'c1', cwd);
  assert.equal(catalog.models[0].label, 'Alpha @ ws');
  assert.equal(f.probes().length, 1);
  await f.childOf(f.probes()[0]).closed;

  // The same connection, a second one, and a session open: all from the cache.
  await readCatalog(first, 'c2', cwd);
  const second = await f.connect();
  await readCatalog(second, 'c3', cwd);
  await second.connection.send({ type: 'session.open', requestId: 'open', sessionId: 'root', history: 'skip',
    config: { cwd, env: {}, persist: true, settings: {} } });
  assert(second.events.some((e) => e.type === 'session.ready' && e.sessionId === 'root'));
  assert.equal(f.probes().length, 1);
});

test('profile and credential edits invalidate the cache', async (t) => {
  const f = fixture(t);
  const cwd = f.workspace('ws');
  const c = await f.connect();
  const before = await readCatalog(c, 'c1', cwd);
  assert.equal(before.models[0].label, 'Alpha @ ws');

  // A new label and thinking level reach the next read on the same connection...
  fs.writeFileSync(f.patch, 'Beta|low,medium,max');
  const after = await readCatalog(c, 'c2', cwd);
  assert.equal(after.models[0].label, 'Beta @ ws');
  assert.deepEqual(after.models[0].thinkingOptions.map((option) => option.id), ['low', 'medium', 'max']);
  assert.equal(f.probes().length, 2);

  // ...and a session opened afterwards keeps the new level instead of dropping it.
  await c.connection.send({ type: 'session.open', requestId: 'open', sessionId: 'root', history: 'skip',
    config: { cwd, env: {}, persist: true, settings: {}, model: 'fixture/model', thinkingOption: 'max' } });
  const init = f.frames().find((r) => r.method === 'initialize' && r.params.sessionId === 'root');
  assert.equal(init.params.reasoningEffort, 'max');

  fs.writeFileSync(f.credentials, 'refs:\n  FIXTURE_KEY: two\n');
  await readCatalog(c, 'c3', cwd);
  assert.equal(f.probes().length, 3);
  await readCatalog(c, 'c4', cwd);
  assert.equal(f.probes().length, 3);

  // An edit saved while DSH reads may or may not be in its answer: the read
  // fails as retryable and caches nothing, and the retry sees the edit.
  fs.writeFileSync(path.join(cwd, 'delay'), '300');
  fs.writeFileSync(f.patch, 'Delta|low');
  const racing = c.connection.send({ type: 'catalog', requestId: 'c5', cwd });
  await waitFor(() => f.probes().length === 4, 5000, 'the probe to receive paseo/catalog');
  fs.writeFileSync(f.patch, 'Gamma|low');
  await racing;
  const failed = c.events.find((e) => e.requestId === 'c5');
  assert.equal(failed.type, 'request.failed');
  assert.equal(failed.error.code, 'catalog_inputs_changed');
  fs.rmSync(path.join(cwd, 'delay'));
  assert.equal((await readCatalog(c, 'c6', cwd)).models[0].label, 'Gamma @ ws');
  assert.equal(f.probes().length, 5);
});

test('close() stops an in-flight discovery without publishing a catalog', async (t) => {
  const f = fixture(t);
  const cwd = f.workspace('ws');
  fs.writeFileSync(path.join(cwd, 'delay'), '1500');
  const c = await f.connect();
  const pending = c.connection.send({ type: 'catalog', requestId: 'slow', cwd });
  await waitFor(() => f.probes().length === 1, 5000, 'the probe to receive paseo/catalog');
  const probe = f.childOf(f.probes()[0]);

  await c.connection.close();
  await pending;
  // Stopped by close(), well before the fixture would have answered.
  const exited = await Promise.race([probe.closed.then(() => true), new Promise((resolve) => setTimeout(resolve, 1000, false))]);
  assert(exited, 'the probe outlived close()');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert(!c.events.some((e) => e.type === 'catalog'));
  assert.deepEqual(c.events.filter((e) => e.requestId === 'slow').map((e) => e.type), ['request.failed']);
});

test('concurrent discovery for different workspaces completes independently', async (t) => {
  const f = fixture(t);
  const slow = f.workspace('ws-slow');
  const fast = f.workspace('ws-fast');
  fs.writeFileSync(path.join(slow, 'delay'), '400');
  const c = await f.connect();
  const [a, b] = await Promise.all([readCatalog(c, 'a', slow), readCatalog(c, 'b', fast)]);
  assert.equal(a.models[0].label, 'Alpha @ ws-slow');
  assert.equal(b.models[0].label, 'Alpha @ ws-fast');
  assert.equal(f.probes().length, 2);

  // Both stay cached: reading either workspace again starts nothing.
  const [again, fastAgain] = await Promise.all([readCatalog(c, 'a2', slow), readCatalog(c, 'b2', fast)]);
  assert.equal(again.models[0].label, 'Alpha @ ws-slow');
  assert.equal(fastAgain.models[0].label, 'Alpha @ ws-fast');
  assert.equal(f.probes().length, 2);
});
