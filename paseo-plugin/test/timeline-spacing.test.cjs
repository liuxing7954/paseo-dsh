require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LANGUAGE_DEFAULTS,
  TIMELINE_STYLE_DEFAULTS,
  TIMELINE_STYLE_KEYS,
  languageSettings,
  timelineStyleSettings,
} = require('../shared/settings.ts');

// Paseo closes every plugin row with a fixed 16px gap. The margin setting is
// added on top of it, so -8 puts a completed tool row and the streaming
// thinking row the same ~8px away from the row above.
const HOST_ROW_GAP = 16;
const VISIBLE_ROW_GAP = HOST_ROW_GAP + TIMELINE_STYLE_DEFAULTS.rowMarginY;

test('one margin keeps streaming and completed rows in lockstep', () => {
  const defaults = timelineStyleSettings.schema.parse({});
  assert.deepEqual(TIMELINE_STYLE_DEFAULTS, defaults, 'TIMELINE_STYLE_DEFAULTS must mirror the schema');
  assert.deepEqual(
    [...TIMELINE_STYLE_KEYS].sort(),
    Object.keys(defaults).sort(),
    'the settings screen must expose every schema field exactly once',
  );

  assert.equal(defaults.rowMarginY, -8);
  assert.equal(VISIBLE_ROW_GAP, 8);
});

test('v4 keeps the tool-row value when the two margins collapse', () => {
  assert.deepEqual(
    timelineStyleSettings.migrate({ toolRowMarginY: -8, liveReasoningRowMarginY: -8 }, 4),
    { rowMarginY: -8 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate({ toolRowMarginY: 4, liveReasoningRowMarginY: 16 }, 4),
    { rowMarginY: 4 },
  );
});

test('v3 and older collapse without resetting deliberate tuning', () => {
  assert.deepEqual(
    timelineStyleSettings.migrate({ toolRowMarginY: -16, liveReasoningRowMarginY: 16 }, 3),
    { rowMarginY: -16 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate({ liveRowMarginY: 8 }, 1),
    { rowMarginY: 8 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate({}, 1),
    { rowMarginY: -8 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate({ rowMarginY: 2 }, 5),
    { rowMarginY: 2 },
  );
});

test('language defaults to auto and accepts only the bundled catalogs', () => {
  assert.deepEqual(LANGUAGE_DEFAULTS, languageSettings.schema.parse({}));
  assert.deepEqual(languageSettings.schema.parse({ language: 'en' }), { language: 'en' });
  assert.deepEqual(languageSettings.schema.parse({ language: 'zh-CN' }), { language: 'zh-CN' });
  assert.throws(() => languageSettings.schema.parse({ language: 'fr' }));
  // The load-time read uses the settings RPC, which only shares the host store.
  assert.equal(languageSettings.scope, 'host');
});
