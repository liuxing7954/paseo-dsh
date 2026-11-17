import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped presentation knobs for the DSH timeline rows and the tool drawer.
 *
 * One margin drives both the completed tool rows and the streaming thinking
 * row. The host closes every plugin row with a fixed 16px gap, so a negative
 * value tightens the visible gap in both phases and a positive one widens it.
 * Keeping two knobs only let the live row drift away from every completed row.
 */
export const timelineStyleSettings = defineSettings({
  id: "timeline-style",
  scope: "host",
  version: 5,
  migrate(values) {
    if (!isRecord(values)) return values;
    const {
      liveToolRowMarginY: _droppedLiveTool,
      liveRowMarginY,
      toolRowMarginY,
      liveReasoningRowMarginY: _droppedLiveReasoning,
      rowMarginY,
      ...rest
    } = values;
    // v1-v4 kept the tool-row and streaming-row margins apart. Both sit on the
    // same host 16px, so v5 collapses them into one knob. The tool-row value
    // wins because it was the primary control; a v1 file that only had the live
    // margin falls back to it, and an empty file lands on the new default.
    const merged = typeof rowMarginY === "number"
      ? rowMarginY
      : typeof toolRowMarginY === "number"
        ? toolRowMarginY
        : typeof liveRowMarginY === "number"
          ? liveRowMarginY
          : -8;
    rest["rowMarginY"] = merged;
    return rest;
  },
  schema: z.object({
    rowMarginY: z.number().min(-16).max(24).default(-8),
    toolRowPaddingY: z.number().min(0).max(12).default(0),
    toolRowMinHeight: z.number().min(12).max(64).default(16),
    toolRowGap: z.number().min(0).max(24).default(6),
    commandMaxHeightRatio: z.number().min(0.1).max(0.6).default(0.25),
    commandMinHeight: z.number().min(60).max(360).default(120),
  }),
});

/**
 * The language this plugin draws its own UI in. `auto` follows the host;
 * `en` and `zh-CN` force one of the bundled catalogs.
 *
 * Host-scoped on purpose: the plugin reads the choice once at load through the
 * settings RPC, and only host-scoped settings share that server-backed store
 * with `useSettings`. A device-scoped value would live in the client's local
 * store, which the load-time read cannot reach.
 */
export const languageSettings = defineSettings({
  id: "language",
  scope: "host",
  version: 1,
  schema: z.object({
    language: z.enum(["auto", "en", "zh-CN"]).default("auto"),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TimelineStyleValues = z.output<typeof timelineStyleSettings.schema>;
export type TimelineStyleKey = keyof TimelineStyleValues;

export type LanguageValues = z.output<typeof languageSettings.schema>;
export type LanguageChoice = LanguageValues["language"];

export const TIMELINE_STYLE_DEFAULTS: TimelineStyleValues = {
  rowMarginY: -8,
  toolRowPaddingY: 0,
  toolRowMinHeight: 16,
  toolRowGap: 6,
  commandMaxHeightRatio: 0.25,
  commandMinHeight: 120,
};

export const LANGUAGE_DEFAULTS: LanguageValues = {
  language: "auto",
};

/**
 * Editor order for the settings screen. The label and hint text lives in the
 * client locale catalogs (`settings.field.<key>.label` / `.hint`), so the shared
 * contract carries keys only and the app language decides the wording.
 */
export const TIMELINE_STYLE_KEYS = [
  "rowMarginY",
  "toolRowPaddingY",
  "toolRowMinHeight",
  "toolRowGap",
  "commandMaxHeightRatio",
  "commandMinHeight",
] as const satisfies readonly TimelineStyleKey[];
