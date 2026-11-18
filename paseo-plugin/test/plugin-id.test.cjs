// The stream-stats row is a plugin timeline item, and Paseo accepts a plugin's
// items only under that plugin's own ID: one under another ID fails the whole
// provider connection. A plugin that reuses this provider under its own ID
// passes it to createDshProvider, and the row must carry it.
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

// A bridge that answers each prompt with one streamed model step: the frames
// that time it, then the committed message that ends it.
async function fixture(t, options) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-id-')));
  const cli = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(cli, `
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const stream=(frame)=>send({jsonrpc:'2.0',method:'assistant.stream',params:{sessionId:'root',frame}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(!r.method)return;
 let result={};
 if(r.method==='paseo/config/set')result={provider:'fixture',model:'fixture',reasoningEffort:null};
 if(r.method==='paseo/catalog')result={providers:[{id:'fixture',name:'Fixture'}],models:[{provider:'fixture',id:'fixture',name:'Fixture'}],defaultProvider:'fixture',defaultModel:'fixture'};
 if(r.method==='session/prompt'){
  const now=Date.now();
  stream({type:'start',attemptId:'a1',revision:0,turn:1,step:1});
  stream({type:'chunk',attemptId:'a1',revision:1,time:now,kind:'text',text:'Hello'});
  stream({type:'chunk',attemptId:'a1',revision:2,time:now+100,kind:'text',text:' there'});
  stream({type:'end',attemptId:'a1',revision:3,outcome:{kind:'committed'}});
  send({jsonrpc:'2.0',method:'session.event',params:{sessionId:'root',event:{type:'assistant/message',data:{turn:1,step:1,usage:{outputTokens:4},message:{content:[{type:'text',text:'Hello there'}]}}}}});
 }
 send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='shutdown')process.exit(0);
});`);
  const spawn = childProcess.spawn;
  childProcess.spawn = (_command, args, spawnOptions) => spawn(process.execPath, [cli, ...args], spawnOptions);
  t.after(() => { childProcess.spawn = spawn; });
  const connection = await createDshProvider(options).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [];
  connection.onEvent((event) => { ProviderEventSchema.parse(event); events.push(event); });
  t.after(async () => {
    await connection.close();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 'root', history: 'skip',
    config: { cwd: dir, env: {}, persist: true, settings: {} } });
  async function statsRow() {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const hit = events.find((e) => e.type === 'timeline.item' && e.item.type === 'plugin' && e.item.kind === 'dsh-stream-stats');
      if (hit) return hit.item;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('no stream-stats row');
  }
  return { connection, events, statsRow };
}

async function promptOnce(f) {
  await f.connection.send({ type: 'session.prompt', sessionId: 'root',
    prompt: { clientMessageId: 'msg-1', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hi' }] } } });
  return f.statsRow();
}

test('a provider created with a plugin ID tags the stream-stats row with it', async (t) => {
  const f = await fixture(t, { pluginId: 'dsh-wrapper' });
  const row = await promptOnce(f);
  assert.equal(row.pluginId, 'dsh-wrapper');
  assert.equal(row.data.outputTokens, 4);
  assert(!f.events.some((e) => e.type === 'request.failed'));
});

test('without a plugin ID the row keeps the default dsh-paseo owner', async (t) => {
  const f = await fixture(t);
  const row = await promptOnce(f);
  assert.equal(row.pluginId, 'dsh-paseo');
});
