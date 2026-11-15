const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const { test } = require('node:test');
const os = require('node:os');
const cp = require('node:child_process');
require('./register-typescript.cjs');
const { createDshProvider } = require('../server/provider.ts');
const { PROVIDER_CAPABILITIES, ProviderEventSchema } = require('@getpaseo/plugin/server/provider');

async function contract(t) {
  const { resolveDshCommand } = await import('../server/dsh-command.mjs');
  const entry = resolveDshCommand(process.env.DSH_BINARY ?? 'dsh', process.env).args[0];
  if (!entry) { t.skip('requires a local npm DSH installation'); return; }
  const dependencies = path.resolve(path.dirname(entry), '..', 'node_modules');
  if (!fs.existsSync(path.join(dependencies, '@deepseek-ai/dsh-agent'))) { t.skip('DSH native agent API is unavailable'); return; }
  const parentURL = pathToFileURL(path.join(dependencies, '_model-contract.mjs')).href;
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('file:')) {
      try { return next(specifier, { ...context, parentURL }); } catch {}
    }
    return next(specifier, context);
  } });
  t.after(() => hook.deregister());
  const { AgentModel } = await import(pathToFileURL(path.join(dependencies, '@deepseek-ai/dsh-agent/lib/index.js')).href);
  const { PaseoHarnessServer } = await import('../../dsh-bridge/lib/server.js');
  return { AgentModel, PaseoHarnessServer };
}

function fixture(api, recorded = null) {
  const events = [], resolutions = [];
  let projection = { pending: null, lastUsed: recorded };
  const initial = { provider: 'fixture', model: 'reasoning', reasoningEffort: 'low' };
  const session = { id: 'root', append(type, data) {
    events.push({ type, data });
    if (type === 'model/selection') projection = { ...projection, pending: data };
  } };
  const agent = { id: 'root', session, model: new api.AgentModel(() => projection, session, initial) };
  const bridge = Object.create(api.PaseoHarnessServer.prototype);
  Object.assign(bridge, { sessions: new Map([['root', { handle: { agent }, control: { selection: { current: initial } } }]]), pendingPresets: new Map(), configTail: Promise.resolve() });
  bridge.ctx = { agents: { get: () => agent }, get(name) {
    if (name !== 'llm') return undefined;
    return { async resolveCallConfig(selection) {
      resolutions.push({ ...selection });
      if (selection.model === 'plain' && selection.reasoningEffort !== undefined) throw new Error('plain does not support reasoning');
      if (selection.reasoningEffort === 'high') await new Promise(resolve => setTimeout(resolve, 20));
      return { ...selection };
    } };
  } };
  return { bridge, agent, events, resolutions };
}

test('live reasoning changes update the real DSH AgentModel and its durable selection event', async t => {
  const api = await contract(t); if (!api) return;
  const f = fixture(api);
  const result = await f.bridge.configSet({ sessionId: 'root', reasoningEffort: 'medium' });
  assert.equal(result.reasoningEffort, 'medium');
  assert.equal(f.agent.model.current().reasoningEffort, 'medium');
  assert.deepEqual(f.events.map(e => [e.type, e.data.reasoningEffort]), [['model/selection', 'medium']]);
  await f.bridge.configSet({ sessionId: 'root', reasoningEffort: 'medium' });
  assert.equal(f.events.length, 1, 'reapplying the same recorded selection is idempotent');
});

test('resumed selection is authoritative and clearing effort records provider default', async t => {
  const api = await contract(t); if (!api) return;
  const f = fixture(api, { provider: 'fixture', model: 'reasoning', reasoningEffort: 'high' });
  const current = await f.bridge.configSet({ sessionId: 'root' });
  assert.equal(current.reasoningEffort, 'high', 'a profile fallback must not replace the stored choice');
  assert.equal(f.events.length, 0, 'reading config must not pin a new choice');
  const cleared = await f.bridge.configSet({ sessionId: 'root', reasoningEffort: null });
  assert.equal(cleared.reasoningEffort, null);
  assert.equal(f.agent.model.current().reasoningEffort, undefined);
  assert.equal(Object.hasOwn(f.events[0].data, 'reasoningEffort'), false);
});

test('a rejected model/effort change leaves the real native selection untouched', async t => {
  const api = await contract(t); if (!api) return;
  const f = fixture(api);
  await assert.rejects(f.bridge.configSet({ sessionId: 'root', model: 'plain', reasoningEffort: 'high' }), /does not support/);
  assert.deepEqual(f.agent.model.current(), { provider: 'fixture', model: 'reasoning', reasoningEffort: 'low' });
  assert.equal(f.events.length, 0);
  await f.bridge.configSet({ sessionId: 'root', model: 'plain', reasoningEffort: null });
  assert.deepEqual(f.agent.model.current(), { provider: 'fixture', model: 'plain' });
});

test('asynchronous model validation preserves request order and recovers after rejection', async t => {
  const api = await contract(t); if (!api) return;
  const f = fixture(api);
  await Promise.all([
    f.bridge.configSet({ sessionId: 'root', reasoningEffort: 'high' }),
    f.bridge.configSet({ sessionId: 'root', reasoningEffort: 'medium' }),
  ]);
  assert.deepEqual(f.events.map(e => e.data.reasoningEffort), ['high', 'medium']);
  assert.equal(f.agent.model.current().reasoningEffort, 'medium');
  await assert.rejects(f.bridge.configSet({ sessionId: 'root', model: 'plain', reasoningEffort: 'high' }));
  await f.bridge.configSet({ sessionId: 'root', reasoningEffort: 'low' });
  assert.equal(f.agent.model.current().reasoningEffort, 'low');
});

test('rewind preserves the native live selection even when the inherited seed records an older model choice', async t => {
  const api = await contract(t); if (!api) return;
  const high={provider:'fixture',model:'reasoning',reasoningEffort:'high'};
  const low={...high,reasoningEffort:'low'};
  const f=fixture(api,high);
  const events=[{seq:0,type:'model/selection',data:low},{seq:1,type:'turn/start',data:{turn:1}},
    {seq:2,type:'user/message',data:{content:[]}},{seq:3,type:'turn/end',data:{turn:1}}];
  Object.assign(f.agent.session,{header:{cwd:process.cwd()},seq:3,snapshotEvents:()=>events});
  const get=f.bridge.ctx.get;
  f.bridge.ctx.get=name=>name==='sessions'?{get:()=>f.agent.session}:get(name);
  f.bridge.controls=new Map();f.bridge.retiredHandles=[];
  let fork,request;
  f.bridge.ctx.agents.create=async input=>{
    request=input;
    let state={pending:null,lastUsed:input.seed[0].data};
    const session={id:input.sessionId,append(type,data){if(type==='model/selection')state={...state,pending:data};}};
    fork={session,model:new api.AgentModel(()=>state,session,input.agentOptions)};
    return {agent:fork,dispose:async()=>{}};
  };
  await f.bridge.rewind({sessionId:'root',seq:2});
  assert.equal(request.agentOptions.reasoningEffort,'high');
  assert.deepEqual(fork.model.current(),high);
});

test('initializing another model does not inherit an incompatible profile reasoning default', async t => {
  const api=await contract(t);if(!api)return;
  const f=fixture(api);
  Object.assign(f.bridge,{options:{},initialized:false});
  const get=f.bridge.ctx.get;
  f.bridge.ctx.get=name=>name==='agentDefaultModel'?{currentSelection:()=>({provider:'fixture',model:'reasoning',reasoningEffort:'low'})}:get(name);
  f.bridge.hasAdapterFor=()=>true;
  f.bridge.getOrCreateSession=async()=>f.bridge.sessions.get('root');
  await f.bridge.initialize({cwd:process.cwd(),sessionId:'root',provider:'fixture',model:'plain'});
  assert.equal(f.resolutions[0].model,'plain');
  assert.equal(f.resolutions[0].reasoningEffort,undefined);
});

async function providerFixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-config-')));
  const cli = path.join(directory, 'bridge.cjs'), log = path.join(directory, 'rpc.jsonl');
  fs.writeFileSync(cli, `
const fs=require('node:fs');
let selected;
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const stored=process.env.TEST_STORED_SELECTION?JSON.parse(process.env.TEST_STORED_SELECTION):undefined;
const reasoning={defaultEffort:'low',efforts:['low','medium','high'].map(id=>({id,name:id}))};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
 if(!r.method)return;
 let result={};
 if(r.method==='paseo/catalog')result={providers:[{id:'fixture',name:'Fixture'}],models:['reasoning','other','reject','plain'].map(id=>({provider:'fixture',id,name:id,...(id==='plain'?{}:{reasoning})})),defaultProvider:'fixture',defaultModel:'reasoning',defaultReasoningEffort:'low'};
 if(r.method==='initialize')selected=stored??{provider:r.params.provider,model:r.params.model,reasoningEffort:r.params.reasoningEffort===undefined?'low':r.params.reasoningEffort};
 if(r.method==='paseo/config/set'){
  if(r.params.model==='reject')return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Native model selection rejected'}});
  const next={...selected};
  for(const field of ['provider','model','reasoningEffort'])if(r.params[field]!==undefined)next[field]=r.params[field];
  selected=next;result=selected;
 }
 if(r.method==='paseo/commands')result={commands:[]};
 send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='shutdown')process.exit(0);
});`);
  const spawn = cp.spawn;
  t.mock.method(cp, 'spawn', (_command, args, options) => spawn(process.execPath, [cli, ...args], options));
  const connection = await createDshProvider().connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [];
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  t.after(async () => {
    await connection.close();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  const open = (id, config = {}) => connection.send({ type:'session.open', requestId:'open-'+id, sessionId:id, history:'skip', config:{cwd:directory,env:{},settings:{},...config} });
  const configure = (id, requestId, changes) => connection.send({type:'session.configure',sessionId:id,requestId,changes});
  const current = id => events.filter(e=>e.type==='session.config'&&e.sessionId===id).at(-1)?.config;
  const frames = () => fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {connection,events,open,configure,current,frames};
}

test('initial thinking choice reaches initialize before the first agent and does not mutate catalog defaults', async t => {
  const f = await providerFixture(t);
  await f.open('chosen', {thinkingOption:'medium'});
  assert.equal(f.frames().find(r=>r.method==='initialize').params.reasoningEffort,'medium');
  assert.equal(f.current('chosen').thinkingOption,'medium');
  await f.connection.send({type:'session.close',requestId:'close-chosen',sessionId:'chosen'});
  await f.open('default');
  assert.equal(f.frames().filter(r=>r.method==='initialize').at(-1).params.reasoningEffort,undefined);
  assert.equal(f.current('default').thinkingOption,'low');
});

test('restored model/effort survive profile defaults while explicit reopen choices override both', async t => {
  const f = await providerFixture(t);
  const env={TEST_STORED_SELECTION:JSON.stringify({provider:'fixture',model:'other',reasoningEffort:'high'})};
  await f.open('stored',{env});
  assert.equal(f.current('stored').model,'fixture/other');
  assert.equal(f.current('stored').thinkingOption,'high');
  await f.connection.send({type:'session.close',requestId:'close-stored',sessionId:'stored'});
  await f.open('override',{env,model:'fixture/reasoning',thinkingOption:'medium'});
  assert.equal(f.current('override').model,'fixture/reasoning');
  assert.equal(f.current('override').thinkingOption,'medium');
});

test('model and effort changes are atomic and rejected choices do not replace UI state', async t => {
  const f = await providerFixture(t); await f.open('live',{thinkingOption:'medium'});
  const mark=f.frames().length;
  await f.configure('live','switch-both',{model:'fixture/other',thinkingOption:'high'});
  const mutations=f.frames().slice(mark).filter(r=>r.method==='paseo/config/set');
  assert.equal(mutations.length,1);
  assert.equal(mutations[0].params.model,'other');
  assert.equal(mutations[0].params.reasoningEffort,'high');
  const accepted=f.current('live');
  await f.configure('live','native-refusal',{model:'fixture/reject',thinkingOption:'medium'});
  assert(f.events.some(e=>e.type==='request.failed'&&e.requestId==='native-refusal'));
  await f.configure('live','read-after-failure',{});
  assert.equal(f.current('live').model,accepted.model);
  assert.equal(f.current('live').thinkingOption,accepted.thinkingOption);
});

test('a thinking option the model does not offer is dropped with a log at open and on live changes', async t => {
  const f = await providerFixture(t);
  const logs = [], write = process.stderr.write;
  t.mock.method(process.stderr, 'write', function (chunk, ...rest) {
    if (String(chunk).includes('thinking option')) { logs.push(String(chunk)); return true; }
    return write.call(this, chunk, ...rest);
  });
  const ready = id => f.events.some(e=>e.type==='session.ready'&&e.sessionId===id);
  const lastEffort = () => f.frames().filter(r=>r.method==='paseo/config/set').at(-1).params.reasoningEffort;
  // Fresh open: the host can apply a default that this model does not offer.
  await f.open('fresh',{model:'fixture/reasoning',thinkingOption:'xhigh'});
  assert(ready('fresh'));
  assert.equal(f.frames().find(r=>r.method==='initialize').params.reasoningEffort,undefined);
  assert.equal(lastEffort(),null);
  assert.equal(f.current('fresh').thinkingOption,undefined);
  // Reopen after a profile edit: the saved choice and the durable selection are stale.
  const env={TEST_STORED_SELECTION:JSON.stringify({provider:'fixture',model:'reasoning',reasoningEffort:'xhigh'})};
  await f.open('saved',{env,model:'fixture/reasoning',thinkingOption:'xhigh'});
  assert(ready('saved'));
  assert.equal(lastEffort(),null);
  assert.equal(f.current('saved').thinkingOption,undefined);
  await f.open('durable',{env,model:'fixture/reasoning'});
  assert(ready('durable'));
  assert.equal(lastEffort(),null);
  assert.equal(f.current('durable').thinkingOption,undefined);
  assert.equal(logs.length,3);
  assert(logs.every(line=>line.includes('ignoring unsupported thinking option "xhigh" for fixture/reasoning')));
  // A live choice the model does not offer follows the same rule, as on main.
  await f.configure('saved','live-high',{thinkingOption:'high'});
  assert.equal(f.current('saved').thinkingOption,'high');
  await f.configure('saved','live-unsupported',{thinkingOption:'xhigh'});
  assert(f.events.some(e=>e.type==='request.completed'&&e.requestId==='live-unsupported'));
  assert(!f.events.some(e=>e.type==='request.failed'&&e.requestId==='live-unsupported'));
  assert.equal(lastEffort(),null);
  assert.equal(f.current('saved').thinkingOption,undefined);
  assert.equal(logs.length,4);
});

test('clearing effort and switching to a non-reasoning model clear the actual advertised choice', async t => {
  const f = await providerFixture(t); await f.open('clear',{thinkingOption:'high'});
  await f.configure('clear','provider-default',{thinkingOption:null});
  assert.equal(f.current('clear').thinkingOption,undefined);
  assert.equal(f.frames().filter(r=>r.method==='paseo/config/set').at(-1).params.reasoningEffort,null);
  await f.configure('clear','plain',{model:'fixture/plain'});
  assert.equal(f.current('clear').model,'fixture/plain');
  assert.deepEqual(f.current('clear').thinkingOptions,[]);
  assert.equal(f.current('clear').thinkingOption,undefined);
});
