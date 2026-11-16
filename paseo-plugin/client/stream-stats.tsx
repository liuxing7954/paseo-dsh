import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { measureFooterGeometry, rowIsLaidOut, watchRow } from "./web";

export const streamStatsSchema = z.object({
  firstTokenMs: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  outputTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  contextUsed: z.number().optional(),
  contextMax: z.number().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingOption: z.string().optional(),
  toolCalls: z.number().optional(),
  toolMs: z.number().optional(),
  turns: z.number().optional(),
  steps: z.number().optional(),
  sessionTokens: z.number().optional(),
  cacheHit: z.number().optional(),
  /** Set by the daemon on the last row of a completed turn: the copy footer is above it. */
  final: z.boolean().optional(),
});

type StreamStats = z.infer<typeof streamStatsSchema>;

/**
 * Paseo paints the completed-turn footer at `STREAM_METADATA_FONT_SIZE` (13px).
 * Until the page can be measured that is also what this row draws at, so the
 * two lines read as one block instead of two sizes.
 */
const FOOTER_FONT_SIZE = 13;
/** Space under the footer's last line, as a fraction of this row's text size. */
const GAP_EM = 0.46;
/** The row's own small offsets, also fractions of its text size (~2px / ~1px at 13). */
const INSET_EM = 0.15;
const DETAIL_GAP_EM = 0.1;

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function contextRatio(data: StreamStats): number | undefined {
  if (data.contextUsed === undefined || data.contextMax === undefined || data.contextMax <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, data.contextUsed / data.contextMax));
}

/** One compact line under an answer; tap to expand the full picture. */
function StreamStatsRow({ item, theme, layout }: PluginTimelineItemProps<StreamStats>) {
  const [open, setOpen] = useState(false);
  const [fontSize, setFontSize] = useState(FOOTER_FONT_SIZE);
  const [lift, setLift] = useState(0);
  const rowRef = useRef<unknown>(null);
  /** The lift the DOM currently carries; the next measurement discounts it. */
  const appliedLift = useRef(0);
  const data = item.data;
  const { t } = useTranslation(messages);
  const line = {
    context(): string | undefined {
      const ratio = contextRatio(data);
      if (ratio === undefined) return undefined;
      const filled = Math.round(ratio * 10);
      const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
      return t("streamStats.contextLine", {
        used: formatNumber(data.contextUsed ?? 0),
        max: formatNumber(data.contextMax ?? 0),
        bar,
        percent: Math.round(ratio * 100),
      });
    },
    tokens(): string | undefined {
      const parts: string[] = [];
      if (data.inputTokens !== undefined) {
        parts.push(t("streamStats.tokenInput", { tokens: formatNumber(data.inputTokens) }));
      }
      if (data.cachedInputTokens !== undefined) {
        parts.push(t("streamStats.tokenCached", { tokens: formatNumber(data.cachedInputTokens) }));
      }
      if (data.outputTokens !== undefined) {
        parts.push(t("streamStats.tokenOutput", { tokens: formatNumber(data.outputTokens) }));
      }
      return parts.length === 0 ? undefined : t("streamStats.tokensLine", { parts: parts.join(" · ") });
    },
    route(): string | undefined {
      if (data.provider === undefined && data.model === undefined) return undefined;
      const route = [data.provider, data.model].filter((part) => part !== undefined).join(" / ");
      return data.thinkingOption === undefined
        ? t("streamStats.routeLine", { route })
        : t("streamStats.routeWithThinking", { route, option: data.thinkingOption });
    },
    tools(): string | undefined {
      if (data.toolCalls === undefined || data.toolCalls <= 0) return undefined;
      const calls = t("streamStats.tools", { count: data.toolCalls });
      const duration = data.toolMs === undefined ? "" : ` · ${formatLatency(data.toolMs)}`;
      return t("streamStats.toolsLine", { calls, duration });
    },
  };

  // The ref must describe the margin the DOM actually carries, not the one a
  // pending render is about to apply.
  useLayoutEffect(() => {
    appliedLift.current = lift;
  }, [lift]);

  // Only the last row of a completed turn has the footer directly above it, and
  // only the web build can see where that footer was painted. Everything else
  // keeps the host's spacing: a guessed offset is what used to ride up over the
  // answer once a second turn pushed the first one down.
  useLayoutEffect(() => {
    if (data.final !== true || layout.platform !== "web") {
      setLift(0);
      return;
    }
    const measure = () => {
      const found = measureFooterGeometry(rowRef.current, {
        appliedLift: appliedLift.current,
        gapEm: GAP_EM,
        fallbackFontSize: FOOTER_FONT_SIZE,
      });
      if (found === null) {
        // A hidden tab (zero-height row) says nothing about the layout: keep
        // the last margin so switching back does not un-tuck the row.
        if (rowIsLaidOut(rowRef.current)) setLift(0);
        return;
      }
      setLift(found.lift);
      setFontSize(found.fontSize);
    };
    measure();
    // The footer is not necessarily in its final place when the row mounts: it
    // can arrive a frame later, and the host may move it after the turn is
    // marked complete. Re-measure a few times while that settles, and keep
    // watching the containers in case it moves again (a new turn pushing this
    // one down, a theme swap, a font load).
    const retries = [80, 240, 700, 1500].map((ms) => setTimeout(measure, ms));
    const stop = watchRow(rowRef.current, measure);
    return () => {
      for (const timer of retries) clearTimeout(timer);
      stop?.();
    };
  }, [data.final, layout.platform]);

  const muted = theme.colors.foregroundMuted;
  const lineHeight = Math.round(fontSize * (18 / 13));
  const inset = Math.max(1, Math.round(fontSize * INSET_EM));
  const base = {
    color: muted,
    fontSize,
    lineHeight,
    fontVariant: ["tabular-nums"] as const,
  };

  const ratio = contextRatio(data);
  const segments: Array<{ text: string; color: string }> = [];
  if (data.turns !== undefined && data.steps !== undefined) {
    segments.push({ text: t("streamStats.turnsSteps", { turns: data.turns, steps: data.steps }), color: muted });
  }
  if (data.firstTokenMs !== undefined) {
    segments.push({ text: t("streamStats.firstToken", { latency: formatLatency(data.firstTokenMs) }), color: muted });
  }
  if (data.tokensPerSecond !== undefined) {
    segments.push({ text: `${Math.round(data.tokensPerSecond)} tok/s`, color: muted });
  }
  if (ratio !== undefined) {
    segments.push({ text: t("streamStats.contextPercent", { percent: Math.round(ratio * 100) }), color: muted });
  }
  if (data.cacheHit !== undefined) {
    segments.push({ text: t("streamStats.cacheHit", { percent: Math.round(data.cacheHit * 100) }), color: muted });
  }
  if (segments.length === 0) return null;

  const details = [line.context(), line.tokens(), line.route(), line.tools()].filter(
    (line): line is string => line !== undefined,
  );

  return (
    <Pressable
      ref={rowRef}
      accessibilityRole="button"
      accessibilityLabel={open ? t("streamStats.collapse") : t("streamStats.expand")}
      onPress={() => setOpen((value) => !value)}
      style={{ alignSelf: "flex-start", marginTop: lift, marginBottom: 0, paddingLeft: inset }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
        {segments.map((segment, index) => (
          <Fragment key={segment.text}>
            {index > 0 ? <Text style={base}> · </Text> : null}
            <Text style={{ ...base, color: segment.color }}>{segment.text}</Text>
          </Fragment>
        ))}
        <Text style={base}>{open ? " ▴" : " ▾"}</Text>
      </View>
      {open ? (
        <View style={{ marginTop: inset, gap: Math.max(1, Math.round(fontSize * DETAIL_GAP_EM)) }}>
          {details.map((line) => (
            <Text key={line} style={base}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

export function contributeStreamStats(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "dsh-stream-stats",
    version: 1,
    schema: streamStatsSchema,
    Component: StreamStatsRow,
  });
  return () => {};
}
