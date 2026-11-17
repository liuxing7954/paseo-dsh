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

// One batch covering each way Paseo's question card can answer. The answer
// strings below are what its `buildQuestionFormAnswers` submits: a single-select
// question returns the chosen label, or the typed text in its place; a
// multi-select one joins the chosen labels, then any typed text, with ", ".
const QUESTIONS = [
  { id: 'chosen', header: 'Chosen', question: 'Keep the file?', options: [{ label: 'Keep it' }, { label: 'Drop it' }] },
  { id: 'typed', header: 'Typed', question: 'Keep the file?', options: [{ label: 'Keep it' }, { label: 'Drop it' }] },
  { id: 'labels', header: 'Labels', question: 'Which colours?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Red, warm' }, { label: 'Blue' }] },
  { id: 'mixed', header: 'Mixed', question: 'Which colours?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Red, warm' }, { label: 'Blue' }] },
  { id: 'other', header: 'Other', question: 'Which colours?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
  { id: 'free', header: 'Free', question: 'Anything else?', options: [] },
  { id: 'skipped', header: 'Skipped', question: 'Optional?', options: [{ label: 'Yes' }] },
];

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-answers-')));
  const log = path.join(dir, 'rpc.jsonl');
  const cli = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(cli, `
const fs=require('node:fs');
const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const root='native-root';
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(process.env.TEST_RPC_LOG)fs.appendFileSync(process.env.TEST_RPC_LOG,JSON.stringify(r)+'\\n');
 if(!r.method)return;
 let result={};
 if(r.method==='paseo/config/set')result={provider:'fixture',model:'fixture',reasoningEffort:null};
 if(r.method==='paseo/catalog')result={providers:[{id:'fixture',name:'Fixture'}],models:[{provider:'fixture',id:'fixture',name:'Fixture'}],defaultProvider:'fixture',defaultModel:'fixture'};
 send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='shutdown')return process.exit(0);
 if(r.method==='session/prompt'){
  const text=r.params.contentBlocks?.[0]?.text;
  send({jsonrpc:'2.0',id:'question-'+text,method:'paseo/question',params:{sessionId:root,requestId:'q-'+text,callId:'ask-'+text,timed:false,questions:${JSON.stringify(QUESTIONS)}}});
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
    config: { cwd: dir, env: { TEST_RPC_LOG: log }, persist: true, settings: {} } });
  async function until(predicate) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) { const hit = events.find(predicate); if (hit) return hit; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('missing event');
  }
  const frames = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  /** Ask the batch, answer the card with `response`, and return what DSH receives. */
  async function answer(name, response) {
    await connection.send({ type: 'session.prompt', sessionId: 'paseo-root',
      prompt: { clientMessageId: 'msg-' + name, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: name }] } } });
    const card = await until(e => e.type === 'session.permission' && e.request.kind === 'question' && e.request.id === 'ask-' + name);
    await connection.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: card.request.id, response });
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const reply = frames().find(r => r.id === 'question-' + name && r.result);
      if (reply) return Object.fromEntries(reply.result.answers.map(({ id, ...rest }) => [id, rest]));
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('no answer reached DSH');
  }
  return { answer, invalid };
}

test('typed text reaches DSH as custom and labels are matched, not split on commas', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const answers = await f.answer('form', { behavior: 'allow', updatedInput: { answers: {
    Chosen: 'Keep it',
    Typed: 'Neither, ask me later',
    Labels: 'Red, warm, Blue',
    Mixed: 'Blue, Red, and also green',
    Other: 'none of these, really',
    Free: 'ship it',
  } } });
  assert.deepEqual(answers, {
    chosen: { selected: ['Keep it'] },
    typed: { selected: [], custom: 'Neither, ask me later' },
    labels: { selected: ['Red, warm', 'Blue'] },
    mixed: { selected: ['Blue', 'Red'], custom: 'and also green' },
    other: { selected: [], custom: 'none of these, really' },
    free: { selected: [], custom: 'ship it' },
    skipped: { selected: [] },
  });
  assert.deepEqual(f.invalid, []);
});

test('a denial still answers every question with the denial note and no labels', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const answers = await f.answer('deny', { behavior: 'deny', message: 'Not now' });
  for (const question of QUESTIONS) assert.deepEqual(answers[question.id], { selected: [], custom: 'Not now' }, question.id);
});
