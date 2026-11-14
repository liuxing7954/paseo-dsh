import { z } from "zod";

export const RUN_CODE_KIND = "dsh-run-code";
export const REASONING_KIND = "dsh-reasoning";

export const activityStatusSchema = z.enum(["running", "completed", "failed", "canceled"]);
export type ActivityStatus = z.output<typeof activityStatusSchema>;
export const runCodeSchema = z.object({
  description: z.string(), code: z.string(), output: z.string().optional(), status: activityStatusSchema,
});
export type RunCodeData = z.output<typeof runCodeSchema>;
export const reasoningSchema = z.object({ text: z.string(), status: activityStatusSchema });
export type ReasoningData = z.output<typeof reasoningSchema>;

/** DSH's ReasoningRow preview, selected from the actual text without summarizing. */
export function reasoningPreview(text: string, status: ActivityStatus): string {
  if (status !== "running") return text.split(/\r?\n/, 1)[0].replaceAll("**", "").trim();
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  while (true) {
    const next = separator.exec(text);
    const end = next === null ? text.length : next.index + next[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= end) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (next === null) return summary.replaceAll("**", "");
    paragraphStart = next.index + next[0].length;
  }
}

export function runCodeItem(callId: string, data: RunCodeData) {
  return { type: "plugin" as const, id: `tool:${callId}`, pluginId: "dsh-paseo",
    kind: RUN_CODE_KIND, version: 1, data: { ...data } };
}

export function reasoningItem(turn: number, step: number, text: string, status: ActivityStatus) {
  return { type: "plugin" as const, id: `reasoning:${turn}:${step}`, pluginId: "dsh-paseo",
    kind: REASONING_KIND, version: 1, data: { text, status } };
}
