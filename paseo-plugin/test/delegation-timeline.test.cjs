require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TimelineBuilder } = require('../server/timeline.ts');
const { ProviderEventSchema } = require('@getpaseo/plugin/server/provider');

for (const mode of ['native', 'ptc']) {
  test(`${mode} delegation results retain the native child link for spawn, fork, workflow and aliases`, () => {
    const timeline = new TimelineBuilder();
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'custom_delegate']) {
      const callId = `${mode}:${name}`;
      const childId = `child:${name}`;
      const input = { description: `Run ${name}` };
      if (mode === 'native') {
        timeline.consume({ type: 'tool/call', data: { callId, name, arguments: input } });
      } else {
        timeline.consume({ type: 'tool/ptc-dispatch-start', data: { subCallId: callId, name, arguments: input } });
      }
      const [running] = timeline.subagent(callId, name, input.description, childId);
      assert.equal(running.detail.childSessionId, childId);
      const content = [{ type: 'text', text: 'Structured result without a started-subagent string' }];
      const resultEvent = mode === 'native'
        ? { type: 'tool/result', data: { message: { toolCallId: callId, content } } }
        : { type: 'tool/ptc-dispatch', data: { subCallId: callId, name, arguments: input, content } };
      const [result] = timeline.consume(resultEvent);
      assert.equal(result.id, running.id, 'the durable result updates the existing delegation card');
      assert.equal(result.status, 'completed');
      assert.equal(result.detail.type, 'sub_agent');
      assert.equal(result.detail.childSessionId, childId);
      assert.equal(result.detail.description, input.description);
      assert.deepEqual(timeline.consume(resultEvent), [result], 'replaying the result must update the same card identity');
      ProviderEventSchema.parse({ type: 'timeline.item', sessionId: 'root', item: result });
    }
  });
}

test('PTC delegation failures and cancellation settle semantic cards without adding internal operations', () => {
  const timeline = new TimelineBuilder();
  timeline.consume({ type: 'tool/ptc-dispatch-start', data: { subCallId: 'failed', name: 'subagent' } });
  const [failed] = timeline.consume({ type: 'tool/ptc-dispatch', data: {
    subCallId: 'failed', name: 'subagent', isError: true, content: [{ type: 'text', text: 'delegation refused' }],
  } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'delegation refused');
  timeline.subagent('pending', 'workflow', 'Waiting', 'child');
  const [cancelled] = timeline.finishPending('canceled');
  assert.equal(cancelled.callId, 'pending');
  assert.equal(cancelled.status, 'canceled');
  assert.deepEqual(timeline.finishPending('canceled'), []);
  assert.deepEqual(timeline.consume({ type: 'tool/ptc-dispatch', data: {
    subCallId: 'read', name: 'read', content: [{ type: 'text', text: 'internal file' }],
  } }), []);
});
