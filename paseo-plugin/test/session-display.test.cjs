require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { DshSession } = require("../server/session.ts");

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-display-session-")));
  const cli = path.join(dir, "bridge.cjs");
  fs.writeFileSync(cli, `
    const send = v => process.stdout.write(JSON.stringify(v)+'\\n');
    const notify = (method, params) => send({jsonrpc:'2.0',method,params});
    const event = (type,data) => notify('session.event',{sessionId:'display-test',event:{type,data}});
    const stream = (type,extra={}) => notify('assistant.stream',{sessionId:'display-test',frame:{type,attemptId:'a',revision:1,...extra}});
    let scenario='';
    const begin = () => {
      notify('session.status',{sessionId:'display-test',status:'running'});
      stream('start',{turn:1,step:1});
      stream('chunk',{kind:'reasoning',text:'**Checking reset**\\nCompare paths.'});
      event('tool/call',{callId:'work',name:'run_code',arguments:JSON.stringify({description:'Inspect reset handling',code:'return 42;'})});
      if(scenario==='exit') return setTimeout(()=>process.exit(9),90);
      if(scenario==='hold') return;
      setTimeout(()=>{
        if(scenario==='abandon') {
          stream('end',{outcome:{kind:'abandoned'}});
          event('turn/end',{turn:1,reason:{kind:'error',error:{message:'request failed'}}});
          notify('session.status',{sessionId:'display-test',status:'idle'});
          return;
        }
        event('assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:'**Checking reset**\\nFinal authoritative text.'}]}});
        stream('end',{outcome:{kind:'committed'}});
        event('tool/result',{message:{toolCallId:'work',content:[{type:'text',text:'42'}],isError:false}});
        event('turn/end',{turn:1,reason:{kind:'completed'}});
        notify('session.status',{sessionId:'display-test',status:'idle'});
      },90);
    };
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line);let result={};
      if(r.method==='paseo/usage') result={available:true,contextWindow:500000,usedTokens:1000};
      if(r.method==='paseo/history') result={events:[{type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'**Checking reset**\\nFinal authoritative text.'}]}}},{type:'tool/call',data:{callId:'work',name:'run_code',arguments:JSON.stringify({description:'Inspect reset handling',code:'return 42;'})}},{type:'tool/result',data:{message:{toolCallId:'work',content:[{type:'text',text:'42'}],isError:false}}}]};
      if(r.method==='session/prompt') { scenario=r.params.contentBlocks[0].text; result={messageId:'message',seq:1}; }
      send({jsonrpc:'2.0',id:r.id,result});
      if(r.method==='session/prompt') begin();
      if(r.method==='session/cancel') {
        event('tool/result',{message:{toolCallId:'work',content:[{type:'text',text:'Error: tool aborted'}],isError:true}});
        event('turn/end',{turn:1,reason:{kind:'aborted'}});
        notify('session.status',{sessionId:'display-test',status:'idle'});
      }
      if(r.method==='shutdown') process.exit(0);
    });
  `);
  // Exercise the real stdio protocol without depending on npm shim resolution
  // (the separate Windows launcher change). Only the test's executable is replaced.
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (_binary, args, options) => {
    assert.equal(options.env.DSH_BINARY, "display-protocol-fixture");
    return spawn(process.execPath, [cli, ...args], options);
  });
  const events = [];
  const session = new DshSession({ sessionId:"display-test",cwd:dir,env:{DSH_BINARY:"display-protocol-fixture"},
    route:{provider:"fixture",model:"fixture"},mode:"build",models:[],thinkingOptions:[],capabilities:[],
    emit:e=>events.push(e),log(){} });
  t.after(async()=>{await session.close();await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:20});});
  await session.open();
  const until = async predicate => {
    const deadline=Date.now()+4000;
    while(Date.now()<deadline){const found=events.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,10));}
    throw new Error('expected display event did not arrive');
  };
  return {session,events,until,prompt:text=>session.prompt({input:{type:"message",content:[{type:"text",text}]}})};
}

test("live reasoning, authoritative snapshots and replay share one display identity", {timeout:10000}, async t => {
  const f=await fixture(t);await f.prompt("normal");
  await f.until(e=>e.item?.kind==='dsh-reasoning'&&e.item.data.status==='running');
  await f.until(e=>e.type==='session.turn'&&e.state==='completed');
  const latest=new Map(f.events.filter(e=>e.item).map(e=>[e.item.id,e.item]));
  assert.equal(latest.get('reasoning:1:1').data.text,'**Checking reset**\nFinal authoritative text.');
  assert.equal(latest.get('tool:work').data.status,'completed');
  assert.equal(f.events.filter(e=>e.item?.type==='reasoning').length,0);
  await f.session.replayHistory();
  const replayed=new Map(f.events.filter(e=>e.item).map(e=>[e.item.id,e.item]));
  assert.deepEqual(replayed.get('reasoning:1:1'),latest.get('reasoning:1:1'));
  assert.deepEqual(replayed.get('tool:work'),latest.get('tool:work'));
});

test("interrupt finishes display spinners and late abort results keep canceled status", {timeout:10000}, async t => {
  const f=await fixture(t);await f.prompt("hold");
  await f.until(e=>e.item?.kind==='dsh-reasoning'&&e.item.data.status==='running');
  await f.session.interrupt();
  await f.until(e=>e.type==='session.turn'&&e.state==='completed');
  const latest=new Map(f.events.filter(e=>e.item).map(e=>[e.item.id,e.item]));
  assert.equal(latest.get('tool:work').data.status,'canceled');
  assert.equal(latest.get('reasoning:1:1').data.status,'canceled');
});

test("runtime exit leaves failed rather than running display rows", {timeout:10000}, async t => {
  const f=await fixture(t);await f.prompt("exit");
  await f.until(e=>e.type==='session.runtime_failed');
  const latest=new Map(f.events.filter(e=>e.item).map(e=>[e.item.id,e.item]));
  assert.equal(latest.get('tool:work').data.status,'failed');
  assert.equal(latest.get('reasoning:1:1').data.status,'failed');
});

test("abandoned reasoning waits for the turn outcome instead of reporting completion", {timeout:10000}, async t => {
  const f=await fixture(t);await f.prompt("abandon");
  await f.until(e=>e.type==='session.turn'&&e.state==='completed');
  const reasoning=f.events.filter(e=>e.item?.kind==='dsh-reasoning').map(e=>e.item);
  assert.ok(reasoning.length>0);
  assert.equal(reasoning.at(-1).data.status,'failed');
  assert.ok(reasoning.every(item=>item.data.status!=='completed'));
});
