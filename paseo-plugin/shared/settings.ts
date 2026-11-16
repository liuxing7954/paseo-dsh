import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped presentation knobs for the DSH timeline rows and the tool drawer.
 *
 * The timeline row's own margin stacks on top of the host item spacing (Paseo
 * already puts 16px between timeline items), so negative values tighten the
 * visible gap while positive values widen it.
 */
export const timelineStyleSettings = defineSettings({
  id: "timeline-style",
  scope: "host",
  version: 3,
  migrate(values, fromVersion) {
    if (!isRecord(values)) return values;
    const { liveToolRowMarginY: _dropped, liveRowMarginY, ...rest } = values;
    if (fromVersion < 2) {
      rest["liveReasoningRowMarginY"] = typeof liveRowMarginY === "number" ? liveRowMarginY : 8;
    }
    return rest;
  },
  schema: z.object({
    toolRowMarginY: z.number().min(-16).max(24).default(-8),
    liveReasoningRowMarginY: z.number().min(-16).max(24).default(8),
    toolRowPaddingY: z.number().min(0).max(12).default(0),
    toolRowMinHeight: z.number().min(12).max(64).default(16),
    toolRowGap: z.number().min(0).max(24).default(6),
    commandMaxHeightRatio: z.number().min(0.1).max(0.6).default(0.25),
    commandMinHeight: z.number().min(60).max(360).default(120),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TimelineStyleValues = z.output<typeof timelineStyleSettings.schema>;
export type TimelineStyleKey = keyof TimelineStyleValues;

export const TIMELINE_STYLE_DEFAULTS: TimelineStyleValues = {
  toolRowMarginY: -8,
  liveReasoningRowMarginY: 8,
  toolRowPaddingY: 0,
  toolRowMinHeight: 16,
  toolRowGap: 6,
  commandMaxHeightRatio: 0.25,
  commandMinHeight: 120,
};

/**
 * Editor order for the settings screen. The label and hint text lives in the
 * client locale catalogs (`settings.field.<key>.label` / `.hint`), so the shared
 * contract carries keys only and the app language decides the wording.
 */
export const TIMELINE_STYLE_KEYS = [
  "toolRowMarginY",
  "liveReasoningRowMarginY",
  "toolRowPaddingY",
  "toolRowMinHeight",
  "toolRowGap",
  "commandMaxHeightRatio",
  "commandMinHeight",
] as const satisfies readonly TimelineStyleKey[];
