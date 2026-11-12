/**
 * One Paseo agent session backed by one `dsh --profile paseo` process.
 *
 * The session translates between Paseo's provider vocabulary (models, modes,
 * thinking options, permission cards) and the bridge's JSON-RPC surface.
 *
 * @module dsh-paseo/server/session
 */
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderContent,
  ProviderEvent,
  ProviderMode,
  ProviderModel,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPrompt,
  ProviderSetting,
  ProviderThinkingOption,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./json-value";
import {
  DshProcess,
  type DshAnswer,
  type DshQuestion,
  type DshQuestionRequest,
  type DshAssistantFrame,
  type DshRoute,
  type DshSessionEvent,
  type DshStatusEvent,
  type DshUsage,
} from "./dsh-process";
import { TimelineBuilder } from "./timeline";

/** Modes Paseo offers in the composer. `plan` drives DSH's plan-mode service. */
export const MODES: ProviderMode[] = [
  { id: "build", label: "Build", description: "Investigate and implement changes directly." },
  {
    id: "plan",
    label: "Plan",
    description: "Investigate, then submit a plan for approval before implementing.",
  },
];

export interface DshSessionOptions {
  sessionId: string;
  /**
   * DSH's own session id. Equal to {@link sessionId} for a Paseo-created
   * session; different when a session is imported, where Paseo mints a new id
   * but DSH keeps the native one.
   */
  dshSessionId?: string;
  cwd: string;
  env: Record<string, string>;
  route: DshRoute;
  mode: string;
  /**
   * Agent preset this session should be created under. Applied inside `open()`,
   * before `initialize`, so the agent is composed with it — the only moment DSH
   * both accepts the choice and writes it into the session header.
   */
  initialPreset?: string;
  /** Models Paseo can switch to for this session, from the cached catalog. */
  models: ProviderModel[];
  /** Thinking options the catalog advertises. */
  thinkingOptions: ProviderThinkingOption[];
  /**
   * Capabilities negotiated for the parent session. Child sessions opened by
   * DSH subagents must advertise the same set so Paseo accepts them.
   */
  capabilities: readonly string[];
  emit(event: ProviderEvent): void;
  log(line: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Tool-call arguments arrive as a JSON string in the durable session log. */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Concatenate the text blocks of a DSH message's content. */
function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
}

/** Resolve Paseo's catalog id (`provider/model`) back into a DSH route. */
export function parseRoute(model: string | undefined, fallback: DshRoute): DshRoute {
  if (model === undefined || model === "") return fallback;
  const slash = model.indexOf("/");
  if (slash <= 0) return { ...fallback, model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/** One DSH subagent child session observed through the bridge. */
interface ChildSessionState {
  id: string;
  timeline: TimelineBuilder;
  cwd: string;
  title?: string;
  /** Parent tool call that spawned this child, once its result reveals it. */
  toolCallId?: string;
  opened: boolean;
  turnId: string | null;
  /** A terminal turn state was already reported for the current turn. */
  finished: boolean;
  /** Events seen before Paseo accepted the child session. */
  pending: Array<{ kind: "event"; payload: DshSessionEvent } | { kind: "status"; status: string }>;
  openTimer?: ReturnType<typeof setTimeout>;
}

export class DshSession {
  readonly id: string;
  /** DSH's session id (see {@link DshSessionOptions.dshSessionId}). */
  #dshSessionId: string;
  /** Previous session ids whose buffered events may still arrive after a rewind. */
  #retiredSessionIds = new Set<string>();
  readonly #options: DshSessionOptions;
  readonly #timeline = new TimelineBuilder();
  /** DSH subagent child sessions, keyed by their own DSH session id. */
  #children = new Map<string, ChildSessionState>();
  /** Parent subagent tool calls waiting for their `started subagent <id>` result. */
  #pendingSubagentCalls = new Map<string, { description?: string }>();
  /**
   * Prompts whose user message had no durable seq when the bridge accepted it.
   * The seq arrives later as a session event; the same row is re-emitted then
   * so a message queued behind a long turn still becomes rewindable.
   */
  #pendingUserMessages = new Map<string, { clientMessageId: string; text: string }>();
  /** User events that arrived before their prompt response carried a seq. */
  #recentUserMessageSeqs = new Map<string, number>();
  #childTurnSeq = 0;
  #warnedNoSubsession = false;
  #process: DshProcess | undefined;
  #route: DshRoute;
  #mode: string;
  #thinkingOption: string | undefined;
  #turnId: string | null = null;
  #replaySeq = 0;
  /**
   * Live text accumulated from DSH's transient assistant-stream frames. The
   * durable log only carries one complete message per step, so this is what
   * makes the answer appear while the model is still writing it.
   */
  /** Session totals shown in the collapsed stats line. */
  #totals = { input: 0, cache: 0, cacheWrite: 0, output: 0 };
  #seenTurns = new Set<number>();
  #seenSteps = new Set<string>();
  /** Tool call start times and the current turn's tool total. */
  #toolStarts = new Map<string, number>();
  #turnTool = { count: 0, ms: 0 };
  /**
   * Whether the running turn was stopped by the user. A cancelled turn may not
   * get the completed-turn footer that the stats row is pulled into, so it
   * keeps the default spacing instead of risking an overlap.
   */
  #turnInterrupted = false;
  /**
   * Whether the stats row is the newest timeline item. If tools arrive after
   * it, the completed-turn footer belongs to the end of the turn rather than
   * directly above this row, so the row must keep the default spacing.
   */
  #statsIsTail = false;
  /** Most recent stats row, so context and tool totals can update it in place. */
  #lastStats: { id: string; data: Record<string, unknown> } | undefined;
  /** Per-step timing for the streamed-stats row. */
  #streamStats:
    | {
        turn: number;
        step: number;
        startedAt: number;
        firstTokenAt?: number;
        lastTokenAt?: number;
        endedAt?: number;
      }
    | undefined;
  #live:
    | {
        attemptId: string;
        turn: number;
        step: number;
        text: string;
        emitted: string;
        reasoning: string;
        emittedReasoning: string;
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    | undefined;
  #pendingPermissions = new Map<string, (response: ProviderPermissionResponse) => void>();
  /** Slash-menu entries by name, tagging why each exists. */
  #commandKinds = new Map<string, "command" | "skill">();
  /** Current DSH permission preset name, and the ones it can switch to. */
  #permission: string | null = null;
  #permissionPresets: string[] = [];
  /** DSH's display name for each preset value, when the bridge reports one. */
  #permissionLabels = new Map<string, string>();
  /** Current agent preset (persona + capabilities), and the switchable ones. */
  #preset: string | null = null;
  #presetOptions: Array<{ label: string; value: string }> = [];
  /**
   * The preset the user picked, kept until DSH confirms it. Paseo can send the
   * pick while the session is still opening, when the agent either does not
   * exist yet or was just created under the profile default; applying it again
   * before the first prompt is the last moment DSH accepts the switch.
   */
  #desiredPreset: string | null = null;
  #presetPending = false;
  /**
   * Last usage snapshot published to Paseo. Paseo replaces its whole usage
   * record on every `session.usage`, so token counts and context occupancy must
   * always travel together; this is the complete picture they are merged into.
   */
  #lastUsage: ProviderUsage | undefined;
  /** Newest issued occupancy poll; a slower older response must not win. */
  #usageGeneration = 0;
  #usageRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: DshSessionOptions) {
    this.id = options.sessionId;
    this.#dshSessionId = options.dshSessionId ?? options.sessionId;
    this.#options = options;
    this.#route = options.route;
    this.#mode = options.mode === "plan" ? "plan" : "build";
    this.#thinkingOption = options.route.reasoningEffort;
  }

  /** Spawn the process, pin the route, and reconcile the requested mode. */
  async open(): Promise<void> {
    const process = new DshProcess({
      cwd: this.#options.cwd,
      route: this.#route,
      sessionId: this.#dshSessionId,
      ...(this.#options.initialPreset === undefined ? {} : { preset: this.#options.initialPreset }),
      env: this.#options.env,
      onEvent: (payload) => this.#onSessionEvent(payload),
      onAssistantStream: (frame) => this.#onAssistantStream(frame),
      onStatus: (payload) => this.#onStatus(payload),
      onQuestion: (request) => this.#onQuestion(request),
      onLog: (line) => this.#options.log(line),
      onExit: (code, signal) => {
        if (this.#closed) return;
        this.#closed = true;
        clearTimeout(this.#usageRefreshTimer);
        // A dead runtime must not keep writing more of the answer; the failure
        // below is the last word on this session.
        this.#clearLive();
        this.#options.emit({
          type: "session.runtime_failed",
          sessionId: this.id,
          error: { message: `DeepSeek Harness exited (code ${code ?? "null"}, signal ${signal ?? "none"})` },
        });
      },
      onProtocolError: (message) => this.#options.log(`protocol: ${message}`),
    });
    this.#process = process;
    await process.start();
    if (this.#mode === "plan") {
      await process.setPlan(true);
    }
    // Occupancy is published later, after the agent exists: measuring it here
    // creates the agent, and the preset this session was opened under has not
    // been applied yet, so the session would be composed as the profile default.
  }

  /** The committed configuration Paseo renders in the composer. */
  configState(): ProviderConfigState {
    const settings: ProviderSetting[] = [];
    // The agent preset is a creation-time persona + capability set. Paseo still
    // renders it as a normal select, but DSH locks the choice once the session's
    // first turn starts, so switching it later is rejected and snaps back.
    if (this.#presetOptions.length > 0) {
      settings.push({
        type: "select",
        id: "preset",
        label: "Preset",
        description: "DSH agent preset — persona and capabilities. Fixed once the session starts.",
        value: this.#preset,
        options: this.#presetOptions,
      });
    }
    // Surface DSH's permission presets as a composer control, so switching
    // between sandboxed and full access doesn't require typing /permission.
    if (this.#permissionPresets.length > 0) {
      settings.push({
        type: "select",
        id: "permission",
        label: "Permissions",
        description: "DSH sandbox + approval preset for this session.",
        value: this.#permission,
        options: this.#permissionPresets.map((name) => ({
          label: permissionPresetLabel(name, this.#permissionLabels.get(name)),
          value: name,
        })),
      });
    }
    const thinkingOptions = this.#thinking();
    return {
      model: `${this.#route.provider}/${this.#route.model}`,
      mode: this.#mode,
      ...(this.#thinkingOption === undefined ? {} : { thinkingOption: this.#thinkingOption }),
      models: this.#models(),
      modes: MODES,
      thinkingOptions,
      settings,
    };
  }

  #models(): ProviderModel[] {
    return this.#options.models;
  }

  /**
   * The current model's own thinking options. Reporting a global fallback made
   * the composer offer efforts the model cannot serve, and every dropped choice
   * snapped the selector back to off.
   */
  #thinking(): ProviderThinkingOption[] {
    const id = `${this.#route.provider}/${this.#route.model}`;
    return this.#options.models.find((entry) => entry.id === id)?.thinkingOptions ?? [];
  }

  /** Thinking-effort ids the current model actually declares; empty means none. */
  #supportedEfforts(): string[] {
    return this.#thinking().map((option) => option.id);
  }

  /**
   * Publish the session's `/` menu: DSH's registered human commands plus every
   * user-invocable skill.
   *
   * Both appear in the composer's slash menu, but they run differently, so the
   * kind is remembered for {@link prompt}: a command executes in the runtime, a
   * skill rides a `/name` user message.
   */
  async loadCommands(): Promise<void> {
    const commands = await this.#require().commands();
    this.#commandKinds.clear();
    for (const command of commands) this.#commandKinds.set(command.name, command.kind);
    this.#options.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      })),
    });
  }

  /** Read the current permission preset and the switchable ones, for the composer. */
  async loadPermission(): Promise<void> {
    const permission = await this.#require().permission();
    if (!permission.available) return;
    this.#permission = permission.current;
    this.#permissionPresets = permission.presets;
    this.#permissionLabels = new Map(
      (permission.presetDetails ?? []).map((preset) => [preset.value, preset.name]),
    );
  }

  /**
   * Read the agent presets the profile declares, for the composer. Optional: a
   * profile that mounts no preset registry simply gets no Preset control.
   */
  async loadPresets(): Promise<void> {
    const info = await this.#require().presets();
    if (!info.available) return;
    this.#preset = info.current ?? info.default;
    // A preset whose plugins failed to mount can still be listed. Mark it so the
    // composer does not offer it as a working choice: selecting it would be
    // rejected and silently snap back to the current preset.
    this.#presetOptions = info.presets.map((preset) => ({
      value: preset.id,
      label: `${preset.name ?? preset.id}${preset.broken === undefined ? "" : "（不可用）"}`,
    }));
  }

  /**
   * Refresh the context-occupancy half of the usage readout from the runtime.
   *
   * DSH measures occupancy on demand by replaying the session log through its
   * token meter, so it is polled where it can change: when a session opens or
   * resumes, at the end of a turn, on a model switch, and after a compaction.
   * Only the newest in-flight poll may publish, so a slow answer from a previous
   * model, or one arriving after the session closed, cannot overwrite fresher
   * numbers. Unknown fields are omitted rather than defaulted.
   */
  async refreshUsage(): Promise<void> {
    if (this.#closed) return;
    clearTimeout(this.#usageRefreshTimer);
    this.#usageRefreshTimer = undefined;
    const process = this.#process;
    if (process === undefined) return;
    const generation = ++this.#usageGeneration;
    let snapshot: DshUsage;
    try {
      snapshot = await process.usage();
    } catch (error) {
      if (this.#closed || generation !== this.#usageGeneration) return;
      this.#options.log(`usage query failed: ${messageOf(error)}`);
      snapshot = { available: false };
    }
    if (this.#closed || generation !== this.#usageGeneration) return;
    const patch: ProviderUsage = {
      ...(snapshot.available &&
      typeof snapshot.contextWindow === "number" &&
      Number.isSafeInteger(snapshot.contextWindow) &&
      snapshot.contextWindow > 0
        ? { contextWindowMaxTokens: snapshot.contextWindow }
        : {}),
      ...(snapshot.available &&
      typeof snapshot.usedTokens === "number" &&
      Number.isSafeInteger(snapshot.usedTokens) &&
      snapshot.usedTokens >= 0
        ? { contextWindowUsedTokens: snapshot.usedTokens }
        : {}),
    };
    // A complete context snapshot: absence clears a formerly known value instead
    // of keeping another model's capacity or a stale numerator.
    this.#emitUsage(patch, true);
    const row = this.#lastStats;
    if (row !== undefined) {
      row.data = { ...row.data, ...this.#contextFields() };
      this.#emitStatsRow();
    }
  }

  /** Coalesce step/tool updates so occupancy is not measured per streamed token. */
  #queueUsageRefresh(): void {
    if (this.#closed) return;
    this.#usageGeneration += 1;
    if (this.#usageRefreshTimer !== undefined) return;
    this.#usageRefreshTimer = setTimeout(() => {
      this.#usageRefreshTimer = undefined;
      void this.refreshUsage();
    }, 75);
  }

  /**
   * Replay a stored session's conversation into the Paseo timeline.
   *
   * Paseo asks for this (`history: "replay"`) when it reopens a session — after
   * a restart, or when importing a native DSH session. DSH's resume restores the
   * model's context but never re-emits the events, so without this the reopened
   * session would show an empty conversation. Only real user turns are replayed
   * as user messages; DSH's injected context (skill catalogs, runtime snapshots,
   * approval notices) carries a different `source.kind` and is skipped.
   */
  async replayHistory(): Promise<void> {
    const events = await this.#require().history();
    if (events.length === 0) return;
    const builder = new TimelineBuilder();
    for (const event of events) {
      const data = isRecord(event.data) ? event.data : {};
      const seq = typeof event.seq === "number" ? event.seq : this.#replaySeq++;
      // Seed the session totals so a resumed agent keeps its 轮/步/token line.
      if (event.type === "assistant/message") this.#accumulateTotals(data);
      if (event.type === "user/message") {
        const source = isRecord(data.source) ? data.source : {};
        if (source.kind !== "user") continue;
        const text = textBlocks(data.content);
        if (text === "") continue;
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: {
            type: "user_message",
            id: `user:history:${seq}`,
            text,
            clientMessageId: `history:${seq}`,
            // Paseo turns this into the provider token it sends back on rewind.
            // The seq is durable: the stored log is replayed with the same
            // numbering after a restart.
            revertToken: { seq },
          },
        });
        continue;
      }
      for (const item of builder.consume({ type: event.type, seq, data })) {
        this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
      }
    }
  }

  /** Accept one prompt and start its turn. */
  async prompt(prompt: ProviderPrompt): Promise<void> {
    // A user turn must not start with the previous answer's live buffer still
    // attached; flush it so the two turns cannot interleave.
    this.#flushLive();
    this.#clearLive();
    const process = this.#require();

    // Last chance to land a preset that arrived while the session was opening:
    // DSH locks the choice once this turn starts.
    if (this.#presetPending && this.#desiredPreset !== null) {
      const requested = this.#desiredPreset;
      this.#desiredPreset = null;
      this.#presetPending = false;
      try {
        const applied = await process.setConfig({ preset: requested });
        this.#preset = applied.preset ?? requested;
      } catch (error) {
        const message = messageOf(error);
        this.#options.log(`preset "${requested}" could not be applied: ${message}`);
        this.#emitItem({
          type: "notification",
          id: `preset-error:${Date.now()}`,
          level: "error",
          message: `切换预设失败：${message}`,
        });
      }
    }

    // A slash-menu pick arrives as a command, not a message. DSH commands and
    // skills share the menu but not the execution path, so branch on the kind
    // the catalog recorded rather than on the name.
    if (prompt.input.type === "command") {
      const args = prompt.input.arguments ?? "";
      const line = args.trim() === "" ? `/${prompt.input.name}` : `/${prompt.input.name} ${args}`;
      // A command message has no DSH user event of its own. Anchor it at the
      // current end of the log so rewinding it removes everything the command
      // did, just like rewinding a normal message removes its turn. Read the
      // boundary before publishing the row so the message is rewindable from
      // its first appearance.
      let boundary: number | undefined;
      try {
        boundary = await process.currentSeq();
      } catch (error) {
        this.#options.log(`command boundary unavailable: ${messageOf(error)}`);
      }
      this.#emitUserMessage(
        prompt.clientMessageId,
        line,
        boundary === undefined ? undefined : { seq: boundary },
      );

      if (this.#commandKinds.get(prompt.input.name) === "command") {
        try {
          const result = await process.runCommand(prompt.input.name, args);
          if (result.kind === "error") throw new Error(result.text ?? `/${prompt.input.name} failed`);
        } catch (error) {
          this.#emitPromptFailed(prompt.clientMessageId, error);
          return;
        }
        // A command answers with its own timeline items rather than a turn.
        this.#options.emit({
          type: "session.prompt_result",
          sessionId: this.id,
          clientMessageId: prompt.clientMessageId,
          result: { type: "completed" },
        });
        return;
      }

      // A skill (or an unrecognized name): hand DSH the bare `/name` line. Its
      // skill tool injects a user-invocable skill from exactly that token.
      try {
        const result = await process.prompt(line, [{ type: "text", text: line }], prompt.delivery);
        this.#emitPromptAccepted(prompt.clientMessageId);
        this.#emitRewindToken(prompt.clientMessageId, line, result.seq);
      } catch (error) {
        this.#emitPromptFailed(prompt.clientMessageId, error);
        return;
      }
      return;
    }

    // Paseo and the bridge already agree on the text/image block shape, so those
    // blocks ride through untouched. Every other attachment becomes a text
    // reference: a block with no DSH counterpart used to throw *outside* this
    // try, which turned one unsupported file into `session.runtime_failed` and
    // killed the whole session ("stale after its plugin reloaded" on retry).
    let acceptedSeq: number | undefined;
    let acceptedText = "";
    let optimistic = false;
    try {
      const blocks = prompt.input.content.map(toDshContent);
      const label = blocks
        .map((block) => (block.type === "text" ? (block.text as string) : ""))
        .filter((text) => text !== "")
        .join("\n");
      acceptedText = label;

      // An idle auto prompt can wait for DSH to append the durable user event,
      // so publish the row once with its rewind token instead of publishing it
      // twice. Steer and mid-turn prompts must stay optimistic: their user event
      // may only arrive in a later turn, so show the row now and attach the token
      // when the event (or the bridge response) supplies the seq.
      optimistic = prompt.delivery === "steer" || this.#turnId !== null;
      if (optimistic) this.#emitUserMessage(prompt.clientMessageId, label);

      const result = await process.prompt(
        label,
        blocks.length === 0 ? undefined : blocks,
        prompt.delivery,
      );
      acceptedSeq = result.seq;
      if (!optimistic) {
        this.#emitUserMessage(
          prompt.clientMessageId,
          label,
          acceptedSeq === undefined ? undefined : { seq: acceptedSeq },
        );
      }
      if (acceptedSeq === undefined && result.messageId !== undefined) {
        const seenSeq = this.#recentUserMessageSeqs.get(result.messageId);
        if (seenSeq !== undefined) {
          this.#recentUserMessageSeqs.delete(result.messageId);
          this.#emitRewindToken(prompt.clientMessageId, label, seenSeq);
        } else {
          this.#pendingUserMessages.set(result.messageId, {
            clientMessageId: prompt.clientMessageId,
            text: label,
          });
        }
      }
    } catch (error) {
      // The optimistic paths already published the row. Keep the idle path's
      // previous behaviour too: a rejected prompt still shows the text that
      // failed, next to the failure card.
      if (!optimistic && acceptedText !== "") {
        this.#emitUserMessage(prompt.clientMessageId, acceptedText);
      }
      this.#emitPromptFailed(prompt.clientMessageId, error);
      return;
    }

    this.#emitPromptAccepted(prompt.clientMessageId);
    // A steer message was already published optimistically; re-emit the same
    // id and text so Paseo records the token without adding a second row.
    if (optimistic && acceptedSeq !== undefined) {
      this.#emitRewindToken(prompt.clientMessageId, acceptedText, acceptedSeq);
    }
  }

  /**
   * Rewind the conversation to the boundary carried by a user message's token.
   *
   * DSH cannot delete events from a live log, so the bridge forks a new session
   * that keeps only the events before the chosen message. This object switches
   * its durable id to that fork and tells Paseo the new persistence handle; the
   * host then reopens the session and replays the shorter history.
   */
  async revert(token: unknown, scope: "conversation" | "files" | "both"): Promise<void> {
    if (scope !== "conversation") {
      throw new Error(`rewind scope "${scope}" is not supported; only conversation state can be restored`);
    }
    if (!isRecord(token)) throw new Error("rewind token is not an object");
    const seq = token["seq"];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error("rewind token has no valid event seq");
    }
    const result = await this.#require().rewind(seq);
    if (typeof result.sessionId !== "string" || result.sessionId === "") {
      throw new Error("the bridge did not return the forked session id");
    }
    this.#retiredSessionIds.add(this.#dshSessionId);
    this.#dshSessionId = result.sessionId;
    // No event from the discarded branch can belong to the new timeline.
    this.#pendingUserMessages.clear();
    this.#recentUserMessageSeqs.clear();
    // The host reads this from its session state after the request completes,
    // closes the old process, and reopens with the new id.
    this.#options.emit({
      type: "session.persistence",
      sessionId: this.id,
      persistence: { version: 1, data: { sessionId: this.#dshSessionId } },
    });
  }

  #emitUserMessage(
    clientMessageId: string,
    text: string,
    revertToken?: { seq: number },
  ): void {
    this.#options.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: {
        type: "user_message",
        id: `user:${clientMessageId}`,
        text,
        clientMessageId,
        ...(revertToken === undefined ? {} : { revertToken }),
      },
    });
  }

  /** Attach a rewind token to an already-published message without a new row. */
  #emitRewindToken(clientMessageId: string, text: string, seq: number | undefined): void {
    if (seq === undefined) return;
    this.#emitUserMessage(clientMessageId, text, { seq });
  }

  #emitPromptFailed(clientMessageId: string, error: unknown): void {
    this.#options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "failed", error: { message: messageOf(error) } },
    });
  }

  #emitPromptAccepted(clientMessageId: string): void {
    const turnId = this.#turnId ?? `turn:${clientMessageId}`;
    this.#options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "turn", turnId },
    });
  }

  /** Apply a composer change: model, mode, thinking option or settings. */
  async configure(changes: ProviderConfigChanges): Promise<void> {
    const process = this.#require();
    // A route change invalidates any occupancy poll still in flight: its answer
    // describes the previous model's capacity and must not overwrite the new
    // one's. `refreshUsage` below issues the replacement poll.
    if (changes.model !== undefined && changes.model !== null) {
      this.#usageGeneration += 1;
      this.#emitUsage({}, true);
    }

    if (changes.model !== undefined && changes.model !== null) {
      const next = parseRoute(changes.model, this.#route);
      const applied = await process.setConfig({
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort ?? null,
      });
      this.#route = {
        provider: applied.provider,
        model: applied.model,
        ...(applied.reasoningEffort === null ? {} : { reasoningEffort: applied.reasoningEffort }),
      };
    }

    if (changes.thinkingOption !== undefined) {
      const requested =
        changes.thinkingOption === null || changes.thinkingOption === "" ? undefined : changes.thinkingOption;
      // The runtime rejects a whole turn when handed an effort the model does not
      // declare, and Paseo can carry a stale selection across a model switch.
      // Serve only what this model advertises and drop anything else.
      const supported = this.#supportedEfforts();
      const effort = requested !== undefined && supported.includes(requested) ? requested : undefined;
      if (requested !== undefined && effort === undefined) {
        this.#options.log(
          `ignoring unsupported thinking option "${requested}" for ${this.#route.provider}/${this.#route.model}`,
        );
      }
      this.#thinkingOption = effort;
      const applied = await process.setConfig({
        provider: this.#route.provider,
        model: this.#route.model,
        reasoningEffort: effort ?? null,
      });
      this.#route = {
        provider: applied.provider,
        model: applied.model,
        ...(applied.reasoningEffort === null ? {} : { reasoningEffort: applied.reasoningEffort }),
      };
    }

    if (changes.mode !== undefined && changes.mode !== null) {
      this.#mode = changes.mode === "plan" ? "plan" : "build";
      await process.setPlan(this.#mode === "plan");
    }

    const requestedPermission = changes.settings?.["permission"];
    if (
      typeof requestedPermission === "string" &&
      requestedPermission !== "" &&
      requestedPermission !== this.#permission
    ) {
      // Switch the DSH permission preset through its own `/permission` command,
      // which owns both the sandbox mode and the approval policy.
      const result = await process.runCommand("permission", requestedPermission);
      if (result.kind === "error") {
        throw new Error(result.text ?? `could not set permission preset "${requestedPermission}"`);
      }
      this.#permission = requestedPermission;
    }

    const requestedPreset = changes.settings?.["preset"];
    if (
      typeof requestedPreset === "string" &&
      requestedPreset !== "" &&
      requestedPreset !== this.#preset
    ) {
      // A preset is a creation-time choice; DSH refuses the change once the
      // session's first turn has started. On refusal keep the real value and log
      // it — the caller re-emits config, so the composer snaps back.
      this.#desiredPreset = requestedPreset;
      this.#presetPending = true;
      this.#options.log(`preset requested: ${requestedPreset}`);
      try {
        const applied = await process.setConfig({ preset: requestedPreset });
        this.#preset = applied.preset ?? requestedPreset;
        this.#presetPending = false;
      } catch (error) {
        const message = messageOf(error);
        this.#options.log(`preset change rejected: ${message}`);
        // Snapping back silently looks like the picker is broken. Say why on the
        // timeline; the caller still re-emits the config with the real value.
        this.#emitItem({
          type: "notification",
          id: `preset-error:${Date.now()}`,
          level: "error",
          message: `切换预设失败：${message}`,
        });
      }
    }

    // A model switch changes capacity; a mode switch does not, but both end
    // with the composer asking for a current readout, so one refresh covers it.
    void this.refreshUsage();
  }

  /** Answer a pending question card. */
  resolvePermission(permissionId: string, response: ProviderPermissionResponse): void {
    const resolve = this.#pendingPermissions.get(permissionId);
    if (resolve === undefined) return;
    this.#pendingPermissions.delete(permissionId);
    this.#options.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
    resolve(response);
  }

  /**
   * Cancel the running turn. The session and its history survive, so the
   * conversation stays continuable — killing the process stranded it instead.
   */
  async interrupt(): Promise<void> {
    this.#turnInterrupted = true;
    this.#flushLive();
    this.#clearLive();
    await this.#require().cancel();
  }

  /** Release the process. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#usageRefreshTimer);
    for (const child of this.#children.values()) {
      if (child.openTimer !== undefined) clearTimeout(child.openTimer);
      if (child.opened) {
        this.#options.emit({ type: "session.closed", sessionId: child.id });
      }
    }
    this.#children.clear();
    this.#pendingSubagentCalls.clear();
    this.#pendingUserMessages.clear();
    this.#recentUserMessageSeqs.clear();
    this.#flushLive();
    this.#clearLive();
    await this.#process?.shutdown();
  }

  #require(): DshProcess {
    if (this.#process === undefined || this.#closed) {
      throw new Error(`session ${this.id} is not open`);
    }
    return this.#process;
  }

  #onStatus(payload: DshStatusEvent): void {
    if (payload.sessionId !== this.#dshSessionId) {
      this.#onChildStatus(payload);
      return;
    }
    if (payload.status === "running") {
      if (this.#turnId === null) {
        this.#toolStarts.clear();
        this.#turnTool = { count: 0, ms: 0 };
        this.#turnInterrupted = false;
        // A later usage refresh must not rewrite the previous turn's row.
        this.#lastStats = undefined;
      }
      const turnId = this.#turnId ?? `turn:${Date.now()}`;
      this.#turnId = turnId;
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });
      return;
    }
    this.#completeTurn();
  }

  /**
   * Find or create the local view of a child session.
   *
   * A session is only treated as a child when its header names this session as
   * the parent *and* marks it as a subagent. In DSH 0.2.1 `parentSession` also
   * records ordinary fork lineage, so the parent link alone is not enough.
   */
  #ensureChild(meta: {
    sessionId: string;
    parentSessionId?: string;
    origin?: string;
    cwd?: string;
  }): ChildSessionState | undefined {
    if (!this.#options.capabilities.includes("session.subsession")) {
      if (!this.#warnedNoSubsession) {
        this.#warnedNoSubsession = true;
        this.#options.log(
          "Paseo host did not negotiate session.subsession; DSH subagent child sessions stay hidden",
        );
      }
      return undefined;
    }
    const existing = this.#children.get(meta.sessionId);
    if (existing !== undefined) {
      if (meta.cwd !== undefined) existing.cwd = meta.cwd;
      return existing;
    }
    if (meta.parentSessionId !== this.#dshSessionId || meta.origin !== "subagent") return undefined;
    const child: ChildSessionState = {
      id: meta.sessionId,
      timeline: new TimelineBuilder(),
      cwd: meta.cwd ?? this.#options.cwd,
      opened: false,
      turnId: null,
      finished: false,
      pending: [],
    };
    this.#children.set(meta.sessionId, child);
    return child;
  }

  #onChildSessionEvent(payload: DshSessionEvent): void {
    const child = this.#ensureChild(payload);
    if (child === undefined) return;
    const event = payload.event;
    if (event.type === "subagent/descriptor") {
      const data = isRecord(event.data) ? event.data : {};
      const title =
        typeof data.label === "string"
          ? data.label
          : typeof data.description === "string"
            ? data.description
            : undefined;
      if (title !== undefined && child.title === undefined) child.title = title;
    }
    if (!child.opened) {
      child.pending.push({ kind: "event", payload });
      this.#scheduleChildOpen(child);
      return;
    }
    this.#applyChildEvent(child, payload);
  }

  #onChildStatus(payload: DshStatusEvent): void {
    const child = this.#ensureChild(payload);
    if (child === undefined) return;
    if (!child.opened) {
      child.pending.push({ kind: "status", status: payload.status });
      this.#scheduleChildOpen(child);
      return;
    }
    this.#applyChildStatus(child, payload.status);
  }

  #scheduleChildOpen(child: ChildSessionState): void {
    if (child.openTimer !== undefined) return;
    // The parent's tool result normally arrives immediately and tells us which
    // parent tool call to link. If it never does, opening the child without a
    // toolCallId still beats hiding it from Paseo entirely.
    child.openTimer = setTimeout(() => {
      child.openTimer = undefined;
      this.#tryOpenChild(child);
    }, 1500);
    child.openTimer.unref?.();
  }

  #tryOpenChild(child: ChildSessionState): void {
    if (child.opened) return;
    // A subagent tool is in flight. Wait for its result to learn the call id,
    // unless the fallback timer has already fired and cleared that wait.
    if (child.toolCallId === undefined && this.#pendingSubagentCalls.size > 0 && child.openTimer !== undefined) {
      return;
    }
    this.#openChild(child);
  }

  #openChild(child: ChildSessionState): void {
    if (child.opened || this.#closed) return;
    child.opened = true;
    if (child.openTimer !== undefined) {
      clearTimeout(child.openTimer);
      child.openTimer = undefined;
    }
    this.#options.emit({
      type: "session.opened",
      sessionId: child.id,
      parentSessionId: this.id,
      ...(child.toolCallId === undefined ? {} : { toolCallId: child.toolCallId }),
      // These are the capabilities the host actually negotiated for this
      // connection. Advertising the static CAPABILITIES list here would make
      // Paseo reject the child before it is attached.
      capabilities: [...this.#options.capabilities],
      restoration: "parent",
      cwd: child.cwd,
      ...(child.title === undefined ? {} : { title: child.title, description: child.title }),
    });
    const pending = child.pending;
    child.pending = [];
    for (const item of pending) {
      if (item.kind === "event") this.#applyChildEvent(child, item.payload);
      else this.#applyChildStatus(child, item.status);
    }
  }

  #applyChildEvent(child: ChildSessionState, payload: DshSessionEvent): void {
    const event = payload.event;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === "turn/start") {
      this.#startChildTurn(child);
    }
    for (const item of child.timeline.consume(event)) {
      this.#options.emit({ type: "timeline.item", sessionId: child.id, item });
    }
    if (event.type === "turn/end") {
      const reason = isRecord(data.reason) ? data.reason : undefined;
      const kind = typeof data.reason === "string" ? data.reason : reason?.kind;
      // DSH names a canceled turn "aborted"; Paseo only knows "canceled".
      const state =
        kind === "error" || kind === "failed"
          ? "failed"
          : kind === "canceled" || kind === "cancelled" || kind === "aborted"
            ? "canceled"
            : "completed";
      const error = isRecord(reason?.error) ? reason.error : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      this.#finishChildTurn(child, state, message);
    }
  }

  #applyChildStatus(child: ChildSessionState, status: string): void {
    if (status === "running") {
      this.#startChildTurn(child);
      return;
    }
    const state =
      status === "failed" || status === "error"
        ? "failed"
        : status === "canceled" || status === "cancelled"
          ? "canceled"
          : "completed";
    this.#finishChildTurn(child, state);
  }

  #startChildTurn(child: ChildSessionState): void {
    if (child.turnId !== null) return;
    this.#childTurnSeq += 1;
    const turnId = `child:${child.id}:${this.#childTurnSeq}`;
    child.turnId = turnId;
    child.finished = false;
    this.#options.emit({ type: "session.turn", sessionId: child.id, turnId, state: "started" });
  }

  #finishChildTurn(
    child: ChildSessionState,
    state: "completed" | "failed" | "canceled",
    message?: string,
  ): void {
    // `turn/end` is normally followed by an idle status; only the first one
    // should produce a terminal turn event.
    if (child.finished) return;
    child.finished = true;
    // A child can be opened after its turn already ended (late bridge event or
    // replay). Still report the terminal state so Paseo does not leave the
    // subagent stuck on "running".
    this.#childTurnSeq += 1;
    const turnId = child.turnId ?? `child:${child.id}:${this.#childTurnSeq}`;
    child.turnId = null;
    this.#options.emit({
      type: "session.turn",
      sessionId: child.id,
      turnId,
      state,
      ...(message === undefined ? {} : { error: { message } }),
    });
  }

  /** Link a parent subagent tool result (`started subagent <id>`) to its child. */
  #trackSubagentResult(callId: string, message: unknown): void {
    const output = isRecord(message) ? textBlocks(message.content) : "";
    const match = /^\s*started subagent ([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/.exec(output);
    const pending = this.#pendingSubagentCalls.get(callId);
    this.#pendingSubagentCalls.delete(callId);
    if (match === null) {
      if (this.#pendingSubagentCalls.size === 0) {
        for (const child of this.#children.values()) {
          if (!child.opened && child.toolCallId === undefined) this.#tryOpenChild(child);
        }
      }
      return;
    }
    const child = this.#ensureChild({
      sessionId: match[1],
      parentSessionId: this.#dshSessionId,
      origin: "subagent",
    });
    if (child === undefined) return;
    child.toolCallId = callId;
    // The child's own descriptor label is authoritative; fall back to the
    // parent tool description when it did not publish one.
    if (child.title === undefined && pending?.description !== undefined) child.title = pending.description;
    this.#tryOpenChild(child);
  }

  /** Mark the current turn completed once its text is fully visible. */
  #completeTurn(): void {
    if (this.#turnId !== null) {
      const turnId = this.#turnId;
      this.#turnId = null;
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "completed" });
      // Paseo renders the completed-turn footer (copy / model / time) beneath
      // the answer only after this event, and reserves its own padding under
      // that footer. Flag the last stats row in the same tick so the client can
      // close the gap without first flashing the row in the wrong position.
      if (this.#lastStats !== undefined && !this.#turnInterrupted && this.#statsIsTail) {
        this.#lastStats.data = { ...this.#lastStats.data, final: true };
        this.#emitStatsRow();
      }
      // The turn's request reported fresh provider usage; refresh occupancy now
      // so the readout is current even when no further turn arrives.
      void this.refreshUsage();
    }
  }

  #onSessionEvent(payload: DshSessionEvent): void {
    const sessionId =
      typeof payload.sessionId === "string" ? payload.sessionId : this.#dshSessionId;
    if (this.#retiredSessionIds.has(sessionId)) return;
    if (sessionId !== this.#dshSessionId) {
      this.#onChildSessionEvent({ ...payload, sessionId });
      return;
    }
    const event = payload.event;
    // A prompt accepted while its agent was still starting has no seq yet. The
    // durable user message arrives later; attach the rewind token then, using
    // the same id and text so Paseo does not add a duplicate row.
    if (event.type === "user/message") {
      const data = isRecord(event.data) ? event.data : {};
      const messageId = typeof data.id === "string" ? data.id : undefined;
      if (messageId !== undefined && typeof event.seq === "number") {
        this.#recentUserMessageSeqs.set(messageId, event.seq);
        if (this.#recentUserMessageSeqs.size > 100) {
          const oldest = this.#recentUserMessageSeqs.keys().next().value;
          if (oldest !== undefined) this.#recentUserMessageSeqs.delete(oldest);
        }
      }
      const pending = messageId === undefined ? undefined : this.#pendingUserMessages.get(messageId);
      if (pending !== undefined && messageId !== undefined) {
        this.#pendingUserMessages.delete(messageId);
        if (typeof event.seq === "number") {
          this.#emitRewindToken(pending.clientMessageId, pending.text, event.seq);
        }
      }
      return;
    }
    // The model can leave plan mode on its own, for example by submitting a plan
    // for approval. Mirror that into the composer's mode selection so the toggle
    // never disagrees with the runtime.
    if (event.type === "plan/mode") {
      const data = isRecord(event.data) ? event.data : {};
      const next = data.active === true ? "plan" : "build";
      if (next !== this.#mode) {
        this.#mode = next;
        this.#options.emit({ type: "session.config", sessionId: this.id, config: this.configState() });
      }
      return;
    }
    // DSH reports token accounting on the assistant message and nowhere else, so
    // without this the composer's usage readout never had anything to show.
    // `#emitUsage` merges it with the known context occupancy because Paseo
    // replaces its whole usage record per event.
    if (event.type === "assistant/message") {
      const data = isRecord(event.data) ? event.data : {};
      if (isRecord(data.usage)) this.#emitUsage(providerUsage(data.usage));
    }
    if (
      event.type === "assistant/message" ||
      event.type === "assistant/attempt" ||
      event.type === "tool/result" ||
      event.type === "step/end" ||
      event.type === "request/context" ||
      event.type === "request/header"
    ) {
      this.#queueUsageRefresh();
    }
    // A compaction rewrites the surface, so the next request's prompt shrinks.
    // Refresh here so the readout drops without waiting for a turn.
    if (event.type === "compaction/end") void this.refreshUsage();

    if (event.type === "tool/call" || event.type === "tool/result") this.#trackToolEvent(event);
    // The live text already reached the same row; the durable message is the
    // authoritative final snapshot and simply replaces it.
    if (event.type === "assistant/message") this.#flushLive();
    for (const item of this.#timeline.consume(event)) this.#emitItem(item);
    if (event.type === "assistant/message") {
      this.#accumulateTotals(isRecord(event.data) ? event.data : {});
      this.#emitStreamStats(isRecord(event.data) ? event.data : {});
    }
    if (event.type === "turn/end" && this.#lastStats !== undefined) {
      this.#lastStats.data = {
        ...this.#lastStats.data,
        toolCalls: this.#turnTool.count,
        ...(this.#turnTool.ms > 0 ? { toolMs: this.#turnTool.ms } : {}),
      };
      this.#emitStatsRow();
    }
  }

  /**
   * Publish the per-step latency and throughput row beneath the answer.
   *
   * The numbers are measured from DSH's live frames, so a route that does not
   * stream (no frames) simply gets no row instead of a fabricated duration.
   * Output tokens come from the step's own usage record.
   */
  #emitStreamStats(data: Record<string, unknown>): void {
    const stats = this.#streamStats;
    this.#streamStats = undefined;
    if (stats === undefined || stats.firstTokenAt === undefined) return;
    const usage = isRecord(data.usage) ? data.usage : undefined;
    const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined;
    const firstTokenMs = stats.firstTokenAt - stats.startedAt;
    // Throughput needs a measured window between the first and the last text
    // delta. A route that delivers the whole answer in one burst (or one chunk)
    // has no observable window, so it reports latency only instead of a
    // meaningless thousands-of-tokens-per-second figure.
    const span =
      stats.lastTokenAt === undefined ? 0 : stats.lastTokenAt - stats.firstTokenAt;
    const measured = outputTokens !== undefined && span >= 50 ? outputTokens / (span / 1000) : undefined;
    // A burst delivery has no real generation window; a value this high is a
    // measurement artifact, not a speed anyone can use.
    const tokensPerSecond = measured !== undefined && measured <= 3000 ? measured : undefined;
    const turn = typeof data.turn === "number" ? data.turn : stats.turn;
    const step = typeof data.step === "number" ? data.step : stats.step;
    const statsData: Record<string, unknown> = {
      firstTokenMs,
      ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(typeof usage?.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage?.cacheReadTokens === "number" ? { cachedInputTokens: usage.cacheReadTokens } : {}),
      ...this.#contextFields(),
      provider: this.#route.provider,
      model: this.#route.model,
      ...(this.#thinkingOption === undefined ? {} : { thinkingOption: this.#thinkingOption }),
      toolCalls: this.#turnTool.count,
      ...(this.#turnTool.ms > 0 ? { toolMs: this.#turnTool.ms } : {}),
      ...this.#sessionFields(),
    };
    this.#lastStats = { id: `stream-stats:${turn}:${step}`, data: statsData };
    this.#emitStatsRow();
  }

  /** Fold one assistant message's turn, step and usage into the session totals. */
  #accumulateTotals(data: Record<string, unknown>): void {
    const turn = typeof data.turn === "number" ? data.turn : undefined;
    const step = typeof data.step === "number" ? data.step : undefined;
    if (turn !== undefined) this.#seenTurns.add(turn);
    if (turn !== undefined && step !== undefined) this.#seenSteps.add(`${turn}:${step}`);
    const usage = isRecord(data.usage) ? data.usage : undefined;
    if (usage === undefined) return;
    if (typeof usage.inputTokens === "number") this.#totals.input += usage.inputTokens;
    if (typeof usage.cacheReadTokens === "number") this.#totals.cache += usage.cacheReadTokens;
    if (typeof usage.cacheWriteTokens === "number") this.#totals.cacheWrite += usage.cacheWriteTokens;
    if (typeof usage.outputTokens === "number") this.#totals.output += usage.outputTokens;
  }

  /**
   * Turns, steps, total tokens and cache-hit rate for the collapsed line.
   *
   * Mirrors DSH's own UsagePill: the total is the three prompt-side billing
   * buckets plus output, and the cache rate divides cache reads by that same
   * prompt-side total.
   */
  #sessionFields(): Record<string, number> {
    const promptTokens = this.#totals.input + this.#totals.cache + this.#totals.cacheWrite;
    const tokens = promptTokens + this.#totals.output;
    return {
      turns: this.#seenTurns.size,
      steps: this.#seenSteps.size,
      ...(tokens > 0 ? { sessionTokens: tokens } : {}),
      ...(promptTokens > 0 ? { cacheHit: this.#totals.cache / promptTokens } : {}),
    };
  }

  /** Context occupancy from the last usage snapshot, when known. */
  #contextFields(): Record<string, number> {
    const usage = this.#lastUsage;
    return {
      ...(typeof usage?.contextWindowUsedTokens === "number"
        ? { contextUsed: usage.contextWindowUsedTokens }
        : {}),
      ...(typeof usage?.contextWindowMaxTokens === "number"
        ? { contextMax: usage.contextWindowMaxTokens }
        : {}),
    };
  }

  /** Publish (or re-publish) the current stats row under the answer. */
  #emitStatsRow(): void {
    const row = this.#lastStats;
    if (row === undefined) return;
    this.#emitItem({
      type: "plugin",
      id: row.id,
      pluginId: "dsh-paseo",
      kind: "dsh-stream-stats",
      version: 1,
      data: row.data as JsonValue,
    });
  }

  #trackToolEvent(event: { type: string; data?: unknown }): void {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      if (callId !== undefined) {
        this.#toolStarts.set(callId, Date.now());
        if (data.name === "subagent") {
          const input = parseToolArguments(data.arguments);
          this.#pendingSubagentCalls.set(callId, {
            ...(typeof input.description === "string" ? { description: input.description } : {}),
          });
        }
      }
      return;
    }
    const message = isRecord(data.message) ? data.message : undefined;
    const callId =
      typeof data.toolCallId === "string"
        ? data.toolCallId
        : typeof message?.toolCallId === "string"
          ? message.toolCallId
          : undefined;
    if (callId === undefined) return;
    if (this.#pendingSubagentCalls.has(callId)) this.#trackSubagentResult(callId, message);
    const startedAt = this.#toolStarts.get(callId);
    if (startedAt === undefined) return;
    this.#toolStarts.delete(callId);
    this.#turnTool.count += 1;
    this.#turnTool.ms += Math.max(0, Date.now() - startedAt);
  }

  #emitItem(item: ProviderTimelineItem): void {
    this.#statsIsTail = item.type === "plugin" && item.kind === "dsh-stream-stats";
    this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
  }

  /**
   * Fold one live assistant-stream frame into the answer row.
   *
   * DSH publishes token-level deltas while the model writes. Emitting a text
   * snapshot under the same timeline id the durable message will use lets
   * Paseo append the delta live; the step's `assistant/message` then arrives as
   * the authoritative final snapshot and replaces the row in place.
   */
  #onAssistantStream(frame: DshAssistantFrame): void {
    if (this.#closed) return;
    if (frame.type === "start") {
      this.#clearLive();
      this.#streamStats = {
        turn: frame.turn ?? 0,
        step: frame.step ?? 0,
        startedAt: Date.now(),
      };
      this.#live = {
        attemptId: frame.attemptId,
        turn: frame.turn ?? 0,
        step: frame.step ?? 0,
        text: "",
        emitted: "",
        reasoning: "",
        emittedReasoning: "",
        timer: undefined,
      };
      return;
    }
    const live = this.#live;
    if (live === undefined || live.attemptId !== frame.attemptId) return;
    if (frame.type === "end") {
      this.#flushLive();
      this.#clearLive();
      if (this.#streamStats !== undefined) this.#streamStats.endedAt = Date.now();
      return;
    }
    if (typeof frame.text !== "string") return;
    const stats = this.#streamStats;
    if (frame.kind === "text" && stats !== undefined) {
      // Prefer DSH's own chunk timestamp (epoch ms, same clock) so IPC latency
      // never stretches or compresses the measured generation window.
      const at = typeof frame.time === "number" ? frame.time : Date.now();
      if (stats.firstTokenAt === undefined) stats.firstTokenAt = at;
      stats.lastTokenAt = at;
    }
    if (frame.kind === "reasoning") live.reasoning += frame.text;
    else live.text += frame.text;
    if (live.timer !== undefined) return;
    // Coalesce token deltas so a long answer does not republish the whole row
    // hundreds of times; 40ms still reads as continuous typing.
    live.timer = setTimeout(() => {
      const current = this.#live;
      if (current === undefined) return;
      current.timer = undefined;
      this.#flushLive();
    }, 40);
    live.timer.unref?.();
  }

  /** Publish the accumulated live text as the message row's current snapshot. */
  #flushLive(): void {
    const live = this.#live;
    if (live === undefined) return;
    if (live.timer !== undefined) {
      clearTimeout(live.timer);
      live.timer = undefined;
    }
    // The thinking row must exist before the answer row, matching the durable
    // order; otherwise the late reasoning item would land below the answer.
    if (live.reasoning !== "" && live.reasoning !== live.emittedReasoning) {
      live.emittedReasoning = live.reasoning;
      this.#emitItem({
        type: "reasoning",
        id: `reasoning:${live.turn}:${live.step}`,
        text: live.reasoning,
      });
    }
    if (live.text === "" || live.text === live.emitted) return;
    live.emitted = live.text;
    this.#emitItem({
      type: "assistant_message",
      id: `assistant:${live.turn}:${live.step}`,
      text: live.text,
    });
  }

  /** Forget the live buffer without flushing it (interrupt, exit, close). */
  #clearLive(): void {
    const live = this.#live;
    if (live?.timer !== undefined) clearTimeout(live.timer);
    this.#live = undefined;
  }

  /**
   * Replace one half of the usage snapshot and publish the whole thing.
   *
   * Paseo replaces its entire usage record on every `session.usage`, so a patch
   * carrying only token counts would erase the context fields, and a patch
   * carrying only occupancy would erase the counts. Merging here keeps one
   * complete, mutually consistent picture in the composer.
   */
  #emitUsage(patch: ProviderUsage, replaceContext = false): void {
    if (this.#closed) return;
    const merged: ProviderUsage = { ...this.#lastUsage };
    if (replaceContext) {
      delete merged.contextWindowMaxTokens;
      delete merged.contextWindowUsedTokens;
    } else {
      // Message usage describes this step, not a delta. An omitted cache bucket
      // must not keep the previous step's count.
      delete merged.inputTokens;
      delete merged.cachedInputTokens;
      delete merged.outputTokens;
      delete merged.totalCostUsd;
    }
    Object.assign(merged, patch);
    this.#lastUsage = merged;
    this.#options.emit({
      type: "session.usage",
      sessionId: this.id,
      ...(this.#turnId === null ? {} : { turnId: this.#turnId }),
      usage: merged,
    });
  }

  /**
   * Turn one DSH question request into a single Paseo permission card. Paseo's
   * shared picker steps through every entry of `input.questions` and submits all
   * answers together, so splitting questions across cards forced one submission
   * each. Its own providers bundle them the same way.
   */
  async #onQuestion(request: DshQuestionRequest): Promise<DshAnswer> {
    const headers = request.questions.map((question, index) => headerOf(question, index));
    const planIndex = request.questions.findIndex((question) => question.intent?.kind === "plan-review");
    const response =
      planIndex < 0
        ? await this.#askQuestions(request, headers)
        : await this.#reviewPlan(request, request.questions[planIndex] as DshQuestion);

    const answers = request.questions.map((question, index) => ({
      id: question.id,
      selected:
        index === planIndex
          ? planAnswer(question, response)
          : selectAnswer(question, headers[index] as string, response),
      ...(response.behavior === "deny" && response.message !== undefined
        ? { custom: response.message }
        : {}),
    }));

    return { answers };
  }

  /** One card carrying every question, answered in a single submission. */
  #askQuestions(
    request: DshQuestionRequest,
    headers: string[],
  ): Promise<ProviderPermissionResponse> {
    const permission: ProviderPermissionRequest = {
      id: request.callId ?? "question",
      name: "ask_user_question",
      kind: "question",
      title: request.questions.length === 1 ? (headers[0] as string) : "Questions",
      input: {
        questions: request.questions.map((question, index) => ({
          question: question.question,
          header: headers[index] as string,
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            ...(typeof option.description === "string" && option.description.length > 0
              ? { description: option.description }
              : {}),
          })),
          ...(question.multiSelect === true ? { multiSelect: true } : {}),
          allowOther: true,
        })),
      } as unknown as Readonly<Record<string, JsonValue>>,
    };

    return this.#openCard(permission);
  }

  /**
   * Plan review, shaped exactly like Paseo's own Codex plan approval: the plan
   * rides in `input.plan` and two buttons decide it. The plan itself is also
   * emitted as a timeline `plan` item so it stays readable before the choice.
   */
  #reviewPlan(
    request: DshQuestionRequest,
    question: DshQuestion,
  ): Promise<ProviderPermissionResponse> {
    const permission: ProviderPermissionRequest = {
      id: `${request.callId ?? "question"}:${question.id}`,
      name: "exit_plan_mode",
      kind: "plan",
      title: "Plan",
      description: "Review the proposed plan before implementation starts.",
      input: {
        plan: typeof question.detail === "string" ? question.detail : "",
        ...(question.intent === undefined ? {} : { intent: question.intent }),
      } as unknown as Readonly<Record<string, JsonValue>>,
      actions: [
        { id: "dismiss", label: "Dismiss", behavior: "deny", variant: "danger", intent: "dismiss" },
        {
          id: "implement",
          label: "Implement",
          behavior: "allow",
          variant: "primary",
          intent: "implement",
        },
      ],
    };

    return this.#openCard(permission);
  }

  #openCard(permission: ProviderPermissionRequest): Promise<ProviderPermissionResponse> {
    return new Promise<ProviderPermissionResponse>((resolve) => {
      this.#pendingPermissions.set(permission.id, resolve);
      this.#options.emit({ type: "session.permission", sessionId: this.id, request: permission });
    });
  }
}

/**
 * Translate one Paseo content block into the shape the bridge hands DSH.
 *
 * Text and images have a native DSH counterpart. The rest (uploaded files and
 * forge/GitHub/review attachments) become a text reference that names the file
 * or link and carries the body, so the model keeps the evidence instead of
 * losing the prompt. Nothing is dropped silently, and nothing throws: an
 * exception here escapes `prompt()` and kills the session.
 */
function toDshContent(block: ProviderContent): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
  if (block.type === "uploaded_file") {
    return {
      type: "text",
      text: `Attached file: ${block.fileName} (${block.mimeType}, ${block.size} bytes)\n${block.path}`,
    };
  }
  if (block.type === "review") {
    const comments = block.comments
      .map((comment) => `${comment.filePath}:${comment.lineNumber} (${comment.side})\n${comment.body}`)
      .join("\n\n");
    return { type: "text", text: `Attached review comments (${block.mode}):\n\n${comments}` };
  }
  // Forge, GitHub and text attachments share title, url and body.
  const reference = block as unknown as { title?: string; url?: string; body?: string | null };
  const heading = reference.title ?? block.type;
  const url = reference.url === undefined ? "" : `\n${reference.url}`;
  const body =
    typeof reference.body === "string" && reference.body.trim() !== "" ? `\n\n${reference.body}` : "";
  return {
    type: "text",
    text: `Attached ${block.type.replace(/_/g, " ")}: ${heading}${url}${body}`,
  };
}

/**
 * Paseo's select carries a single label per option, so use DSH's product name
 * instead of the machine value. These three are DSH's built-in labels; custom
 * profiles keep their own name, and kebab-case names are title-cased the same
 * way DSH's own client does it.
 */
function permissionPresetLabel(value: string, name?: string): string {
  const builtIn: Record<string, string> = {
    "read-only": "Read Only",
    "workspace-write": "Workspace Write",
    "danger-full-access": "Full access",
    "auto": "Auto review",
    "custom": "Custom",
  };
  const product = builtIn[value];
  if (product !== undefined && (name === undefined || name === value || name === product)) {
    return product;
  }
  const display = name ?? value;
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(display)) {
    return display
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  return display;
}

/**
 * Map DSH's per-step token accounting onto Paseo's usage fields.
 *
 * DSH attaches usage to the assistant message because it keeps no separate usage
 * record, so this is the only place the numbers exist to forward.
 */
function providerUsage(raw: Record<string, unknown>): ProviderUsage {
  return {
    ...(typeof raw.inputTokens === "number" ? { inputTokens: raw.inputTokens } : {}),
    ...(typeof raw.cacheReadTokens === "number" ? { cachedInputTokens: raw.cacheReadTokens } : {}),
    ...(typeof raw.outputTokens === "number" ? { outputTokens: raw.outputTokens } : {}),
  };
}

/**
 * Answer key Paseo's shared question UI returns under `updatedInput.answers`.
 * Questions without a header still need a distinct key, so the position is used.
 */
function headerOf(question: DshQuestion, index: number): string {
  if (typeof question.header === "string" && question.header.trim().length > 0) return question.header;
  if (typeof question.id === "string" && question.id.trim().length > 0) return question.id;
  return `Question ${index + 1}`;
}

/**
 * Recover the chosen labels from a permission response. Paseo answers through
 * `updatedInput.answers[<header>]` — a string, comma-joined when multi-select —
 * so `selectedActionId` is only a fallback for button-style resolutions.
 */
function selectAnswer(
  question: DshQuestion,
  header: string,
  response: ProviderPermissionResponse,
): string[] {
  if (response.behavior === "deny") return [];
  const answers = isRecord(response.updatedInput) ? response.updatedInput["answers"] : undefined;
  const raw = isRecord(answers) ? answers[header] : undefined;
  if (typeof raw === "string" && raw.trim().length > 0) {
    if (question.multiSelect === true) {
      return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [raw.trim()];
  }
  const options = question.options ?? [];
  const index = Number(response.selectedActionId);
  const label = Number.isInteger(index) ? options[index]?.label : undefined;
  return label === undefined ? [] : [label];
}

/**
 * Decide a plan review. Only the `implement` button approves; anything else —
 * including a dismissal — names the non-approval option so the model is told to
 * revise the plan rather than to start implementing it.
 */
function planAnswer(question: DshQuestion, response: ProviderPermissionResponse): string[] {
  const picked = selectAnswer(question, headerOf(question, 0), response);
  if (picked.length > 0) return picked;
  const approve = question.intent?.approve;
  if (response.behavior === "allow" && response.selectedActionId === "implement") {
    return approve === undefined ? [] : [approve];
  }
  const keep = (question.options ?? []).find((option) => option.label !== approve)?.label;
  return keep === undefined ? [] : [keep];
}
