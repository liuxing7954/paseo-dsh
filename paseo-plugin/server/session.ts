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
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { DshProcess, type DshAnswer, type DshQuestion, type DshQuestionRequest, type DshRoute } from "./dsh-process";
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
  cwd: string;
  env: Record<string, string>;
  route: DshRoute;
  mode: string;
  /** Models Paseo can switch to for this session, from the cached catalog. */
  models: ProviderModel[];
  /** Thinking options the catalog advertises. */
  thinkingOptions: ProviderThinkingOption[];
  emit(event: ProviderEvent): void;
  log(line: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Resolve Paseo's catalog id (`provider/model`) back into a DSH route. */
export function parseRoute(model: string | undefined, fallback: DshRoute): DshRoute {
  if (model === undefined || model === "") return fallback;
  const slash = model.indexOf("/");
  if (slash <= 0) return { ...fallback, model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

export class DshSession {
  readonly id: string;
  readonly #options: DshSessionOptions;
  readonly #timeline = new TimelineBuilder();
  #process: DshProcess | undefined;
  #route: DshRoute;
  #mode: string;
  #thinkingOption: string | undefined;
  #turnId: string | null = null;
  #pendingPermissions = new Map<string, (response: ProviderPermissionResponse) => void>();
  /** Slash-menu entries by name, tagging why each exists. */
  #commandKinds = new Map<string, "command" | "skill">();
  #closed = false;

  constructor(options: DshSessionOptions) {
    this.id = options.sessionId;
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
      sessionId: this.id,
      env: this.#options.env,
      onEvent: (payload) => this.#onSessionEvent(payload),
      onStatus: (status) => this.#onStatus(status),
      onQuestion: (request) => this.#onQuestion(request),
      onLog: (line) => this.#options.log(line),
      onExit: (code, signal) => {
        if (this.#closed) return;
        this.#closed = true;
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
  }

  /** The committed configuration Paseo renders in the composer. */
  configState(): ProviderConfigState {
    const settings: ProviderSetting[] = [];
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

  /** Accept one prompt and start its turn. */
  async prompt(prompt: ProviderPrompt): Promise<void> {
    const process = this.#require();

    // A slash-menu pick arrives as a command, not a message. DSH commands and
    // skills share the menu but not the execution path, so branch on the kind
    // the catalog recorded rather than on the name.
    if (prompt.input.type === "command") {
      const args = prompt.input.arguments ?? "";
      const line = args.trim() === "" ? `/${prompt.input.name}` : `/${prompt.input.name} ${args}`;
      this.#emitUserMessage(prompt.clientMessageId, line);

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
        await process.prompt(line, [{ type: "text", text: line }], prompt.delivery);
      } catch (error) {
        this.#emitPromptFailed(prompt.clientMessageId, error);
        return;
      }
      this.#emitPromptAccepted(prompt.clientMessageId);
      return;
    }

    // Paseo and the bridge already agree on the text/image block shape, so the
    // blocks ride through untouched. They used to be collapsed to a text label,
    // which silently discarded every non-text attachment.
    const blocks = prompt.input.content.map(toDshContent);
    const label = blocks
      .map((block) => (block.type === "text" ? (block.text as string) : ""))
      .filter((text) => text !== "")
      .join("\n");

    this.#emitUserMessage(prompt.clientMessageId, label);

    try {
      await process.prompt(label, blocks.length === 0 ? undefined : blocks, prompt.delivery);
    } catch (error) {
      this.#emitPromptFailed(prompt.clientMessageId, error);
      return;
    }

    this.#emitPromptAccepted(prompt.clientMessageId);
  }

  #emitUserMessage(clientMessageId: string, text: string): void {
    this.#options.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: { type: "user_message", id: `user:${clientMessageId}`, text, clientMessageId },
    });
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

    if (changes.model !== undefined && changes.model !== null) {
      const next = parseRoute(changes.model, this.#route);
      this.#route = next;
      await process.setConfig({
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort ?? null,
      });
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
    await this.#require().cancel();
  }

  /** Release the process. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#process?.shutdown();
  }

  #require(): DshProcess {
    if (this.#process === undefined || this.#closed) {
      throw new Error(`session ${this.id} is not open`);
    }
    return this.#process;
  }

  #onStatus(status: string): void {
    if (status === "running") {
      const turnId = this.#turnId ?? `turn:${Date.now()}`;
      this.#turnId = turnId;
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });
      return;
    }
    if (this.#turnId !== null) {
      const turnId = this.#turnId;
      this.#turnId = null;
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "completed" });
    }
  }

  #onSessionEvent(payload: { event: { type: string; [key: string]: unknown } }): void {
    const event = payload.event;
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
    if (event.type === "assistant/message") {
      const data = isRecord(event.data) ? event.data : {};
      if (isRecord(data.usage)) {
        this.#options.emit({
          type: "session.usage",
          sessionId: this.id,
          ...(this.#turnId === null ? {} : { turnId: this.#turnId }),
          usage: providerUsage(data.usage),
        });
      }
    }
    for (const item of this.#timeline.consume(event)) {
      this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
    }
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
 * A block with no DSH counterpart fails loudly rather than being dropped: the
 * model would otherwise receive a prompt silently missing its evidence.
 */
function toDshContent(block: ProviderContent): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
  throw new Error(`unsupported prompt content type "${block.type}"`);
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
