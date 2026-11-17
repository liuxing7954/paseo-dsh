require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  TIMELINE_STYLE_DEFAULTS,
  timelineStyleSettings,
} = require('../shared/settings.ts');

// Paseo closes every plugin row with a fixed 16px gap. A streaming reasoning
// row used to add +8 on top of it, so the newest thought sat 24px below the
// step above while completed rows sat 8px below. Keep the two in lockstep.
const HOST_ROW_GAP = 16;
const COMPLETED_ROW_GAP = HOST_ROW_GAP + TIMELINE_STYLE_DEFAULTS.toolRowMarginY;

test('streaming and completed reasoning rows start with the same visible gap', () => {
  const defaults = timelineStyleSettings.schema.parse({});
  assert.deepEqual(TIMELINE_STYLE_DEFAULTS, defaults, 'TIMELINE_STYLE_DEFAULTS must mirror the schema');

  assert.equal(defaults.liveReasoningRowMarginY, defaults.toolRowMarginY);
  assert.equal(HOST_ROW_GAP + defaults.liveReasoningRowMarginY, COMPLETED_ROW_GAP);
  assert.equal(COMPLETED_ROW_GAP, 8);
});

test('the old floating default migrates to the shared gap, deliberate values survive', () => {
  assert.deepEqual(timelineStyleSettings.migrate({ liveReasoningRowMarginY: 8 }, 3), {
    liveReasoningRowMarginY: -8,
  });
  assert.deepEqual(timelineStyleSettings.migrate({ liveReasoningRowMarginY: 4 }, 3), {
    liveReasoningRowMarginY: 4,
  });
  assert.deepEqual(timelineStyleSettings.migrate({ liveReasoningRowMarginY: 0 }, 3), {
    liveReasoningRowMarginY: 0,
  });
});

test('version 1 migrations land on the shared gap instead of the old +8', () => {
  assert.deepEqual(timelineStyleSettings.migrate({ liveRowMarginY: 8 }, 1), {
    liveReasoningRowMarginY: -8,
  });
  assert.deepEqual(timelineStyleSettings.migrate({ liveRowMarginY: 6 }, 1), {
    liveReasoningRowMarginY: 6,
  });
  assert.deepEqual(timelineStyleSettings.migrate({}, 1), {
    liveReasoningRowMarginY: -8,
  });
});
