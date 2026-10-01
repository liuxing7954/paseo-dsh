/**
 * DSH session events -> Paseo timeline items.
 *
 * DSH publishes complete message snapshots (`assistant/message`, `tool/call`,
 * `tool/result`) rather than text deltas, and Paseo derives its own live delta
 * from a stable item id. Re-emitting an id therefore updates a row in place.
 *
 * @module dsh-paseo/server/timeline
 */
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

interface DshEvent {
  type: string;
  seq?: number;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { value: raw };
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Map one DSH tool call onto the richest Paseo tool detail available. */
function toolDetail(name: string, input: Record<string, unknown>, output?: string): ProviderToolCallDetail {
  const filePath = stringField(input, "file_path") ?? stringField(input, "filePath");
  switch (name) {
    case "bash":
    case "pwsh": {
      const command = stringField(input, "command") ?? "";
      const exitCode = typeof input.exit_code === "number" ? input.exit_code : undefined;
      return {
        type: "shell",
        command,
        ...(stringField(input, "cwd") === undefined ? {} : { cwd: stringField(input, "cwd") as string }),
        ...(output === undefined ? {} : { output }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "read":
      return {
        type: "read",
        filePath: filePath ?? "",
        ...(output === undefined ? {} : { content: output }),
        ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      };
    case "write":
      return {
        type: "write",
        filePath: filePath ?? "",
        ...(typeof input.content === "string" ? { content: input.content } : {}),
      };
    case "edit":
      return {
        type: "edit",
        filePath: filePath ?? "",
        ...(typeof input.old_string === "string" ? { oldString: input.old_string } : {}),
        ...(typeof input.new_string === "string" ? { newString: input.new_string } : {}),
      };
    case "grep":
    case "glob":
    case "web_search":
      return {
        type: "search",
        query:
          stringField(input, "pattern") ??
          stringField(input, "query") ??
          stringField(input, "path") ??
          "",
        toolName: name === "web_search" ? "web_search" : name,
        ...(output === undefined ? {} : { content: output }),
      };
    case "web_fetch":
      return {
        type: "fetch",
        url: stringField(input, "url") ?? "",
        ...(output === undefined ? {} : { result: output }),
      };
    case "todo_write":
      return { type: "plain_text", label: "Update tasks", icon: "sparkles" };
    case "ask_user_question":
      return { type: "plain_text", label: "Asked the user", icon: "sparkles" };
    case "exit_plan_mode":
      // Paseo renders this as the readable plan card, and its own Codex adapter
      // emits the same item next to the approval buttons. The plan has to be
      // visible *before* the choice, so this is the copy that carries it.
      return { type: "plan", text: stringField(input, "plan") ?? "" };
    case "subagent":
      return {
        type: "sub_agent",
        ...(stringField(input, "description") === undefined
          ? {}
          : { description: stringField(input, "description") as string }),
        log: output ?? "",
      };
    default:
      return {
        type: "unknown",
        input: input as unknown as JsonValue,
        output: (output ?? null) as JsonValue,
      };
  }
}

/** Extract `todo_write` items into Paseo's native todo row. */
function todoItems(input: Record<string, unknown>): Array<{ text: string; completed: boolean }> | null {
  const raw = input.todos;
  if (!Array.isArray(raw)) return null;
  const items = raw
    .filter(isRecord)
    .map((todo) => ({
      text:
        stringField(todo, "content") ?? stringField(todo, "text") ?? stringField(todo, "activeForm") ?? "",
      completed: todo.status === "completed",
    }))
    .filter((todo) => todo.text !== "");
  return items.length === 0 ? null : items;
}

export class TimelineBuilder {
  #items = new Map<string, ProviderTimelineItem>();
  #toolNames = new Map<string, string>();
  #toolInputs = new Map<string, Record<string, unknown>>();

  /**
   * Fold one DSH session event into zero or more complete Paseo item snapshots.
   *
   * The wire envelope is `{ type, seq, time, data }`, so every handler reads the
   * `data` payload rather than the envelope itself.
   */
  consume(event: DshEvent): ProviderTimelineItem[] {
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "assistant/message":
        return this.#assistantMessage(data);
      case "tool/call":
        return this.#toolCall(data);
      case "tool/result":
        return this.#toolResult(data);
      case "turn/end":
        return this.#turnEnd(data);
      default:
        return [];
    }
  }

  #put(item: ProviderTimelineItem): ProviderTimelineItem[] {
    this.#items.set(item.id, item);
    return [item];
  }

  #assistantMessage(data: Record<string, unknown>): ProviderTimelineItem[] {
    const message = isRecord(data.message) ? data.message : undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const turn = typeof data.turn === "number" ? data.turn : 0;
    const step = typeof data.step === "number" ? data.step : 0;
    const out: ProviderTimelineItem[] = [];

    const reasoning = content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "reasoning")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter((text) => text !== "")
      .join("\n");
    if (reasoning !== "") {
      out.push(
        ...this.#put({
          type: "reasoning",
          id: `reasoning:${turn}:${step}`,
          text: reasoning,
        }),
      );
    }

    const text = textOf(content);
    if (text !== "") {
      out.push(
        ...this.#put({
          type: "assistant_message",
          id: `assistant:${turn}:${step}`,
          text,
          ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
        }),
      );
    }

    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool-call") continue;
      const callId = stringField(block, "id") ?? `tool:${turn}:${step}`;
      const name = stringField(block, "name") ?? "tool";
      const input = parseArguments(block.arguments);
      this.#toolNames.set(callId, name);
      this.#toolInputs.set(callId, input);
      out.push(...this.#emitToolCall(callId, name, input, "running"));
    }
    return out;
  }

  #toolCall(data: Record<string, unknown>): ProviderTimelineItem[] {
    const callId = stringField(data, "callId");
    if (callId === undefined) return [];
    const name = stringField(data, "name") ?? "tool";
    const input = parseArguments(data.arguments);
    this.#toolNames.set(callId, name);
    this.#toolInputs.set(callId, input);
    const previous = this.#items.get(`tool:${callId}`);
    const status = previous !== undefined && previous.type === "tool_call" ? previous.status : "running";
    return this.#emitToolCall(callId, name, input, status === "running" ? "running" : status);
  }

  #toolResult(data: Record<string, unknown>): ProviderTimelineItem[] {
    const message = isRecord(data.message) ? data.message : undefined;
    const callId = stringField(data, "toolCallId") ?? (message === undefined ? undefined : stringField(message, "toolCallId"));
    if (callId === undefined) return [];
    const name = this.#toolNames.get(callId) ?? "tool";
    const input = this.#toolInputs.get(callId) ?? {};
    const output = message === undefined ? "" : textOf(message.content);
    const failed = message?.isError === true;

    const out: ProviderTimelineItem[] = [];
    if (name === "todo_write" && !failed) {
      const items = todoItems(input);
      if (items !== null) {
        out.push(...this.#put({ type: "todo", id: `todo:${callId}`, items }));
      }
    }
    out.push(
      ...this.#put({
        type: "tool_call",
        id: `tool:${callId}`,
        callId,
        name,
        detail: toolDetail(name, input, output === "" ? undefined : output),
        ...(failed
          ? { status: "failed" as const, error: { message: output || "tool failed" } }
          : { status: "completed" as const, error: null }),
      }),
    );
    return out;
  }

  #turnEnd(data: Record<string, unknown>): ProviderTimelineItem[] {
    const reason = isRecord(data.reason) ? data.reason : undefined;
    if (reason?.kind !== "error" && reason?.kind !== "failed") return [];
    const error = isRecord(reason.error) ? reason.error : undefined;
    const message =
      (error === undefined ? undefined : stringField(error, "message")) ?? "The turn failed.";
    const turn = typeof data.turn === "number" ? data.turn : 0;
    return this.#put({ type: "error", id: `error:${turn}`, message });
  }

  #emitToolCall(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    status: "running" | "completed" | "failed" | "canceled",
  ): ProviderTimelineItem[] {
    const item: ProviderTimelineItem = {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      detail: toolDetail(name, input),
      ...(status === "failed"
        ? { status: "failed" as const, error: { message: "tool failed" } }
        : { status, error: null }),
    };
    return this.#put(item);
  }
}
