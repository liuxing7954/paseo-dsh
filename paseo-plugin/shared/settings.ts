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

export interface TimelineStyleField {
  key: TimelineStyleKey;
  label: string;
  hint: string;
}

export const TIMELINE_STYLE_FIELDS: readonly TimelineStyleField[] = [
  {
    key: "toolRowMarginY",
    label: "工具之间的额外间距",
    hint: "叠加在宿主固定 16px 之上，可填负数：8 → 约 24px，-8 → 约 8px，-16 → 约 0px。范围 -16 ~ 24。",
  },
  {
    key: "liveReasoningRowMarginY",
    label: "正在输出的思考行额外间距",
    hint: "只作用于正在流式输出的思考行。默认 8，负值可能重叠。",
  },
  {
    key: "toolRowPaddingY",
    label: "工具行上下内边距（行内留白）",
    hint: "只改行内留白，不改工具之间的距离；要缩小行间距请改上面的“工具之间的额外间距”。范围 0 ~ 12。",
  },
  {
    key: "toolRowMinHeight",
    label: "工具行最小高度",
    hint: "整行至少多高；配合内边距 0 可压到接近图标高度（约 17px）。范围 12 ~ 64。",
  },
  {
    key: "toolRowGap",
    label: "图标与文字的水平间距",
    hint: "图标、动词、目标之间。范围 0 ~ 24。",
  },
  {
    key: "commandMaxHeightRatio",
    label: "命令块最大高度（窗口占比）",
    hint: "0.25 表示最多占窗口高度的四分之一；超过后命令块内部滚动，输出区始终保留。范围 0.1 ~ 0.6。",
  },
  {
    key: "commandMinHeight",
    label: "命令块最小高度上限",
    hint: "窗口很小时仍给命令块保留的高度（像素）。范围 60 ~ 360。",
  },
];
