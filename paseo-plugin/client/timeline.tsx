/**
 * Compact DSH timeline rows.
 *
 * The tool-row shape and the reasoning preview are adapted from Better Paseo
 * (MIT, Copyright (c) 2026 ABorakati):
 * https://github.com/RoundRedDot/better-paseo
 *
 * Only the pieces this provider needs are implemented: a one-line reasoning
 * preview with a paced expanded body, and icon-led rows for the common DSH
 * tool kinds. Semantic rows the host already owns (questions, plans, todos,
 * subagents) are deliberately left to Paseo.
 */
import type {
  PluginClientContext,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { translateForLabel, useTranslation } from "./i18n";
import { FailedRow, guard, guardAsync, report, withPluginBoundary } from "./guard";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as ReactNative from "react-native";
import { Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";

// The plugin SDK ships partial react-native types; the host runtime still
// provides Animated/Easing, so reach for them through the module object.
const RNAnimated = ReactNative as unknown as {
  Animated: {
    Value: new (value: number) => { interpolate(config: { inputRange: number[]; outputRange: number[] }): unknown };
    View: import("react").ComponentType<{ style?: unknown; accessibilityLabel?: string; accessibilityRole?: string }>;
    loop(animation: unknown): { start(): void; stop(): void };
    sequence(animations: unknown[]): unknown;
    timing(value: unknown, config: Record<string, unknown>): unknown;
  };
  Easing: { inOut(easing: unknown): unknown; ease: unknown };
  StyleSheet: { create<T>(styles: T): T };
};
const AnimatedView = RNAnimated.Animated.View;
const ImageView = (ReactNative as unknown as {
  Image: import("react").ComponentType<{
    source: { uri: string };
    resizeMode?: string;
    style?: unknown;
    accessibilityLabel?: string;
  }>;
}).Image;

import { z } from "zod";
import { imagePreviewRpc, type ImageErrorCode } from "../shared/image-preview";
import { TIMELINE_STYLE_DEFAULTS, timelineStyleSettings, type TimelineStyleValues } from "../shared/settings";
import type { BrowserVerbKey, ToolVerb, ToolVerbKey } from "./messages";

type Phase = "streaming" | "complete";
type Theme = PluginTimelineItemProps<unknown>["theme"];

/** Live presentation settings, falling back to the schema defaults while loading. */
function useTimelineStyle(): TimelineStyleValues {
  const state = useSettings(timelineStyleSettings);
  return state.status === "ready" ? state.values : TIMELINE_STYLE_DEFAULTS;
}

const reasoningSchema = z.object({
  text: z.string(),
  phase: z.string().optional(),
});

const toolDetailSchema = z.record(z.string(), z.unknown());

const todoSchema = z.object({
  items: z.array(
    z.object({
      text: z.string(),
      status: z.string(),
      activeForm: z.string().optional(),
    }),
  ),
});

const toolSchema = z.object({
  name: z.string(),
  status: z.string(),
  detail: toolDetailSchema.optional(),
  callId: z.string().optional(),
  error: z.string().optional(),
  phase: z.string().optional(),
});

type ReasoningData = z.infer<typeof reasoningSchema>;
type TodoData = z.infer<typeof todoSchema>;
type ToolData = z.infer<typeof toolSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Json = boolean | null | number | string | Json[] | { [key: string]: Json };

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Markdown down to the words a one-line preview can show. */
function plainInline(text: string): string {
  return text
    .replace(/```[^\n]*/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function isTerminator(char: string): boolean {
  return char === "." || char === "!" || char === "?" || char === "。" || char === "！" || char === "？";
}

function closersEnd(text: string, index: number): number {
  let next = index + 1;
  while (next < text.length && /["'\u201d\u2019)\]*_`]/.test(text.charAt(next))) next += 1;
  return next;
}

function endsSentence(text: string, index: number): boolean {
  if (!isTerminator(text.charAt(index))) return false;
  const char = text.charAt(index);
  if (char === "。" || char === "！" || char === "？") return true;
  const next = closersEnd(text, index);
  return next >= text.length || /\s/.test(text.charAt(next));
}

/** The newest complete sentence in the tail, so the preview changes per sentence. */
function lastSentence(text: string): string {
  const window = text.length > 1200 ? text.slice(-1200) : text;
  let end = -1;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (endsSentence(window, index)) {
      end = index;
      break;
    }
  }
  if (end < 0) return clip(plainInline(window));
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (window.charAt(index) === "\n") {
      start = index + 1;
      break;
    }
    if (endsSentence(window, index)) {
      start = closersEnd(window, index);
      break;
    }
  }
  return clip(plainInline(window.slice(start, closersEnd(window, end))));
}

function firstSentence(text: string): string {
  const plain = plainInline(text);
  if (plain === "") return "";
  for (let index = 0; index < plain.length; index += 1) {
    if (endsSentence(plain, index)) {
      return clip(plain.slice(0, closersEnd(plain, index)));
    }
  }
  return clip(plain);
}

/**
 * Paseo's host may still export its reveal hook; newer hosts expose a
 * component instead. A small local reveal keeps the expanded thought moving
 * on every host without depending on either surface.
 */
function usePacedText(text: string, streaming: boolean): string {
  const [count, setCount] = useState(() => (streaming ? 0 : text.length));
  useEffect(() => {
    if (!streaming) {
      setCount(text.length);
      return;
    }
    setCount((current) => Math.min(current, text.length));
    const timer = setInterval(() => {
      setCount((current) => {
        if (current >= text.length) return current;
        return Math.min(text.length, current + 12);
      });
    }, 45);
    return () => clearInterval(timer);
  }, [text, streaming]);
  return text.slice(0, Math.min(count, text.length));
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

/** The host's surface tokens may be translucent over a wallpaper; a sheet needs a solid one. */
function sheetBackground(theme: Theme): string {
  const value = theme.colors.foreground.trim();
  let r = 255;
  let g = 255;
  let b = 255;
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const n = Number.parseInt(hex[1] ?? "", 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const rgb = /rgba?\(([^)]+)\)/i.exec(value);
    if (rgb !== null) {
      const parts = (rgb[1] ?? "").split(",").map((part) => Number.parseFloat(part.trim()));
      if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
        [r, g, b] = [parts[0] ?? 255, parts[1] ?? 255, parts[2] ?? 255];
      }
    }
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? "#FFFFFF" : "#1C1C1E";
}

const RUNNING_DOT = { size: 6, periodMs: 1200, minOpacity: 0.3, maxOpacity: 1 } as const;

/**
 * React Native Web compiles `animationKeyframes` into a real @keyframes rule
 * through StyleSheet.create, so the pulse keeps running without a JS frame
 * loop (and without re-rendering the row every frame).
 */
const runningDotPulse = Platform.OS === "web"
  ? RNAnimated.StyleSheet.create({
      pulse: {
        animationKeyframes: [
          { "0%": { opacity: RUNNING_DOT.maxOpacity }, "50%": { opacity: RUNNING_DOT.minOpacity }, "100%": { opacity: RUNNING_DOT.maxOpacity } },
        ],
        animationDuration: `${RUNNING_DOT.periodMs}ms`,
        animationIterationCount: "infinite",
        animationTimingFunction: "ease-in-out",
      } as unknown as Record<string, unknown>,
    }).pulse
  : null;

/** The breathing accent dot that stands in for a running tool's glyph. */
function RunningDot({ color }: { color: string }) {
  const { t } = useTranslation();
  const pulseRef = useRef<{ interpolate(config: { inputRange: number[]; outputRange: number[] }): unknown } | null>(null);
  if (pulseRef.current === null) pulseRef.current = new RNAnimated.Animated.Value(0);
  const pulse = pulseRef.current;
  useEffect(() => {
    if (Platform.OS === "web") return;
    try {
      const loop = RNAnimated.Animated.loop(
        RNAnimated.Animated.timing(pulse, {
          toValue: 1,
          duration: RUNNING_DOT.periodMs,
          easing: RNAnimated.Easing.inOut(RNAnimated.Easing.ease),
          useNativeDriver: true,
        }),
      );
      loop.start();
      return () => loop.stop();
    } catch (error) {
      report("running dot animation", error);
      return;
    }
  }, [pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, RUNNING_DOT.minOpacity, 1] });
  const shape = {
    width: RUNNING_DOT.size,
    height: RUNNING_DOT.size,
    borderRadius: RUNNING_DOT.size / 2,
    backgroundColor: color,
  };
  if (Platform.OS === "web") {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel={t("timeline.row.running")} style={[shape, runningDotPulse as never]} />
    );
  }
  return (
    <AnimatedView accessibilityRole="progressbar" accessibilityLabel={t("timeline.row.running")} style={[shape, { opacity }]} />
  );
}

/** The full command, on its own solid surface, capped so extreme lines scroll. */
function CommandBlock({ text, theme, maxHeight }: { text: string; theme: Theme; maxHeight?: number }) {
  const background = sheetBackground(theme);
  return (
    <View
      style={[
        styles.commandBox,
        { borderColor: theme.colors.border },
        Platform.OS === "web"
          ? ({ backgroundImage: `linear-gradient(${background}, ${background})` } as any)
          : { backgroundColor: background },
      ]}
    >
      <ScrollView
        style={maxHeight === undefined ? undefined : { maxHeight }}
        contentContainerStyle={styles.commandContent}
        showsVerticalScrollIndicator
      >
        <Text selectable style={[styles.commandText, styles.mono, { color: theme.colors.foreground }]}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** Image preview for a read_image tool call; bytes come from the daemon RPC. */
function ImagePreview({ agentId, path, theme }: { agentId: string; path: string; theme: Theme }) {
  const { t } = useTranslation();
  const cwd = useAgent(agentId, (agent) => agent.cwd) ?? "";
  const readImage = useRpc(imagePreviewRpc);
  const window = useWindowDimensions();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; uri: string }
    | { status: "tooLarge"; bytes: number; limit: number }
    | { status: "error"; code: ImageErrorCode; detail: string | null }
  >({ status: "loading" });

  const load = useCallback(
    (allowLarge: boolean) => {
      setState({ status: "loading" });
      const failed = (error: unknown) => {
        setState({
          status: "error",
          code: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        });
      };
      // `readImage` can throw before it returns a promise (the host may not
      // have the RPC ready yet); that throw would escape the effect and become
      // a fatal error, so both shapes are absorbed here.
      try {
        void readImage({ cwd, path, allowLarge })
          .then((result) => {
            if (result.dataUri !== null) {
              setState({ status: "ready", uri: result.dataUri });
            } else if (result.tooLarge) {
              setState({ status: "tooLarge", bytes: result.bytes ?? 0, limit: result.limit ?? 0 });
            } else {
              setState({ status: "error", code: result.errorCode ?? "unreadable", detail: result.errorDetail });
            }
          })
          .catch((error: unknown) => {
            report("image preview", error);
            failed(error);
          });
      } catch (error) {
        report("image preview", error);
        failed(error);
      }
    },
    [cwd, path, readImage],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  if (state.status === "loading") {
    return <Text style={[styles.imageHint, { color: theme.colors.foregroundMuted }]}>{t("timeline.row.loadingImage")}</Text>;
  }
  if (state.status === "tooLarge") {
    return (
      <View style={styles.imageTooLarge}>
        <Text style={[styles.imageHint, { color: theme.colors.foregroundMuted }]}>
          {t("timeline.image.tooLarge", {
            size: (state.bytes / 1024 / 1024).toFixed(1),
            limit: Math.round(state.limit / 1024 / 1024),
          })}
        </Text>
        <Pressable onPress={() => load(true)} accessibilityLabel={t("timeline.row.loadAnyway")} hitSlop={6}>
          <Text style={[styles.imageLoadAnyway, { color: theme.colors.accent }]}>{t("timeline.row.loadAnyway")}</Text>
        </Pressable>
      </View>
    );
  }
  if (state.status === "error") {
    const base = state.code === "unsupported-format"
      ? t("timeline.image.unsupportedFormat")
      : state.code === "not-file"
        ? t("timeline.image.notFile")
        : state.code === "too-large-hard"
          ? t("timeline.image.tooLargeHard")
          : t("timeline.image.unreadable");
    return (
      <Text style={[styles.imageHint, { color: theme.colors.statusDanger }]}>
        {state.detail === null || state.detail === ""
          ? base
          : `${base} · ${t("timeline.image.detail", { message: state.detail })}`}
      </Text>
    );
  }
  return (
    <View
      style={[
        styles.imageFrame,
        { borderColor: theme.colors.border, height: Math.min(360, Math.max(180, Math.round(window.height * 0.32))) },
      ]}
    >
      <ImageView
        source={{ uri: state.uri }}
        resizeMode="contain"
        accessibilityLabel={t("timeline.row.imagePreview")}
        style={styles.image}
      />
    </View>
  );
}

function SheetPanel({
  title,
  subject,
  subjectWrap = false,
  icon,
  theme,
  onClose,
  copyValue,
  fullscreen = false,
  onToggleFullscreen,
  scrollable = true,
  children,
}: {
  title: string;
  subject?: string;
  subjectWrap?: boolean;
  icon: string;
  theme: Theme;
  onClose: () => void;
  copyValue?: string;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  scrollable?: boolean;
  children: ReactNode;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const copy = useCallback(() => {
    if (copyValue === undefined) return;
    guardAsync("copy text", async () => {
      try {
        await copyText(copyValue);
        toast.show(t("timeline.row.copied"));
      } catch {
        toast.error(t("timeline.row.copyFailed"));
      }
    });
  }, [copyValue, toast, t]);
  const window = useWindowDimensions();
  const style = useTimelineStyle();
  return (
    <View style={styles.sheetPanel}>
      <View style={[styles.handle, { backgroundColor: theme.colors.border }]} />
      <View style={styles.sheetHeader}>
        <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
        <Text numberOfLines={1} style={[styles.sheetTitle, { color: theme.colors.foreground }]}>{title}</Text>
        {copyValue === undefined ? null : (
          <Pressable onPress={copy} accessibilityLabel={t("timeline.row.copy")} hitSlop={8}>
            <Icon name="Copy" size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
        {onToggleFullscreen === undefined ? null : (
          <Pressable
            onPress={onToggleFullscreen}
            accessibilityLabel={fullscreen ? t("timeline.row.exitFullscreen") : t("timeline.row.fullscreen")}
            hitSlop={8}
          >
            <Icon
              name={fullscreen ? "Minimize2" : "Maximize2"}
              size={16}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        )}
        <Pressable onPress={onClose} accessibilityLabel={t("timeline.row.close")} hitSlop={8}>
          <Icon name="X" size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {subject === undefined || subject === "" ? null : subjectWrap ? (
        <CommandBlock
          text={subject}
          theme={theme}
          maxHeight={Math.max(style.commandMinHeight, Math.round(window.height * style.commandMaxHeightRatio))}
        />
      ) : (
        <Text numberOfLines={1} selectable style={[styles.sheetSubject, styles.mono, { color: theme.colors.foregroundMuted }]}>
          {subject}
        </Text>
      )}
      {scrollable ? (
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator>
          {children}
        </ScrollView>
      ) : (
        <View style={styles.sheetBody}>{children}</View>
      )}
    </View>
  );
}

function DetailSheet({
  open,
  onClose,
  title,
  subject,
  subjectWrap,
  icon,
  theme,
  copyValue,
  scrollable,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subject?: string;
  subjectWrap?: boolean;
  icon: string;
  theme: Theme;
  copyValue?: string;
  scrollable?: boolean;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const { t } = useTranslation();
  const backdropLabel = t("timeline.row.close");
  useEffect(() => {
    if (!open) setFull(false);
  }, [open]);
  const background = sheetBackground(theme);
  return (
    <Modal visible={open} transparent animationType={Platform.OS === "web" ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={backdropLabel} />
        <View
          style={[
            styles.nativeSheet,
            { height: full ? "92%" : "50%", borderColor: theme.colors.border },
            Platform.OS === "web"
              ? ({ backgroundImage: `linear-gradient(${background}, ${background})` } as any)
              : { backgroundColor: background },
          ]}
        >
          <SheetPanel
            title={title}
            subject={subject}
            subjectWrap={subjectWrap}
            icon={icon}
            theme={theme}
            onClose={onClose}
            copyValue={copyValue}
            fullscreen={full}
            onToggleFullscreen={() => setFull((value) => !value)}
            scrollable={scrollable}
          >
            {children}
          </SheetPanel>
        </View>
      </View>
    </Modal>
  );
}

function ReasoningRow({ item, theme, layout }: PluginTimelineItemProps<ReasoningData>) {
  const { t } = useTranslation();
  const streaming = item.data.phase === "streaming";
  const inline = layout.platform === "web";
  const [open, setOpen] = useState(false);
  const window = useWindowDimensions();
  const text = item.data.text;
  const preview = streaming
    ? lastSentence(text) || t("timeline.thinking.live")
    : firstSentence(text) || t("timeline.thinking.done");
  const revealed = usePacedText(text, streaming && open);
  const spacing = useTimelineStyle();
  // The live tail is laid out by the host with its own gap; a negative pull
  // would overlap the row above it, so live rows never go negative.
  const row = {
    ...styles.row,
    marginTop: streaming ? spacing.liveReasoningRowMarginY : spacing.toolRowMarginY,
    marginBottom: 0,
    paddingVertical: spacing.toolRowPaddingY,
    minHeight: spacing.toolRowMinHeight,
    gap: spacing.toolRowGap,
  };

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={streaming ? t("timeline.thinking.live") : t("timeline.thinking.done")}
        onPress={() => (inline ? setOpen((value) => !value) : setOpen(true))}
        hitSlop={6}
        style={({ pressed }: { pressed: boolean }) => [
          row,
          pressed ? { backgroundColor: theme.colors.surface1, borderRadius: 6 } : null,
        ]}
      >
        <View style={styles.lead}>
          <Icon name="Brain" size={14} color={streaming ? theme.colors.accent : theme.colors.foregroundMuted} />
        </View>
        <Text style={[styles.verb, { color: theme.colors.foregroundMuted }]}>{t("timeline.thinking.verb")}</Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {preview}
        </Text>
        <View style={{ transform: [{ rotate: inline && open ? "90deg" : "0deg" }] }}>
          <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {inline && open ? (
        <View
          style={[
            styles.inlineReasoning,
            { borderColor: theme.colors.border },
            Platform.OS === "web"
              ? ({ backgroundImage: `linear-gradient(${sheetBackground(theme)}, ${sheetBackground(theme)})` } as any)
              : { backgroundColor: sheetBackground(theme) },
          ]}
        >
          <ScrollView
            style={{ maxHeight: Math.max(160, Math.round(window.height * 0.35)) }}
            contentContainerStyle={styles.inlineReasoningContent}
            showsVerticalScrollIndicator
          >
            <Text selectable style={[styles.bodyText, { color: theme.colors.foreground }]}>{revealed}</Text>
          </ScrollView>
        </View>
      ) : null}
      {inline ? null : (
      <DetailSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("timeline.thinking.verb")}
        icon="Brain"
        theme={theme}
        copyValue={revealed}
      >
        <Text selectable style={[styles.bodyText, { color: theme.colors.foreground }]}>{revealed}</Text>
      </DetailSheet>
      )}
    </View>
  );
}

type ToolKind =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "fetch"
  | "mcp"
  | "browser"
  | "code"
  | "todo"
  | "question"
  | "other";

interface ToolLook {
  icon: string;
  /** Resolved when the row renders, so a language switch re-words it. */
  verb: ToolVerb;
  target: string;
  mark?: string;
}

/** A small program mark for the common shell programs Better Paseo brands. */
const PROGRAM_MARKS: Readonly<Record<string, string>> = {
  git: "git",
  gh: "gh",
  npm: "npm",
  npx: "npm",
  pnpm: "pn",
  pnpx: "pn",
  yarn: "y",
  node: "JS",
  deno: "D",
  bun: "bun",
  python: "Py",
  python3: "Py",
  pip: "pip",
  pip3: "pip",
  uv: "uv",
  pytest: "py",
  tsc: "TS",
  tsx: "TS",
  cargo: "rs",
  rustc: "rs",
  go: "Go",
  docker: "D",
  "docker-compose": "D",
  kubectl: "k8s",
  helm: "h",
  terraform: "tf",
  aws: "aws",
  gcloud: "G",
  az: "az",
  swift: "sw",
  ruby: "rb",
  php: "php",
  java: "J",
  gradle: "G",
  mvn: "mvn",
  dotnet: ".N",
  flutter: "F",
  code: "c",
  cursor: "cur",
  claude: "cl",
  codex: "cx",
  gemini: "G",
  rg: "rg",
  grep: "g",
  find: "f",
  curl: "c",
  wget: "w",
  make: "m",
  brew: "b",
};

function shellProgram(command: string | undefined): string | undefined {
  const first = command?.trim().split(/\s+/)[0];
  if (first === undefined || first === "") return undefined;
  const base = first.split(/[/\\]/).pop() ?? first;
  return base.replace(/\.(?:exe|cmd|ps1)$/i, "").replace(/[0-9.]+$/, "");
}

function mcpName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return match === null ? undefined : { server: match[1] ?? "", tool: match[2] ?? "" };
}

function toolKindOf(name: string, detail: Record<string, unknown> | undefined): ToolKind {
  const type = stringField(detail, "type");
  if (type === "shell") return "shell";
  if (type === "read") return "read";
  if (type === "write") return "write";
  if (type === "edit") return "edit";
  if (type === "search") return "search";
  if (type === "fetch") return "fetch";
  // These two carry no native detail shape, so their rows are chosen by name.
  if (name === "todo_write") return "todo";
  if (name === "ask_user_question") return "question";
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "run_code") return "code";
  if (/(?:^|_)browser_/.test(name)) return "browser";
  // Older persisted rows kept `unknown` details; keep their rows recognizable
  // instead of falling back to a bare tool name.
  if (name === "read_image") return "read";
  if (name === "web_fetch" || name === "webfetch") return "fetch";
  if (name === "bash" || name === "pwsh") return "shell";
  return "other";
}

const BROWSER_VERBS: Readonly<Array<[RegExp, BrowserVerbKey]>> = [
  [/^(?:navigate|open|goto|go|new_tab|open_url)$/, "timeline.browser.open"],
  [/^(?:click|press|tap)$/, "timeline.browser.click"],
  [/^(?:type|fill|input|press_key|key)$/, "timeline.browser.type"],
  [/^(?:snapshot|screenshot|capture)$/, "timeline.browser.snapshot"],
  [/^(?:scroll)$/, "timeline.browser.scroll"],
  [/^(?:back|forward|reload)$/, "timeline.browser.navigate"],
  [/^(?:wait)$/, "timeline.browser.wait"],
  [/^(?:close|close_tab)$/, "timeline.browser.close"],
  [/^(?:evaluate|run|run_code)$/, "timeline.browser.run"],
  [/^(?:find|search)$/, "timeline.browser.find"],
];

/** Strip the server prefix and the `browser_` stem so verbs can match on the action. */
function browserAction(name: string): string {
  const parsed = mcpName(name);
  const bare = (parsed?.tool ?? name).replace(/^(?:paseo_)?browser_/, "");
  return bare;
}

function browserVerb(action: string): ToolVerbKey | BrowserVerbKey {
  for (const [pattern, verb] of BROWSER_VERBS) {
    if (pattern.test(action)) return verb;
  }
  return "timeline.tool.browser";
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((value) => value.trim() !== "");
  return line === undefined ? undefined : line.trim();
}

function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  return match?.[1] ?? url.trim();
}

function toolLook(data: ToolData): ToolLook {
  const detail = data.detail;
  const input = isRecord(detail?.input) ? detail.input : undefined;
  const kind = toolKindOf(data.name, detail);
  switch (kind) {
    case "shell": {
      const command = stringField(detail, "command") ?? stringField(input, "command");
      const program = shellProgram(command);
      const mark = program === undefined ? undefined : PROGRAM_MARKS[program];
      return {
        icon: "SquareTerminal",
        verb: "timeline.tool.command",
        target: firstLine(command) ?? data.name,
        ...(mark === undefined ? {} : { mark }),
      };
    }
    case "read": {
      const image = data.name === "read_image";
      return {
        icon: image ? "Image" : "FileText",
        verb: image ? "timeline.tool.image" : "timeline.tool.read",
        target: stringField(detail, "filePath")
          ?? stringField(input, "file_path")
          ?? stringField(input, "path")
          ?? data.name,
      };
    }
    case "write":
      return { icon: "Pencil", verb: "timeline.tool.write", target: stringField(detail, "filePath") ?? data.name };
    case "edit":
      return { icon: "Pencil", verb: "timeline.tool.edit", target: stringField(detail, "filePath") ?? data.name };
    case "search": {
      const query = stringField(detail, "query")
        ?? stringField(input, "query")
        ?? firstLine(stringField(input, "pattern"))
        ?? data.name;
      return {
        icon: "Search",
        verb: stringField(detail, "toolName") === "web_search" ? "timeline.tool.webSearch" : "timeline.tool.search",
        target: query,
      };
    }
    case "fetch":
      return {
        icon: "Globe",
        verb: "timeline.tool.fetch",
        target: hostOf(stringField(detail, "url") ?? stringField(input, "url") ?? data.name),
      };
    case "mcp": {
      const parsed = mcpName(data.name);
      const browser = parsed !== undefined && parsed.tool.includes("browser_");
      return {
        icon: browser ? "Globe" : "Plug",
        verb: browser ? "timeline.tool.browser" : { text: "MCP" },
        target: parsed === undefined ? data.name : `${parsed.server} / ${parsed.tool}`,
      };
    }
    case "browser": {
      const action = browserAction(data.name);
      return {
        icon: "Globe",
        verb: browserVerb(action),
        target: stringField(input, "url")
          ?? stringField(input, "title")
          ?? stringField(input, "selector")
          ?? stringField(input, "name")
          ?? action,
      };
    }
    case "code":
      return {
        icon: "Code",
        verb: "timeline.tool.code",
        target: stringField(input, "description") ?? firstLine(stringField(input, "code")) ?? "run_code",
      };
    case "todo": {
      const items = todoEntries(input);
      const done = items.filter((entry) => entry.status === "completed").length;
      // A plain `done/total` keeps the target language-neutral: the verb is the
      // only word this row needs.
      return { icon: "ListChecks", verb: "timeline.tool.tasks", target: `${done}/${items.length}` };
    }
    case "question":
      return {
        icon: "HelpCircle",
        verb: "timeline.tool.question",
        target: firstLine(questionLines(input)) ?? data.name,
      };
    default:
      return {
        icon: "Wrench",
        verb: { text: data.name },
        target: stringField(input, "url")
          ?? stringField(input, "file_path")
          ?? stringField(input, "path")
          ?? stringField(input, "query")
          ?? stringField(input, "description")
          ?? firstLine(stringField(input, "command"))
          ?? "",
      };
  }
}

function statusKey(status: string) {
  if (status === "running") return "timeline.status.running" as const;
  if (status === "failed") return "timeline.status.failed" as const;
  if (status === "canceled") return "timeline.status.canceled" as const;
  return "timeline.status.done" as const;
}

function statusColor(status: string, theme: Theme): string {
  if (status === "failed") return theme.colors.statusDanger;
  if (status === "running") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

interface TodoEntry {
  text: string;
  status: string;
  activeForm?: string;
}

const TODO_MARKS: Readonly<Record<string, string>> = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
};

/** The `input` object of a tool detail, whichever detail shape it is. */
function detailInput(detail: unknown): Record<string, unknown> | undefined {
  const record = isRecord(detail) ? detail : undefined;
  return isRecord(record?.input) ? record.input : undefined;
}

/** The checklist a `todo_write` call carries, normalized for drawing. */
function todoEntries(input: Record<string, unknown> | undefined): TodoEntry[] {
  const raw = input?.todos;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = stringField(entry, "content") ?? stringField(entry, "text");
    if (text === undefined) return [];
    const activeForm = stringField(entry, "activeForm");
    const status = stringField(entry, "status")
      ?? (entry.completed === true ? "completed" : "pending");
    return [{
      text,
      status: status === "in_progress" || status === "completed" ? status : "pending",
      ...(activeForm === undefined ? {} : { activeForm }),
    }];
  });
}

function checklist(items: TodoEntry[]): string {
  return items
    .map((entry) => {
      // The in-progress wording is what the model is doing right now; the rest
      // stay in their plain form so the list reads as the model wrote it.
      const label = entry.status === "in_progress" ? entry.activeForm ?? entry.text : entry.text;
      return `${TODO_MARKS[entry.status] ?? "○"} ${label}`;
    })
    .join("\n");
}

/** The questions and option labels of an `ask_user_question` call. */
function questionLines(input: Record<string, unknown> | undefined): string {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return stringField(input, "question") ?? "";
  const lines: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const question = stringField(entry, "question") ?? stringField(entry, "header");
    if (question === undefined) continue;
    lines.push(question);
    const options = Array.isArray(entry.options) ? entry.options : [];
    for (const option of options) {
      const label = isRecord(option) ? stringField(option, "label") : typeof option === "string" ? option : undefined;
      if (label !== undefined) lines.push(`  - ${label}`);
    }
  }
  return lines.join("\n");
}

function readContent(content: string): string {
  const match = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(content);
  const body = match?.[1] ?? content;
  return body
    .replace(/^\s*\d+:\s?/gm, "")
    .replace(/\(End of file[^)]*\)\s*$/m, "")
    .trim();
}

function toolContent(data: ToolData): string | undefined {
  const detail = data.detail;
  if (detail === undefined) return undefined;
  const type = stringField(detail, "type");
  const input = isRecord(detail.input) ? detail.input : undefined;
  const kind = toolKindOf(data.name, detail);
  // These two have no detail type of their own, so their drawer body is built
  // from the call's own input rather than from the generic JSON dump.
  if (kind === "todo") {
    const items = todoEntries(input);
    return items.length === 0 ? undefined : checklist(items);
  }
  if (kind === "question") {
    const lines = questionLines(input);
    return lines === "" ? undefined : lines;
  }
  const parts: string[] = [];
  switch (type) {
    case "shell": {
      const output = stringField(detail, "output");
      if (output !== undefined) parts.push(output);
      break;
    }
    case "read": {
      const content = stringField(detail, "content");
      if (content !== undefined) parts.push(readContent(content));
      break;
    }
    case "write":
    case "edit": {
      const content = stringField(detail, "content") ?? stringField(detail, "newString");
      if (content !== undefined) parts.push(content);
      break;
    }
    case "search": {
      const content = stringField(detail, "content");
      if (content !== undefined) parts.push(content);
      break;
    }
    case "fetch": {
      const result = stringField(detail, "result");
      if (result !== undefined) parts.push(result);
      break;
    }
    default: {
      const output = detail.output;
      // Persisted rows from before these tools had a native detail type still
      // carry `unknown`; keep their drawers readable instead of dumping JSON.
      if (data.name === "read_image" || data.name === "read") {
        if (typeof output === "string") parts.push(readContent(output));
      } else if (
        data.name === "web_fetch"
        || data.name === "webfetch"
        || data.name === "bash"
        || data.name === "pwsh"
      ) {
        if (typeof output === "string") parts.push(output);
      } else {
        if (input !== undefined) parts.push(JSON.stringify(input, null, 2));
        if (typeof output === "string") parts.push(output);
        else if (output !== undefined) parts.push(JSON.stringify(output, null, 2));
      }
    }
  }
  const text = parts.join("\n\n").trim();
  return text === "" ? undefined : text.length > 12000 ? `${text.slice(0, 12000)}\n…` : text;
}

function toolSubject(data: ToolData, look: ToolLook): string {
  const detail = data.detail;
  if (detail === undefined) return look.target;
  const type = stringField(detail, "type");
  switch (type) {
    case "shell":
      return stringField(detail, "command") ?? look.target;
    case "read":
    case "write":
    case "edit":
      return stringField(detail, "filePath") ?? look.target;
    case "search":
      return stringField(detail, "query") ?? look.target;
    case "fetch":
      return stringField(detail, "url") ?? look.target;
    default:
      return look.target;
  }
}

type Language = "plain" | "shell" | "json" | "diff" | "code" | "markdown";

type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "key" | "added" | "removed" | "hunk";

interface Token {
  text: string;
  kind: TokenKind;
}

const CODE_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "declare", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "namespace", "new", "null",
  "of", "private", "protected", "public", "readonly", "return", "satisfies", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while",
  "yield", "and", "def", "elif", "except", "is", "lambda", "None", "not", "or", "pass", "raise",
  "self", "True", "False", "with", "cd", "echo", "esac", "exit", "export", "fi", "local", "readonly",
  "source", "then",
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  bash: "shell", c: "code", cc: "code", cjs: "code", cpp: "code", cs: "code", css: "code",
  diff: "diff", go: "code", h: "code", hpp: "code", html: "code", java: "code", js: "code",
  json: "json", jsonc: "json", jsx: "code", kt: "code", markdown: "markdown", md: "markdown",
  mjs: "code", patch: "diff", php: "code", py: "code", rb: "code", rs: "code", scss: "code",
  sh: "shell", sql: "code", swift: "code", toml: "code", ts: "code", tsx: "code", yaml: "code",
  yml: "code", zsh: "shell",
};

function languageFromPath(path: string | undefined): Language {
  if (path === undefined) return "plain";
  const extension = /\.([A-Za-z0-9]+)(?::\d+)?$/.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? "plain" : LANGUAGE_BY_EXTENSION[extension] ?? "plain";
}

function toolLanguage(data: ToolData): Language {
  const detail = data.detail;
  if (detail === undefined) return "plain";
  const type = stringField(detail, "type");
  if (type === "shell") return "shell";
  if (type === "read" || type === "write" || type === "edit") {
    return languageFromPath(stringField(detail, "filePath"));
  }
  if (type === "fetch") return languageFromPath(stringField(detail, "url"));
  const content = toolContent(data)?.trimStart() ?? "";
  return content.startsWith("{") || content.startsWith("[") ? "json" : "plain";
}

function tokenizeLine(line: string, language: Language): Token[] {
  if (language === "diff") {
    if (line.startsWith("+++") || line.startsWith("---")) return [{ text: line, kind: "plain" }];
    if (line.startsWith("@@")) return [{ text: line, kind: "hunk" }];
    if (line.startsWith("+")) return [{ text: line, kind: "added" }];
    if (line.startsWith("-")) return [{ text: line, kind: "removed" }];
    return [{ text: line, kind: "plain" }];
  }
  if (line === "") return [{ text: "", kind: "plain" }];

  const tokens: Token[] = [];
  const shell = language === "shell";
  const json = language === "json";
  const markdown = language === "markdown";
  const syntax = language === "code" || shell || json;
  let index = 0;

  if (markdown) {
    if (/^#{1,6}\s/.test(line)) return [{ text: line, kind: "keyword" }];
    const bullet = /^(\s*)([-*+]|\d+[.)])(\s)/.exec(line);
    if (bullet !== null) {
      const indent = bullet[1] ?? "";
      const marker = bullet[2] ?? "";
      if (indent !== "") tokens.push({ text: indent, kind: "plain" });
      tokens.push({ text: marker, kind: "keyword" });
      index = indent.length + marker.length;
    }
  }

  while (index < line.length) {
    const char = line.charAt(index);
    const rest = line.slice(index);

    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < line.length && /\s/.test(line.charAt(end))) end += 1;
      tokens.push({ text: line.slice(index, end), kind: "plain" });
      index = end;
      continue;
    }

    if (!json && rest.startsWith("/*")) {
      const close = line.indexOf("*/", index + 2);
      const end = close === -1 ? line.length : close + 2;
      tokens.push({ text: line.slice(index, end), kind: "comment" });
      index = end;
      continue;
    }

    if (!json && !markdown && (shell ? char === "#" : rest.startsWith("//"))) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    if (char === '"' || char === "'" || char === "`") {
      if (!syntax && !(markdown && char === "`")) {
        tokens.push({ text: char, kind: "plain" });
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < line.length) {
        const next = line.charAt(end);
        if (next === "\\") {
          end += 2;
          continue;
        }
        end += 1;
        if (next === char) break;
      }
      const text = line.slice(index, end);
      if (json) {
        let after = end;
        while (after < line.length && /\s/.test(line.charAt(after))) after += 1;
        if (line.charAt(after) === ":") {
          tokens.push({ text, kind: "key" });
          index = end;
          continue;
        }
      }
      tokens.push({ text, kind: "string" });
      index = end;
      continue;
    }

    if (syntax && /[0-9]/.test(char)) {
      let end = index + 1;
      while (end < line.length && /[0-9a-fA-FxX._]/.test(line.charAt(end))) end += 1;
      tokens.push({ text: line.slice(index, end), kind: "number" });
      index = end;
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < line.length && /[A-Za-z0-9_$]/.test(line.charAt(end))) end += 1;
      const word = line.slice(index, end);
      tokens.push({ text: word, kind: syntax && CODE_KEYWORDS.has(word) ? "keyword" : "plain" });
      index = end;
      continue;
    }

    tokens.push({ text: char, kind: "plain" });
    index += 1;
  }

  return tokens;
}

function tokenColor(kind: TokenKind, theme: Theme): string | undefined {
  switch (kind) {
    case "comment":
      return theme.colors.foregroundMuted;
    case "string":
      return theme.colors.statusSuccess;
    case "number":
    case "key":
      return theme.colors.statusWarning;
    case "keyword":
      return theme.colors.accent;
    case "added":
      return theme.colors.statusSuccess;
    case "removed":
      return theme.colors.statusDanger;
    case "hunk":
      return theme.colors.accent;
    default:
      return undefined;
  }
}

function HighlightedText({ text, language, theme, wrap = false }: { text: string; language: Language; theme: Theme; wrap?: boolean }) {
  const tokens = useMemo(() => {
    const lines = text.split("\n");
    const result: Token[] = [];
    lines.forEach((line, index) => {
      if (index > 0) result.push({ text: "\n", kind: "plain" });
      result.push(...tokenizeLine(line, language));
    });
    return result;
  }, [text, language]);
  return (
    <Text
      selectable
      style={[
        styles.codeText,
        styles.mono,
        { color: theme.colors.foreground },
        Platform.OS === "web" ? ({ whiteSpace: wrap ? "pre-wrap" : "pre" } as any) : null,
      ]}
    >
      {tokens.map((token, index) => {
        const color = tokenColor(token.kind, theme);
        return color === undefined
          ? token.text
          : <Text key={index} style={{ color }}>{token.text}</Text>;
      })}
    </Text>
  );
}

/** Shared code surface: wrap toggle, copy, and both-axis scrolling. */
function CodeSurface({
  text,
  language,
  theme,
  maxHeight,
}: {
  text: string;
  language: Language;
  theme: Theme;
  maxHeight?: number;
}) {
  const [wrap, setWrap] = useState(false);
  const toast = useToast();
  const { t } = useTranslation();
  const background = sheetBackground(theme);
  const copy = useCallback(() => {
    void copyText(text)
      .then(() => toast.show(t("timeline.row.copied")))
      .catch(() => toast.error(t("timeline.row.copyFailed")));
  }, [text, toast, t]);
  return (
    <View
      style={[
        styles.codeBox,
        maxHeight === undefined ? { flex: 1 } : null,
        { borderColor: theme.colors.border },
        Platform.OS === "web"
          ? ({ backgroundImage: `linear-gradient(${background}, ${background})` } as any)
          : { backgroundColor: background },
      ]}
    >
      <View style={[styles.codeToolbar, { borderBottomColor: theme.colors.border }]}>
        <Pressable
          onPress={() => setWrap((value) => !value)}
          accessibilityLabel={wrap ? t("timeline.row.noWrap") : t("timeline.row.wrap")}
          hitSlop={6}
        >
          <Text style={[styles.codeToolbarText, { color: theme.colors.foregroundMuted }]}>
            {wrap ? t("timeline.row.noWrap") : t("timeline.row.wrap")}
          </Text>
        </Pressable>
        <Pressable onPress={copy} accessibilityLabel={t("timeline.row.copy")} hitSlop={6}>
          <Icon name="Copy" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView
        style={maxHeight === undefined ? styles.codeScroll : { maxHeight }}
        contentContainerStyle={styles.codeScrollContent}
        showsVerticalScrollIndicator
      >
        {wrap ? (
          <HighlightedText text={text} language={language} theme={theme} wrap />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.codeRow}>
            <HighlightedText text={text} language={language} theme={theme} />
          </ScrollView>
        )}
      </ScrollView>
    </View>
  );
}

function ToolRow({ item, theme, layout, agentId }: PluginTimelineItemProps<ToolData>) {
  const [open, setOpen] = useState(false);
  const inline = layout.platform === "web";
  const window = useWindowDimensions();
  const data = item.data;
  const { t } = useTranslation();
  const look = useMemo(() => toolLook(data), [data]);
  const verb = typeof look.verb === "string" ? t(look.verb) : look.verb.text;
  const content = useMemo(() => toolContent(data), [data]);
  const language = useMemo(() => toolLanguage(data), [data]);
  const subject = useMemo(() => toolSubject(data, look), [data, look]);
  const wrapSubject = stringField(data.detail, "type") === "shell";
  const detailInput = isRecord(data.detail?.input) ? data.detail.input : undefined;
  const imagePath = data.name === "read_image"
    ? stringField(data.detail, "filePath") ?? stringField(detailInput, "file_path") ?? stringField(detailInput, "path")
    : undefined;
  const failed = data.status === "failed";
  const spacing = useTimelineStyle();
  const live = data.status === "running" || data.phase === "streaming";
  const row = {
    ...styles.row,
    marginTop: spacing.toolRowMarginY,
    marginBottom: 0,
    paddingVertical: spacing.toolRowPaddingY,
    minHeight: spacing.toolRowMinHeight,
    gap: spacing.toolRowGap,
  };
  const openSheet = useCallback(() => {
    if (content === undefined) return;
    setOpen((value) => (inline ? !value : true));
  }, [content, inline]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${verb}${look.target === "" ? "" : ` ${look.target}`}`}
        onPress={openSheet}
        hitSlop={6}
        style={({ pressed }: { pressed: boolean }) => [
          row,
          pressed ? { backgroundColor: theme.colors.surface1, borderRadius: 6 } : null,
        ]}
      >
        <View style={styles.lead}>
          {data.status === "running" ? (
            <RunningDot color={theme.colors.accent} />
          ) : look.mark === undefined ? (
            <Icon name={look.icon} size={14} color={failed ? theme.colors.statusDanger : theme.colors.foregroundMuted} />
          ) : (
            <View style={[styles.mark, { borderColor: theme.colors.border }]}>
              <Text style={[styles.markText, { color: theme.colors.foregroundMuted }]}>{look.mark}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.verb, { color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted }]}>
          {verb}
        </Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {look.target}
        </Text>
        {data.status === "running" || data.status === "completed" ? null : (
          <Text style={[styles.meta, { color: statusColor(data.status, theme) }]}>
            {t(statusKey(data.status))}
          </Text>
        )}
        {content === undefined ? null : (
          <View style={{ transform: [{ rotate: inline && open ? "90deg" : "0deg" }] }}>
            <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
          </View>
        )}
      </Pressable>
      {inline && open && content !== undefined ? (
        <View style={styles.inlineTool}>
          {wrapSubject && subject !== "" ? (
            <CommandBlock
              text={subject}
              theme={theme}
              maxHeight={Math.max(120, Math.round(window.height * 0.25))}
            />
          ) : null}
          {imagePath === undefined ? (
            <CodeSurface
              text={content}
              language={language}
              theme={theme}
              maxHeight={Math.max(160, Math.round(window.height * 0.4))}
            />
          ) : (
            <View style={styles.imageBody}>
              <ImagePreview agentId={agentId} path={imagePath} theme={theme} />
              <Text style={[styles.imageCaption, { color: theme.colors.foregroundMuted }]}>{content}</Text>
            </View>
          )}
        </View>
      ) : null}
      {inline ? null : (
      <DetailSheet
        open={open}
        onClose={() => setOpen(false)}
        title={verb}
        subject={subject}
        subjectWrap={wrapSubject}
        icon={look.icon}
        theme={theme}
        copyValue={content}
        scrollable={false}
      >
        {content === undefined ? null : imagePath === undefined ? (
          <CodeSurface text={content} language={language} theme={theme} />
        ) : (
          <View style={styles.imageBody}>
            <ImagePreview agentId={agentId} path={imagePath} theme={theme} />
            <Text style={[styles.imageCaption, { color: theme.colors.foregroundMuted }]}>{content}</Text>
          </View>
        )}
      </DetailSheet>
      )}
    </View>
  );
}

/**
 * The checklist Paseo would draw itself, in the plugin's compact row shape.
 *
 * One `todo_write` call yields one of these, so the tool row that produced it is
 * dropped once it completes and the list never appears twice.
 */
function TodoRow({ item, theme, layout }: PluginTimelineItemProps<TodoData>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const inline = layout.platform === "web";
  const window = useWindowDimensions();
  const spacing = useTimelineStyle();
  const items = item.data.items;
  const total = items.length;
  const done = items.filter((entry) => entry.status === "completed").length;
  const content = checklist(items);
  const verb = t("timeline.tool.tasks");
  const row = {
    ...styles.row,
    marginTop: spacing.toolRowMarginY,
    marginBottom: 0,
    paddingVertical: spacing.toolRowPaddingY,
    minHeight: spacing.toolRowMinHeight,
    gap: spacing.toolRowGap,
  };
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${verb} ${done}/${total}`}
        onPress={() => (inline ? setOpen((value) => !value) : setOpen(true))}
        hitSlop={6}
        style={({ pressed }: { pressed: boolean }) => [
          row,
          pressed ? { backgroundColor: theme.colors.surface1, borderRadius: 6 } : null,
        ]}
      >
        <View style={styles.lead}>
          <Icon name="ListChecks" size={14} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={[styles.verb, { color: theme.colors.foregroundMuted }]}>{verb}</Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {`${done}/${total}`}
        </Text>
        <View style={{ transform: [{ rotate: inline && open ? "90deg" : "0deg" }] }}>
          <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {inline && open ? (
        <View style={styles.inlineTool}>
          <ScrollView
            style={{ maxHeight: Math.max(160, Math.round(window.height * 0.35)) }}
            contentContainerStyle={styles.inlineReasoningContent}
            showsVerticalScrollIndicator
          >
            <Text selectable style={[styles.bodyText, { color: theme.colors.foreground }]}>{content}</Text>
          </ScrollView>
        </View>
      ) : null}
      {inline ? null : (
        <DetailSheet
          open={open}
          onClose={() => setOpen(false)}
          title={verb}
          icon="ListChecks"
          theme={theme}
          copyValue={content}
        >
          <Text selectable style={[styles.bodyText, { color: theme.colors.foreground }]}>{content}</Text>
        </DetailSheet>
      )}
    </View>
  );
}

export function contributeTimeline(client: PluginClientContext): () => void {
  const cleanups = [
    client.addTimelineTransformer({
      id: "dsh-reasoning-row",
      query: { itemType: "reasoning" },
      transform({ item, phase }) {
        return guard("timeline transformer dsh-reasoning", () => {
          if (item.type !== "reasoning" || item.text.trim() === "") return undefined;
          return {
            items: [{
              type: "plugin" as const,
              kind: "dsh-reasoning",
              version: 1,
              data: { text: item.text, phase },
            }],
          };
        }, undefined);
      },
    }),
    client.addTimelineRenderer({
      kind: "dsh-reasoning",
      version: 1,
      schema: reasoningSchema,
      Component: withPluginBoundary<PluginTimelineItemProps<ReasoningData>>(
        "dsh-reasoning",
        ReasoningRow,
        (props) => <FailedRow theme={props.theme} message={translateForLabel("timeline.row.renderFailed")} />,
      ),
    }),
    client.addTimelineTransformer({
      id: "dsh-todo-row",
      query: { itemType: "todo" },
      transform({ item }) {
        return guard("timeline transformer dsh-todo", () => {
          if (item.type !== "todo") return undefined;
          const items = item.items.flatMap((entry) => {
            const text = typeof entry.text === "string" ? entry.text : "";
            if (text === "") return [];
            const status = typeof entry.status === "string"
              ? entry.status
              : entry.completed
                ? "completed"
                : "pending";
            return [{
              text,
              status,
              ...(typeof entry.activeForm === "string" ? { activeForm: entry.activeForm } : {}),
            }];
          });
          if (items.length === 0) return undefined;
          return {
            items: [{
              type: "plugin" as const,
              kind: "dsh-todo",
              version: 1,
              data: { items },
            }],
          };
        }, undefined);
      },
    }),
    client.addTimelineRenderer({
      kind: "dsh-todo",
      version: 1,
      schema: todoSchema,
      Component: withPluginBoundary<PluginTimelineItemProps<TodoData>>(
        "dsh-todo",
        TodoRow,
        (props) => <FailedRow theme={props.theme} message={translateForLabel("timeline.row.renderFailed")} />,
      ),
    }),
    client.addTimelineTransformer({
      id: "dsh-tool-row",
      query: { itemType: "tool_call" },
      transform({ item, phase }) {
        return guard("timeline transformer dsh-tool", () => {
          if (item.type !== "tool_call") return undefined;
          const detail = isRecord(item.detail) ? item.detail : undefined;
          const type = stringField(detail, "type");
          // A finished `todo_write` is drawn by the checklist row above; keeping
          // its tool row too would show one call twice.
          if (
            item.name === "todo_write"
            && item.status === "completed"
            && todoEntries(detailInput(detail)).length > 0
          ) {
            return { items: [] };
          }
          // Keep Paseo's richer cards for semantic helpers; every other tool gets
          // the shared row so a provider-specific name never shows up bare, and an
          // unfamiliar tool falls back to the generic wrench row instead of the
          // host's own styling.
          const nativeCard = type === "sub_agent"
            || type === "worktree_setup"
            || type === "plan";
          if (nativeCard) return undefined;
          const error = item.error === null || item.error === undefined ? undefined : String(
            isRecord(item.error) && typeof item.error.message === "string" ? item.error.message : item.error,
          );
          return {
            items: [{
              type: "plugin" as const,
              kind: "dsh-tool",
              version: 1,
              data: {
                name: item.name,
                status: item.status,
                ...(detail === undefined ? {} : { detail: toJson(detail) }),
                ...(item.callId === undefined ? {} : { callId: item.callId }),
                ...(error === undefined ? {} : { error }),
                phase,
              },
            }],
          };
        }, undefined);
      },
    }),
    client.addTimelineRenderer({
      kind: "dsh-tool",
      version: 1,
      schema: toolSchema,
      Component: withPluginBoundary<PluginTimelineItemProps<ToolData>>(
        "dsh-tool",
        ToolRow,
        (props) => <FailedRow theme={props.theme} message={translateForLabel("timeline.row.renderFailed")} />,
      ),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

const styles = {
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 2,
    minHeight: 24,
    marginVertical: 0,
  },
  lead: { width: 17, height: 17, alignItems: "center", justifyContent: "center" },
  mark: { width: 17, height: 17, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  markText: { fontSize: 8, fontWeight: "700", lineHeight: 10 },
  verb: { fontSize: 12, fontWeight: "600", minWidth: 24 },
  target: { flex: 1, minWidth: 0, fontSize: 12 },
  meta: { fontSize: 11 },
  mono: { fontFamily: MONO },
  bodyText: { fontSize: 13, lineHeight: 20 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  nativeSheet: {
    position: "relative",
    zIndex: 1,
    width: "100%",
    maxWidth: 720,
    height: "50%",
    alignSelf: "center",
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: "hidden",
  },
  sheetPanel: { flex: 1 },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: "center", marginTop: 8, marginBottom: 4 },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  sheetTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: "600" },
  sheetSubject: { fontSize: 12, paddingHorizontal: 16, marginTop: -2, marginBottom: 8 },
  commandBox: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  commandContent: { paddingHorizontal: 10, paddingVertical: 8 },
  commandText: { fontSize: 12, lineHeight: 18 },
  inlineTool: { marginTop: 6, marginBottom: 10, paddingHorizontal: 2, gap: 0 },
  imageBody: { flex: 1, gap: 8 },
  imageFrame: { borderWidth: 1, borderRadius: 8, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "100%" },
  imageHint: { fontSize: 12, paddingVertical: 6 },
  imageTooLarge: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  imageLoadAnyway: { fontSize: 12, fontWeight: "600" },
  imageCaption: { fontSize: 12, lineHeight: 17 },
  inlineReasoning: { marginTop: 6, marginBottom: 10, borderWidth: 1, borderRadius: 8, overflow: "hidden" },
  inlineCodeBox: { borderWidth: 1, borderRadius: 10, overflow: "hidden" },
  inlineReasoningContent: { padding: 10 },
  sheetScroll: { flex: 1 },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 4 },
  sheetBody: { flex: 1, paddingHorizontal: 16, paddingBottom: 16, paddingTop: 4 },
  codeBox: { borderWidth: 1, borderRadius: 10, overflow: "hidden" },
  codeToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  codeToolbarText: { fontSize: 11 },
  codeScroll: { flex: 1 },
  codeScrollContent: { padding: 12 },
  codeRow: { paddingRight: 12 },
  codeText: { fontSize: 12, lineHeight: 18 },
} as const;
