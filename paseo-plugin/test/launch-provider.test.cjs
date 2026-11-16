require('./register-typescript.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {once}=require('node:events');
const {test}=require('node:test');
const {createDshProvider}=require('../server/provider.ts');
const {PROVIDER_CAPABILITIES,ProviderEventSchema}=require('@getpaseo/plugin/server/provider');

async function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-launch-')));
  const cli=path.join(dir,'fixture.cjs'),log=path.join(dir,'rpc.jsonl');
  fs.writeFileSync(cli,`
const fs=require('node:fs');
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
let selection={provider:'fixture',model:'model',reasoningEffort:'low'};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(!r.method)return;
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,identity:process.env.PASEO_AGENT_ID,...r})+'\\n');
 if(r.method==='initialize'&&r.params.mcpServers?.broken)return send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'MCP fixture startup failed'}});
 if(r.method==='initialize')selection={...selection,...r.params};
 if(r.method==='paseo/config/set')selection={...selection,...r.params};
 const result=r.method==='paseo/catalog'?{providers:[{id:'fixture',name:'Fixture'}],models:[{provider:'fixture',id:'model',name:'Fixture',reasoning:{defaultEffort:'low',efforts:['low','medium','high'].map(id=>({id,name:id}))}}],defaultProvider:'fixture',defaultModel:'model',defaultReasoningEffort:'low'}
 :r.method==='paseo/config/set'?selection:r.method==='paseo/commands'?{commands:[]}:{};
 send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='shutdown')process.exit(0);
});`);
  const previous=process.env.DSH_BINARY;process.env.DSH_BINARY=process.execPath;
  const spawn=cp.spawn,children=[];
  t.mock.method(cp,'spawn',(_command,args,options)=>{const child=spawn(process.execPath,[cli,...args],options);child.closed=once(child,'close');children.push(child);return child;});
  const connection=await createDshProvider().connect({versions:[1],capabilities:PROVIDER_CAPABILITIES});
  const events=[];connection.onEvent(event=>{ProviderEventSchema.parse(event);events.push(event);});
  t.after(async()=>{
    await connection.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
    await Promise.all(children.map(child=>child.closed));
    if(previous===undefined)delete process.env.DSH_BINARY;else process.env.DSH_BINARY=previous;
    const relative=path.relative(fs.realpathSync(os.tmpdir()),dir);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:20});
  });
  const frames=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  return {dir,connection,events,children,frames};
}

test('concurrent provider opens forward exact independent launch contexts and initial thinking choices',async t=>{
  const f=await fixture(t);
  const configs=['a','b'].map((id,index)=>({cwd:f.dir,env:{PASEO_AGENT_ID:id},mcpServers:{[id]:{type:'stdio',command:'node',args:['literal argument'],env:{TOKEN:'fixture-'+id}}},systemPrompt:'Keep literal {{'+id+'}}',toolPolicy:{preapproved:[{kind:'mcp',server:id,tool:'echo'}]},model:'fixture/model',thinkingOption:index?'high':'medium',settings:{},persist:true}));
  await Promise.all(configs.map((config,index)=>f.connection.send({type:'session.open',requestId:'open-'+index,sessionId:'root-'+index,history:'skip',config})));
  const inits=f.frames().filter(r=>r.method==='initialize');assert.equal(inits.length,2);assert.notEqual(inits[0].pid,inits[1].pid);
  for(const [index,config]of configs.entries()){
    const init=inits.find(r=>r.params.sessionId==='root-'+index);assert(init);
    assert.equal(init.identity,config.env.PASEO_AGENT_ID);assert.deepEqual(init.params.mcpServers,config.mcpServers);
    assert.equal(init.params.systemPrompt,config.systemPrompt);assert.deepEqual(init.params.toolPolicy,config.toolPolicy);
    assert.equal(init.params.reasoningEffort,config.thinkingOption);
    assert(f.events.some(e=>e.type==='session.ready'&&e.sessionId==='root-'+index));
  }
  assert(!f.events.some(e=>e.type==='request.failed'));
});

test('failed launch discovery rejects open, closes the runtime and permits a later valid open',async t=>{
  const f=await fixture(t);
  await f.connection.send({type:'session.open',requestId:'broken',sessionId:'broken',history:'skip',config:{cwd:f.dir,env:{},mcpServers:{broken:{type:'http',url:'https://fixture.invalid/mcp'}},settings:{},persist:true}});
  assert(f.events.some(e=>e.type==='request.failed'&&e.requestId==='broken'&&/MCP fixture startup failed/.test(e.error.message)));
  assert(!f.events.some(e=>['session.opened','session.ready'].includes(e.type)&&e.sessionId==='broken'));
  const broken=f.frames().find(r=>r.method==='initialize'&&r.params.sessionId==='broken');
  await f.children.find(child=>child.pid===broken.pid).closed;
  assert(f.frames().some(r=>r.pid===broken.pid&&r.method==='shutdown'));
  await f.connection.send({type:'session.open',requestId:'valid',sessionId:'valid',history:'skip',config:{cwd:f.dir,env:{},mcpServers:{},settings:{},persist:true}});
  assert(f.events.some(e=>e.type==='session.ready'&&e.sessionId==='valid'));
});
