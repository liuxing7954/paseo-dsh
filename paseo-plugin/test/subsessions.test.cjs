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

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-children-')));
  const log = path.join(dir, 'rpc.jsonl');
  const cli = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(cli, `
const fs=require('node:fs');
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
const root='native-root';
const meta=(id,parent=root)=>({sessionId:id,parentSessionId:parent,origin:'subagent',cwd:process.cwd()});
const event=(id,type,data,parent)=>notify('session.event',{...(id===root?{sessionId:root}:meta(id,parent)),event:{type,data}});
const stream=(id,type,extra)=>notify('assistant.stream',{...meta(id),frame:{type,attemptId:id,revision:1,...extra}});
const running=new Set();let seq=0;
function children(){
 event(root,'tool/call',{callId:'program',name:'run_code',arguments:'{}'});
 for(const [id,call,name,parent] of [['a','program:ptc:1','subagent',root],['b','program:ptc:2','subagent_fork',root],['nested','inner:ptc:1','custom_delegate','a']]){
  running.add(id);
  notify('session.child',{...meta(id,parent),toolCallId:call,toolName:name});
  event(id,'subagent/descriptor',{version:1,mode:'continuable',label:'Child '+id,provider:'spawn'},parent);
  notify('session.status',{...meta(id,parent),status:'running'});
  event(id,'turn/start',{turn:1},parent);
 }
 stream('a','start',{turn:1,step:1}); stream('a','chunk',{kind:'text',text:'live child'});
 stream('b','start',{turn:1,step:1}); stream('b','chunk',{kind:'reasoning',text:'live thought'});
 event('nested','tool/call',{callId:'nested-program',name:'run_code',arguments:'{}'},'a');
 event('nested','assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:'nested thought'}]}},'a');
 setTimeout(()=>{
  running.delete('a');
  event('a','assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'authoritative child'}]}});
  event('a','turn/end',{turn:1,reason:{kind:'completed'}});
  notify('session.status',{...meta('a'),status:'idle'});
 },180);
}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(process.env.TEST_RPC_LOG)fs.appendFileSync(process.env.TEST_RPC_LOG,JSON.stringify(r)+'\\n');
 if(!r.method)return;
 let result={};
 if(r.method==='paseo/config/set')result={provider:'fixture',model:'fixture',reasoningEffort:null};
 if(r.method==='paseo/catalog')result={providers:[{id:'fixture',name:'Fixture'}],models:[{provider:'fixture',id:'fixture',name:'Fixture'}],defaultProvider:'fixture',defaultModel:'fixture'};
 if(r.method==='session/prompt'){
  const sid=r.params.sessionId;
  const text=r.params.contentBlocks?.[0]?.text??'';
  if(sid===root&&text.includes('RACE_IDLE_BEFORE_STEER')){
   running.delete(root);
   event(root,'turn/end',{turn:1,reason:{kind:'completed'}});
   notify('session.status',{sessionId:root,status:'idle'});
  }
  if(r.params.delivery==='steer'&&!running.has(sid)){
   return send({jsonrpc:'2.0',id:r.id,result:{disposition:'unavailable'}});
  }
  const disposition=r.params.delivery==='steer'?'steered':'started';
  if(sid===root&&!running.has(root)){
   running.add(root);
   notify('session.status',{sessionId:root,status:'running'});
   event(root,'turn/start',{turn:1});
  }
  const msgSeq=++seq;
  if(sid===root)notify('session.event',{sessionId:root,event:{type:'user/message',seq:msgSeq,data:{id:'m-'+msgSeq,source:{kind:'user'},content:r.params.contentBlocks}}});
  result={disposition,messageId:'m-'+msgSeq,seq:msgSeq};
 }
 send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='shutdown')return process.exit(0);
 if(r.method==='session/prompt'&&r.params.sessionId===root){
  const text=r.params.contentBlocks?.[0]?.text;
  if(text==='children')children();
  if(text==='start-live'){stream(root,'start',{turn:1,step:1});stream(root,'chunk',{kind:'text',text:'Before '});}
  if(text==='append-live')stream(root,'chunk',{kind:'text',text:'After'});
  if(text==='finish-turn'){
   running.delete(root);
   event(root,'turn/end',{turn:1,reason:{kind:'completed'}});
   notify('session.status',{sessionId:root,status:'idle'});
  }
  if(text==='questions')for(const id of ['a','b'])send({jsonrpc:'2.0',id:'question-'+id,method:'paseo/question',params:{...meta(id),requestId:'q-'+id,callId:'same-call',questions:[{id:'target',header:'Target',question:'Choose',options:[{label:'A'},{label:'B'}]}]}});
  if(text==='cancel-question')notify('paseo/request/cancel',{requestId:'q-a'});
  if(text==='approval')send({jsonrpc:'2.0',id:'approval',method:'paseo/approval',params:{sessionId:root,requestId:'approval',callId:'shell',toolName:'pwsh',reason:'Fixture approval'}});
 }
 if(r.method==='session/cancel'){
  running.delete(r.params.sessionId);
  event(r.params.sessionId,'turn/end',{turn:1,reason:{kind:'aborted'}});
  notify('session.status',r.params.sessionId===root?{sessionId:root,status:'idle'}:{...meta(r.params.sessionId),status:'idle'});
 }
});`);
  // Exercise real stdio and provider framing with a deterministic bridge.
  // Resolve the fixture here so protocol tests do not depend on the host's DSH
  // installation or Windows npm-shim support (covered by the launcher tests).
  const spawn = childProcess.spawn;
  childProcess.spawn = (_command, args, options) => spawn(process.execPath, [cli, ...args], options);
  t.after(() => { childProcess.spawn = spawn; });
  const connection = await createDshProvider().connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [], invalid = [];
  connection.onEvent(e => { const result = ProviderEventSchema.safeParse(e); if (!result.success) invalid.push(result.error.message); events.push(e); });
  const send = input => connection.send(input);
  t.after(async () => { await connection.close();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  await send({ type: 'session.open', requestId: 'open', sessionId: 'paseo-root', history: 'skip',
    persistence: { version: 1, data: { sessionId: 'native-root' } },
    config: { cwd: dir, env: { TEST_RPC_LOG: log }, persist: true, settings: {} } });
  async function until(predicate) { const deadline = performance.now() + 3000; while (performance.now() < deadline) { const hit = events.find(predicate); if (hit) return hit; await new Promise(r => setTimeout(r, 10)); } throw new Error('missing event'); }
  const prompt = (text, sessionId = 'paseo-root') => send({ type: 'session.prompt', sessionId,
    prompt: { clientMessageId: 'msg-' + text, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } } });
  const frames = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  return { events, invalid, send, prompt, until, frames, connection };
}

test('provider associates concurrent PTC/fork/nested children and streams before snapshots', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const init = f.frames().find(r => r.method === 'initialize').params;
  assert.equal(init.sessionId, 'native-root');
  await f.prompt('children');
  await f.until(e => e.sessionId === 'a' && e.item?.text === 'live child');
  await f.until(e => e.sessionId === 'b' && (e.item?.text ?? e.item?.data?.text) === 'live thought');
  assert(!f.events.some(e => e.item?.text === 'authoritative child'));
  const children = f.events.filter(e => e.type === 'session.opened' && e.parentSessionId);
  assert.deepEqual(children.map(e => [e.sessionId, e.parentSessionId, e.toolCallId]),
    [['a', 'paseo-root', 'program:ptc:1'], ['b', 'paseo-root', 'program:ptc:2'], ['nested', 'a', 'inner:ptc:1']]);
  assert(children.every(e => !e.capabilities.includes('session.configure')));
  assert(f.events.filter(e => e.type === 'timeline.item' && e.sessionId !== 'paseo-root').every(e => e.item.type !== 'plugin'),
    'native child routing must not introduce the separate custom display implementation');
  assert(f.events.some(e => e.sessionId === 'paseo-root' && e.item?.callId === 'program:ptc:2' && e.item.detail.type === 'sub_agent'));
  await f.until(e => e.sessionId === 'a' && e.item?.text === 'authoritative child');
  assert.equal(f.events.find(e => e.sessionId === 'a' && e.item?.text === 'live child').item.id,
    f.events.find(e => e.sessionId === 'a' && e.item?.text === 'authoritative child').item.id,
    'the live child stream and its durable snapshot must share one timeline identity');
  await f.until(e => e.sessionId === 'a' && e.type === 'session.turn' && e.state === 'completed');
  assert.equal(f.events.filter(e => e.sessionId === 'a' && e.type === 'session.turn' && e.state === 'completed').length, 1);
  assert.deepEqual(f.invalid, []);
});

test('child prompts, interrupt and close target only the native child; the parent process continues', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.prompt('children'); await f.until(e => e.sessionId === 'nested' && e.type === 'session.opened');
  await f.prompt('followup', 'a');
  await f.send({ type: 'session.interrupt', requestId: 'interrupt', sessionId: 'b' });
  await f.until(e => e.sessionId === 'b' && e.type === 'session.turn' && e.state === 'canceled');
  await f.send({ type: 'session.configure', requestId: 'configure-child', sessionId: 'a', changes: { mode: 'plan' } });
  assert(f.events.some(e => e.requestId === 'configure-child' && e.type === 'request.failed'));
  await f.send({ type: 'session.close', requestId: 'close-child', sessionId: 'a' });
  assert(f.events.some(e => e.sessionId === 'nested' && e.type === 'session.closed'));
  await f.prompt('still-alive');
  const frames = f.frames();
  assert(frames.some(f => f.method === 'session/prompt' && f.params.sessionId === 'a'));
  assert(frames.some(f => f.method === 'session/cancel' && f.params.sessionId === 'b'));
  assert(frames.some(f => f.method === 'session/close' && f.params.sessionId === 'a'));
  assert(!frames.some(f => f.method === 'shutdown'));
  assert(!f.events.some(e => e.type === 'session.runtime_failed'));
  assert.deepEqual(f.invalid, []);
});

test('simultaneous child questions are promoted without collisions; cancellation and root approvals settle correctly', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.prompt('children'); await f.until(e => e.sessionId === 'b' && e.type === 'session.opened');
  await f.prompt('questions');
  const a = await f.until(e => e.type === 'session.permission' && e.request.id === 'a:same-call');
  const b = await f.until(e => e.type === 'session.permission' && e.request.id === 'b:same-call');
  assert.equal(a.sessionId, 'paseo-root'); assert.equal(b.sessionId, 'paseo-root');
  await f.prompt('cancel-question');
  await f.until(e => e.type === 'session.permission_resolved' && e.permissionId === a.request.id);
  await f.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: b.request.id,
    response: { behavior: 'allow', updatedInput: { answers: { Target: 'B' } } } });
  await f.prompt('approval');
  const approval = await f.until(e => e.type === 'session.permission' && e.request.kind === 'tool');
  await f.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: approval.request.id, response: { behavior: 'allow' } });
  await new Promise(r => setTimeout(r, 30));
  const frames = f.frames();
  assert.deepEqual(frames.find(f => f.id === 'question-b' && f.result)?.result.answers[0].selected, ['B']);
  assert.deepEqual(frames.find(f => f.id === 'approval' && f.result)?.result, { behavior: 'allow' });
  assert.deepEqual(f.invalid, []);
});

test('a denial that asks to interrupt cancels only the turn that asked', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.prompt('children'); await f.until(e => e.sessionId === 'b' && e.type === 'session.opened');
  const cancels = () => f.frames().filter(r => r.method === 'session/cancel').map(r => r.params.sessionId);
  const waitFor = async check => {
    const deadline = performance.now() + 3000;
    while (!check()) { if (performance.now() > deadline) throw new Error('condition not met'); await new Promise(r => setTimeout(r, 10)); }
  };
  await f.prompt('questions');
  const a = await f.until(e => e.type === 'session.permission' && e.request.id === 'a:same-call');
  const b = await f.until(e => e.type === 'session.permission' && e.request.id === 'b:same-call');
  // A plain denial only answers the card.
  await f.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: b.request.id, response: { behavior: 'deny' } });
  // Deny-and-stop on a card promoted from a child cancels that child alone.
  await f.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: a.request.id,
    response: { behavior: 'deny', interrupt: true } });
  await waitFor(() => cancels().length > 0);
  assert.deepEqual(cancels(), ['a']);
  // On a root card it cancels the root turn.
  await f.prompt('approval');
  const approval = await f.until(e => e.type === 'session.permission' && e.request.kind === 'tool');
  await f.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: approval.request.id,
    response: { behavior: 'deny', interrupt: true } });
  await waitFor(() => cancels().length > 1);
  assert.deepEqual(cancels(), ['a', 'native-root']);
  await f.until(e => e.type === 'session.turn' && e.sessionId === 'paseo-root' && e.state !== 'started');
  assert.deepEqual(f.frames().find(r => r.id === 'approval' && r.result)?.result, { behavior: 'deny' });
  for (const card of [a, b, approval]) {
    assert(f.events.some(e => e.type === 'session.permission_resolved' && e.permissionId === card.request.id));
  }
  assert.deepEqual(f.invalid, []);
});

test('root steering acknowledges the active turn without canceling or duplicating subagent messages, and preserves distinct messages with identical text', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const sendPrompt = async (clientMessageId, text, delivery = 'auto', sessionId = 'paseo-root') => {
    await f.send({
      type: 'session.prompt',
      sessionId,
      prompt: { clientMessageId, delivery, input: { type: 'message', content: [{ type: 'text', text }] } },
    });
    return (await f.until(e => e.type === 'session.prompt_result' && e.clientMessageId === clientMessageId)).result;
  };
  const envelope = (id, body, sender = 'child-1') =>
    `<paseo-system version="1" id="${id}" kind="agent-notification" event="finished" sender-agent-id="${sender}" sender-title="Worker">\n${body}\n</paseo-system>`;

  // Idle steer before any turn is active refuses without calling session/prompt on the bridge.
  const idleSteer = await sendPrompt('idle-steer', envelope('msg-idle', 'early notice'), 'steer');
  assert.deepEqual(idleSteer, { type: 'completed' });
  assert.equal(f.frames().filter(r => r.method === 'session/prompt').length, 0);
  assert(!f.events.some(e => e.type === 'timeline.item' && e.item.clientMessageId === 'idle-steer'));

  // Start an active foreground turn.
  const started = await sendPrompt('turn-1', 'coordinate subagents', 'auto');
  assert.equal(started.type, 'turn');
  const activeTurnId = started.turnId;

  // Two distinct subagent envelopes with identical body text steer into the active turn.
  const body = 'Shared subagent conclusion body';
  const steer1 = await sendPrompt('steer-1', envelope('env-1', body, 'child-1'), 'steer');
  const steer2 = await sendPrompt('steer-2', envelope('env-2', body, 'child-2'), 'steer');
  assert.deepEqual(steer1, { type: 'steer', turnId: activeTurnId });
  assert.deepEqual(steer2, { type: 'steer', turnId: activeTurnId });

  // Neither steer triggered a cancel/replace; each message was sent to the bridge once and emitted once.
  const promptFrames = f.frames().filter(r => r.method === 'session/prompt');
  assert.equal(promptFrames.length, 3);
  assert.deepEqual(promptFrames.map(r => r.params.delivery), ['auto', 'steer', 'steer']);
  assert.equal(f.frames().filter(r => r.method === 'session/cancel').length, 0);

  const steerRows1 = f.events.filter(e => e.type === 'timeline.item' && e.item.clientMessageId === 'steer-1');
  const steerRows2 = f.events.filter(e => e.type === 'timeline.item' && e.item.clientMessageId === 'steer-2');
  assert.equal(steerRows1.length, 1);
  assert.equal(steerRows2.length, 1);
  assert.notEqual(steerRows1[0].item.text, steerRows2[0].item.text);
  assert(steerRows1[0].item.revertToken?.seq > 0);
  assert(steerRows2[0].item.revertToken?.seq > 0);
  assert.deepEqual(f.invalid, []);
});

test('turn-end race during steer admission returns unavailable without enqueueing or emitting a duplicate row before host fallback', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const sendPrompt = async (clientMessageId, text, delivery = 'auto', sessionId = 'paseo-root') => {
    await f.send({
      type: 'session.prompt',
      sessionId,
      prompt: { clientMessageId, delivery, input: { type: 'message', content: [{ type: 'text', text }] } },
    });
    return (await f.until(e => e.type === 'session.prompt_result' && e.clientMessageId === clientMessageId)).result;
  };

  const started = await sendPrompt('turn-1', 'start turn', 'auto');
  assert.equal(started.type, 'turn');

  // Bridge finishes the active turn right before admitting the steer request.
  const notice = '<paseo-system version="1" id="env-race" kind="agent-notification" event="finished" sender-agent-id="child-race">\nRACE_IDLE_BEFORE_STEER\n</paseo-system>';
  const raced = await sendPrompt('steer-race', notice, 'steer');
  assert.deepEqual(raced, { type: 'completed' });
  assert(!f.events.some(e => e.type === 'timeline.item' && e.item.clientMessageId === 'steer-race'));

  // Host fallback sends the message once as an ordinary new turn; only one timeline row exists.
  const fallback = await sendPrompt('fallback-turn', notice, 'auto');
  assert.equal(fallback.type, 'turn');
  assert.notEqual(fallback.turnId, started.turnId);
  const noticeRows = f.events.filter(e => e.type === 'timeline.item' && e.item.type === 'user_message' && e.item.text === notice);
  assert.equal(noticeRows.length, 1);
  assert.equal(noticeRows[0].item.clientMessageId, 'fallback-turn');

  // Child session steering also returns active child turnId when running and refuses once idle.
  await sendPrompt('spawn-children', 'children', 'auto');
  await f.until(e => e.sessionId === 'b' && e.type === 'session.turn' && e.state === 'started');
  const childTurnEvent = f.events.find(e => e.sessionId === 'b' && e.type === 'session.turn' && e.state === 'started');
  const childSteer = await sendPrompt('child-steer-ok', 'steer running child', 'steer', 'b');
  assert.deepEqual(childSteer, { type: 'steer', turnId: childTurnEvent.turnId });

  await f.until(e => e.sessionId === 'a' && e.type === 'session.turn' && e.state === 'completed');
  const idleChildSteer = await sendPrompt('child-steer-idle', 'steer idle child', 'steer', 'a');
  assert.deepEqual(idleChildSteer, { type: 'completed' });
  assert(!f.events.some(e => e.sessionId === 'a' && e.type === 'timeline.item' && e.item.clientMessageId === 'child-steer-idle'));
  assert.deepEqual(f.invalid, []);
});

async function sendSteer(f, clientMessageId, text, options = {}) {
  await f.send({ type: 'session.prompt', sessionId: options.sessionId ?? 'paseo-root', prompt: {
    clientMessageId, delivery: options.delivery ?? 'steer',
    ...(options.clearPendingPermissions === undefined ? {} : { clearPendingPermissions: options.clearPendingPermissions }),
    input: { type: 'message', content: [{ type: 'text', text }] },
  } });
  return (await f.until(e => e.type === 'session.prompt_result' && e.clientMessageId === clientMessageId)).result;
}

test('accepted steering preserves the current assistant stream attempt', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = await sendSteer(f, 'live-start', 'start-live', { delivery: 'auto' });
  await f.until(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'Before ');
  const steered = await sendSteer(f, 'live-steer', 'append-live');
  assert.deepEqual(steered, { type: 'steer', turnId: first.turnId });
  await f.until(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'Before After');
  assert.equal(f.frames().filter(frame => frame.method === 'session/cancel').length, 0);
  assert.deepEqual(f.invalid, []);
});

test('accepted steering clears permissions only when requested and only for its native owner', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.prompt('children');
  await f.until(e => e.sessionId === 'b' && e.type === 'session.opened');
  // Mock requests test owner routing; they do not bypass DSH's delegated-question policy.
  await f.prompt('questions');
  const questionA = await f.until(e => e.type === 'session.permission' && e.request.id.startsWith('a:'));
  const questionB = await f.until(e => e.type === 'session.permission' && e.request.id.startsWith('b:'));
  await f.prompt('approval');
  const approval = await f.until(e => e.type === 'session.permission' && e.request.kind === 'tool');
  const resolved = id => f.events.some(e => e.type === 'session.permission_resolved' && e.permissionId === id);

  assert.equal((await sendSteer(f, 'keep-approval', 'intermediate report')).type, 'steer');
  assert(!resolved(approval.request.id), 'ordinary steering must preserve a pending approval');

  const notice = '<paseo-system version="1" kind="agent-notification" source-agent-id="worker" message-id="finished" event="finished">\nWorker finished\n</paseo-system>';
  assert.equal((await sendSteer(f, 'clear-root', notice, { clearPendingPermissions: true })).type, 'steer');
  assert(resolved(approval.request.id));
  assert(!resolved(questionA.request.id));
  assert(!resolved(questionB.request.id));
  await f.until(() => f.frames().some(frame => frame.id === 'approval' && frame.result));
  assert.deepEqual(f.frames().find(frame => frame.id === 'approval' && frame.result).result, { behavior: 'deny' });

  assert.equal((await sendSteer(f, 'clear-child-b', 'continue child', { sessionId: 'b', clearPendingPermissions: true })).type, 'steer');
  assert(resolved(questionB.request.id));
  assert(!resolved(questionA.request.id), 'a sibling question must remain open');
  assert.deepEqual(f.invalid, []);
});

test('a raced steer refusal does not dismiss a pending approval', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.prompt('approval');
  const approval = await f.until(e => e.type === 'session.permission' && e.request.kind === 'tool');
  const result = await sendSteer(f, 'refused-with-approval', 'RACE_IDLE_BEFORE_STEER', { clearPendingPermissions: true });
  assert.deepEqual(result, { type: 'completed' });
  assert(!f.events.some(e => e.type === 'session.permission_resolved' && e.permissionId === approval.request.id));
  assert(!f.events.some(e => e.type === 'timeline.item' && e.item.clientMessageId === 'refused-with-approval'));
  assert.deepEqual(f.invalid, []);
});

test('successive root turns keep distinct IDs within a millisecond and after clock rollback', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const realNow = Date.now;
  let now = realNow();
  try {
    Date.now = () => now;
    const first = await sendSteer(f, 'id-first', 'first turn', { delivery: 'auto' });
    await sendSteer(f, 'id-finish-first', 'finish-turn', { delivery: 'auto' });
    await f.until(e => e.type === 'session.turn' && e.turnId === first.turnId && e.state === 'completed');
    const second = await sendSteer(f, 'id-second', 'second turn', { delivery: 'auto' });
    await sendSteer(f, 'id-finish-second', 'finish-turn', { delivery: 'auto' });
    await f.until(e => e.type === 'session.turn' && e.turnId === second.turnId && e.state === 'completed');
    now -= 1000;
    const third = await sendSteer(f, 'id-third', 'third turn', { delivery: 'auto' });
    assert.equal(new Set([first.turnId, second.turnId, third.turnId]).size, 3);
    assert.deepEqual(f.invalid, []);
  } finally {
    Date.now = realNow;
  }
});
