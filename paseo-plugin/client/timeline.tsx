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
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
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

function DetailSheet({
  open,
  onClose,
  title,
  icon,
  mark,
  theme,
  scrollRef,
  onContentSizeChange,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon: string;
  mark?: string;
  theme: Theme;
  scrollRef?: React.RefObject<any>;
  onContentSizeChange?: () => void;
  children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="关闭" />
        <View
          style={[
            styles.sheet,
            {
              maxHeight: Math.max(240, Math.round(height * 0.78)),
              backgroundColor: sheetBackground(theme),
              borderColor: theme.colors.border,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: theme.colors.border }]} />
          <View style={styles.sheetHeader}>
            <View style={styles.lead}>
              {mark === undefined ? (
                <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
              ) : (
                <View style={[styles.mark, { borderColor: theme.colors.border }]}>
                  <Text style={[styles.markText, { color: theme.colors.foregroundMuted }]}>{mark}</Text>
                </View>
              )}
            </View>
            <Text numberOfLines={1} style={[styles.sheetTitle, { color: theme.colors.foreground }]}>{title}</Text>
            <Pressable onPress={onClose} accessibilityLabel="关闭" hitSlop={8}>
              <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <ScrollView
            ref={scrollRef}
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetContent}
            onContentSizeChange={onContentSizeChange}
            showsVerticalScrollIndicator
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ReasoningRow({ item, theme }: PluginTimelineItemProps<ReasoningData>) {
  const streaming = item.data.phase === "streaming";
  const [open, setOpen] = useState(false);
  const text = item.data.text;
  const preview = streaming ? lastSentence(text) || "思考中…" : firstSentence(text) || "已思考";
  const revealed = usePacedText(text, streaming && open);
  const body = useRef<any>(null);

  useEffect(() => {
    if (open && streaming) body.current?.scrollToEnd?.({ animated: false });
  }, [open, streaming, revealed]);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={streaming ? "思考中" : "已思考"}
        onPress={() => setOpen(true)}
        style={styles.row}
      >
        <View style={styles.lead}>
          <Icon name="Brain" size={14} color={streaming ? theme.colors.accent : theme.colors.foregroundMuted} />
        </View>
        <Text style={[styles.verb, { color: theme.colors.foregroundMuted }]}>思考</Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {preview}
        </Text>
        <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
      <DetailSheet
        open={open}
        onClose={() => setOpen(false)}
        title="思考"
        icon="Brain"
        theme={theme}
        scrollRef={body}
        onContentSizeChange={() => {
          if (streaming) body.current?.scrollToEnd?.({ animated: false });
        }}
      >
        <Text selectable style={[styles.bodyText, { color: theme.colors.foreground }]}>{revealed}</Text>
      </DetailSheet>
    </View>
  );
}

type ToolKind = "shell" | "read" | "write" | "edit" | "search" | "fetch" | "mcp" | "code" | "other";

interface ToolLook {
  icon: string;
  verb: string;
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
    case "shell": {
      const command = stringField(detail, "command");
      const program = shellProgram(command);
      const mark = program === undefined ? undefined : PROGRAM_MARKS[program];
      return {
        icon: "SquareTerminal",
        verb: "命令",
        target: firstLine(command) ?? data.name,
        ...(mark === undefined ? {} : { mark }),
      };
    }
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

function readContent(content: string): string {
  const match = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(content);
  const body = match?.[1] ?? content;
  return body
    .replace(/^\s*\d+:\s?/gm, "")
    .replace(/\(End of file[^)]*\)\s*$/m, "")
    .trim();
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
      const content = stringField(detail, "content");
      if (content !== undefined) parts.push(readContent(content));
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
  const [open, setOpen] = useState(false);
  const data = item.data;
  const look = useMemo(() => toolLook(data), [data]);
  const body = useMemo(() => detailBody(data), [data]);
  const failed = data.status === "failed";
  const openSheet = useCallback(() => {
    if (body !== undefined) setOpen(true);
  }, [body]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${look.verb}${look.target === "" ? "" : ` ${look.target}`}`}
        onPress={openSheet}
        style={styles.row}
      >
        <View style={styles.lead}>
          {look.mark === undefined ? (
            <Icon name={look.icon} size={14} color={failed ? theme.colors.statusDanger : theme.colors.foregroundMuted} />
          ) : (
            <View style={[styles.mark, { borderColor: theme.colors.border }]}>
              <Text style={[styles.markText, { color: theme.colors.foregroundMuted }]}>{look.mark}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.verb, { color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted }]}>
          {look.verb}
        </Text>
        <Text numberOfLines={1} style={[styles.target, { color: theme.colors.foregroundMuted }]}>
          {look.target}
        </Text>
        {data.status === "completed" ? null : (
          <Text style={[styles.meta, { color: statusColor(data.status, theme) }]}>
            {statusLabel(data.status)}
          </Text>
        )}
        {body === undefined ? null : (
          <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
      <DetailSheet
        open={open}
        onClose={() => setOpen(false)}
        title={`${look.verb}${look.target === "" ? "" : ` ${look.target}`}`}
        icon={look.icon}
        mark={look.mark}
        theme={theme}
      >
        {body === undefined ? null : (
          <Text selectable style={[styles.bodyText, styles.mono, { color: theme.colors.foreground }]}>{body}</Text>
        )}
      </DetailSheet>
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
    paddingVertical: 2,
    paddingHorizontal: 2,
    minHeight: 24,
    marginVertical: -3,
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
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingBottom: 12,
    overflow: "hidden",
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: "center", marginTop: 8, marginBottom: 4 },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  sheetTitle: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "600" },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 24, paddingTop: 4 },
} as const;
