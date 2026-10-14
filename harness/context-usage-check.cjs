/**
 * 上下文上报边界回归：运行编译后的真实 DshSession，只替换进程传输。
 * 用法：node harness/context-usage-check.cjs <编译输出目录>
 * 不启动模型、不读取凭据、不操作正式会话。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const compiled = path.resolve(process.argv[2]);
const processModule = require(path.join(compiled, 'server/dsh-process.js'));
const instances = [];
class FakeProcess {
  constructor(options) {
    this.options = options;
    this.snapshot = { available: true, contextWindow: 64000, usedTokens: 1024 };
    this.reads = 0;
    instances.push(this);
  }
  async start() {}
  async shutdown() {}
  async usage() {
    this.reads++;
    return this.readUsage ? this.readUsage() : this.snapshot;
  }
  async setConfig(config) {
    return { ...config, reasoningEffort: config.reasoningEffort ?? null };
  }
}
processModule.DshProcess = FakeProcess;
const { DshSession } = require(path.join(compiled, 'server/session.js'));

(async () => {
  const events = [];
  const session = new DshSession({
    sessionId: 'context-check', cwd: process.cwd(), env: {},
    route: { provider: 'fixture', model: 'alpha' }, mode: 'build',
    models: [{ id: 'fixture/alpha' }, { id: 'fixture/beta' }],
    thinkingOptions: [], emit: e => events.push(e), log() {},
  });
  await session.open();
  const transport = instances.at(-1);
  const latest = () => events.filter(e => e.type === 'session.usage').at(-1)?.usage;
  const emit = (type, data = {}) => transport.options.onEvent({ event: { type, data } });

  await session.refreshUsage();
  assert.equal(latest().contextWindowUsedTokens, 1024);
  assert.equal(latest().contextWindowMaxTokens, 64000);
  console.log('PASS 打开会话时上报已用量和容量');

  transport.options.onStatus('running');
  const readsBeforeStep = transport.reads;
  transport.snapshot = { available: true, contextWindow: 64000, usedTokens: 2500 };
  emit('assistant/message', { usage: { inputTokens: 100, cacheReadTokens: 2300, outputTokens: 100 } });
  emit('request/context');
  emit('step/end');
  await delay(130);
  assert.equal(transport.reads, readsBeforeStep + 1);
  assert.equal(latest().contextWindowUsedTokens, 2500);
  assert.equal(latest().cachedInputTokens, 2300);
  assert.equal(events.some(e => e.type === 'session.turn' && e.state === 'completed'), false);
  console.log('PASS 回合内更新且合并相邻事件，缓存计数保持独立');

  transport.snapshot = { available: true, contextWindow: 64000, usedTokens: 900 };
  emit('compaction/end');
  await delay(0);
  assert.equal(latest().contextWindowUsedTokens, 900);
  assert.equal(latest().inputTokens, 100);
  console.log('PASS 压缩后的下降值传到界面且保留用量统计');

  transport.snapshot = { available: true, usedTokens: 900 };
  await session.refreshUsage();
  assert.equal(Object.hasOwn(latest(), 'contextWindowMaxTokens'), false);
  transport.snapshot = { available: false };
  await session.refreshUsage();
  assert.equal(Object.hasOwn(latest(), 'contextWindowUsedTokens'), false);
  assert.equal(latest().cachedInputTokens, 2300);
  console.log('PASS 未知容量与不可用状态清除旧上下文值');

  emit('assistant/message', { usage: { inputTokens: 500, outputTokens: 20 } });
  assert.equal(Object.hasOwn(latest(), 'cachedInputTokens'), false);
  console.log('PASS 新步骤缺少缓存字段时不沿用旧缓存计数');

  transport.snapshot = { available: true, contextWindow: Infinity, usedTokens: -1 };
  await session.refreshUsage();
  assert.equal(Object.hasOwn(latest(), 'contextWindowMaxTokens'), false);
  assert.equal(Object.hasOwn(latest(), 'contextWindowUsedTokens'), false);
  console.log('PASS 拒绝无效的上下文计数');

  const pending = [];
  transport.readUsage = () => new Promise(resolve => pending.push(resolve));
  const oldRead = session.refreshUsage();
  await session.configure({ model: 'fixture/beta' });
  assert.equal(pending.length, 2);
  pending[1]({ available: true, contextWindow: 128000, usedTokens: 1100 });
  await delay(0);
  pending[0]({ available: true, contextWindow: 64000, usedTokens: 900 });
  await oldRead;
  assert.equal(latest().contextWindowMaxTokens, 128000);
  assert.equal(latest().contextWindowUsedTokens, 1100);
  console.log('PASS 切模型后迟到的旧响应不能覆盖新值');

  const closingRead = session.refreshUsage();
  await session.close();
  const countBeforeLateResult = events.length;
  pending[2]({ available: true, contextWindow: 128000, usedTokens: 1200 });
  await closingRead;
  assert.equal(events.length, countBeforeLateResult);
  console.log('PASS 关闭后不再发出用量事件');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
