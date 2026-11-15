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
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";

type Phase = "streaming" | "complete";
type Theme = PluginTimelineItemProps<unknown>["theme"];

const reasoningSchema = z.object({
  text: z.string(),
  phase: z.string().optional(),
});

const toolDetailSchema = z.record(z.string(), z.unknown());

const toolSchema = z.object({
  name: z.string(),
  status: z.string(),
  detail: toolDetailSchema.optional(),
  callId: z.string().optional(),
  error: z.string().optional(),
  phase: z.string().optional(),
});

type ReasoningData = z.infer<typeof reasoningSchema>;
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

function useBlink(active: boolean): number {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }
    const timer = setInterval(() => setOn((value) => !value), 700);
    return () => clearInterval(timer);
  }, [active]);
  return active && !on ? 0.35 : 1;
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

function ReasoningRow({ item, theme }: PluginTimelineItemProps<ReasoningData>) {
  const streaming = item.data.phase === "streaming";
  const [expanded, setExpanded] = useState(false);
  const text = item.data.text;
  const preview = streaming ? lastSentence(text) || "思考中…" : firstSentence(text) || "已思考";
  const revealed = usePacedText(text, streaming);
  const opacity = useBlink(streaming);
  const body = useRef<{ scrollToEnd?: (options?: { animated?: boolean }) => void } | null>(null);

  useEffect(() => {
    if (expanded && streaming) body.current?.scrollToEnd?.({ animated: false });
  }, [expanded, streaming, revealed]);

  const toggle = useCallback(() => setExpanded((value) => !value), []);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={streaming ? "思考中" : "已思考"}
        onPress={toggle}
        style={styles.row}
      >
        <View style={[styles.dot, { backgroundColor: streaming ? theme.colors.accent : theme.colors.foregroundMuted, opacity }]} />
        <Text style={[styles.verb, { color: theme.colors.foregroundMuted }]}>
          {streaming ? "思考" : "已思考"}
        </Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {preview}
        </Text>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
      {expanded ? (
        <ScrollView
          ref={body}
          style={[styles.body, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }]}
          onContentSizeChange={() => {
            if (streaming) body.current?.scrollToEnd?.({ animated: false });
          }}
        >
          <Text selectable style={[styles.bodyText, { color: theme.colors.foreground }]}>{revealed}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

type ToolKind = "shell" | "read" | "write" | "edit" | "search" | "fetch" | "mcp" | "code" | "other";

interface ToolLook {
  icon: string;
  verb: string;
  target: string;
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
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "run_code") return "code";
  return "other";
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
    case "shell":
      return { icon: "SquareTerminal", verb: "命令", target: firstLine(stringField(detail, "command")) ?? data.name };
    case "read":
      return { icon: "FileText", verb: "读取", target: stringField(detail, "filePath") ?? data.name };
    case "write":
      return { icon: "Pencil", verb: "写入", target: stringField(detail, "filePath") ?? data.name };
    case "edit":
      return { icon: "Pencil", verb: "编辑", target: stringField(detail, "filePath") ?? data.name };
    case "search": {
      const query = stringField(detail, "query") ?? firstLine(stringField(input, "pattern")) ?? data.name;
      return {
        icon: "Search",
        verb: stringField(detail, "toolName") === "web_search" ? "网页搜索" : "搜索",
        target: query,
      };
    }
    case "fetch":
      return { icon: "Globe", verb: "抓取", target: hostOf(stringField(detail, "url") ?? data.name) };
    case "mcp": {
      const parsed = mcpName(data.name);
      return {
        icon: "Plug",
        verb: "MCP",
        target: parsed === undefined ? data.name : `${parsed.server} / ${parsed.tool}`,
      };
    }
    case "code":
      return {
        icon: "Code",
        verb: "运行代码",
        target: stringField(input, "description") ?? firstLine(stringField(input, "code")) ?? "run_code",
      };
    default:
      return { icon: "Wrench", verb: data.name, target: "" };
  }
}

function statusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "failed") return "失败";
  if (status === "canceled") return "已取消";
  return "完成";
}

function statusColor(status: string, theme: Theme): string {
  if (status === "failed") return theme.colors.statusDanger;
  if (status === "running") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

function detailBody(data: ToolData): string | undefined {
  const detail = data.detail;
  if (detail === undefined) return undefined;
  const type = stringField(detail, "type");
  const input = isRecord(detail.input) ? detail.input : undefined;
  const parts: string[] = [];
  switch (type) {
    case "shell": {
      const command = stringField(detail, "command");
      if (command !== undefined) parts.push(`$ ${command}`);
      const output = stringField(detail, "output");
      if (output !== undefined) parts.push(output);
      break;
    }
    case "read": {
      const path = stringField(detail, "filePath");
      if (path !== undefined) parts.push(path);
      const content = stringField(detail, "content");
      if (content !== undefined) parts.push(content);
      break;
    }
    case "write":
    case "edit": {
      const path = stringField(detail, "filePath");
      if (path !== undefined) parts.push(path);
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
      const url = stringField(detail, "url");
      if (url !== undefined) parts.push(url);
      const result = stringField(detail, "result");
      if (result !== undefined) parts.push(result);
      break;
    }
    default: {
      if (input !== undefined) parts.push(JSON.stringify(input, null, 2));
      const output = detail.output;
      if (typeof output === "string") parts.push(output);
      else if (output !== undefined) parts.push(JSON.stringify(output, null, 2));
    }
  }
  const text = parts.join("\n\n").trim();
  return text === "" ? undefined : text.length > 12000 ? `${text.slice(0, 12000)}\n…` : text;
}

function ToolRow({ item, theme }: PluginTimelineItemProps<ToolData>) {
  const [expanded, setExpanded] = useState(false);
  const data = item.data;
  const look = useMemo(() => toolLook(data), [data]);
  const body = useMemo(() => detailBody(data), [data]);
  const failed = data.status === "failed";
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${look.verb}${look.target === "" ? "" : ` ${look.target}`}`}
        onPress={toggle}
        style={styles.row}
      >
        <Icon name={look.icon} size={14} color={failed ? theme.colors.statusDanger : theme.colors.foregroundMuted} />
        <Text style={[styles.verb, { color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted }]}>
          {look.verb}
        </Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {look.target}
        </Text>
        <Text style={[styles.meta, { color: statusColor(data.status, theme) }]}>
          {statusLabel(data.status)}
        </Text>
        {body === undefined ? null : (
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
      {expanded && body !== undefined ? (
        <ScrollView style={[styles.body, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }]}>
          <Text selectable style={[styles.bodyText, { color: theme.colors.foreground, fontFamily: MONO }]}>{body}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

export function contributeTimeline(client: PluginClientContext): () => void {
  const cleanups = [
    client.addTimelineTransformer({
      id: "dsh-reasoning-row",
      query: { itemType: "reasoning" },
      transform({ item, phase }) {
        if (item.type !== "reasoning" || item.text.trim() === "") return undefined;
        return {
          items: [{
            type: "plugin" as const,
            kind: "dsh-reasoning",
            version: 1,
            data: { text: item.text, phase },
          }],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: "dsh-reasoning",
      version: 1,
      schema: reasoningSchema,
      Component: ReasoningRow,
    }),
    client.addTimelineTransformer({
      id: "dsh-tool-row",
      query: { itemType: "tool_call" },
      transform({ item, phase }) {
        if (item.type !== "tool_call") return undefined;
        const detail = isRecord(item.detail) ? item.detail : undefined;
        const type = stringField(detail, "type");
        const owned = item.name === "run_code"
          || item.name.startsWith("mcp__")
          || type === "shell"
          || type === "read"
          || type === "write"
          || type === "edit"
          || type === "search"
          || type === "fetch";
        if (!owned) return undefined;
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
      },
    }),
    client.addTimelineRenderer({
      kind: "dsh-tool",
      version: 1,
      schema: toolSchema,
      Component: ToolRow,
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
    paddingVertical: 4,
    paddingHorizontal: 2,
    minHeight: 26,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  verb: { fontSize: 12, fontWeight: "600" },
  target: { flex: 1, minWidth: 0, fontSize: 12 },
  meta: { fontSize: 11 },
  body: {
    maxHeight: 320,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 2,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bodyText: { fontSize: 12, lineHeight: 18 },
} as const;
