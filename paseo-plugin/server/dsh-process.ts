/**
 * One `dsh --profile paseo` child process, speaking the bridge's stdio JSON-RPC.
 *
 * A process owns exactly one agent session. DSH pins the working directory,
 * provider, model and reasoning effort at `initialize`, so a session per
 * process is what lets Paseo run several workspaces against one provider.
 *
 * @module dsh-paseo/server/dsh-process
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

/** Provider/model/thinking route pinned for the life of one process. */
export interface DshRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One question the model asked, mirroring DSH's `AskUserQuestionItem`. */
export interface DshQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind: string; approve?: string; callId?: string };
}

/** One answer batch returned to DSH. */
export interface DshAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

/** A server -> client question request raised by the DSH bridge. */
export interface DshQuestionRequest {
  callId: string | null;
  timed: boolean;
  questions: DshQuestion[];
}

/** A `session.event` payload's outer envelope. */
export interface DshSessionEvent {
  sessionId: string;
  event: { type: string; [key: string]: unknown };
}

/** One model the runtime advertises, with its adapter-owned reasoning efforts. */
export interface DshCatalogModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    defaultEffort?: string;
    efforts: Array<{ id: string; name: string; description?: string }>;
  };
}

/** The runtime's provider/model catalog. */
export interface DshCatalog {
  providers: Array<{ id: string; name: string }>;
  models: DshCatalogModel[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string | null;
  planMode?: boolean;
}

/**
 * One entry of the composer's `/` menu. `kind` decides how running it works:
 * a registered `command` executes in the runtime, a `skill` rides a `/name`
 * user message that DSH's skill tool turns into an injected instruction set.
 */
export interface DshCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
}

export interface DshProcessHandlers {
  onEvent(payload: DshSessionEvent): void;
  onStatus(status: string): void;
  onQuestion(request: DshQuestionRequest): Promise<DshAnswer>;
  onLog(line: string): void;
  onExit(code: number | null, signal: string | null): void;
  onProtocolError(message: string): void;
}

export interface DshProcessOptions extends DshProcessHandlers {
  cwd: string;
  route: DshRoute;
  sessionId: string;
  /** Extra environment for the child; merged over the daemon's environment. */
  env?: Record<string, string>;
  /**
   * Whether `start()` pins a route with `initialize`. Catalog reads skip it,
   * because `paseo/catalog` needs no agent and a bad route must not hide the
   * model list that would let the user pick a good one.
   */
  initializeRoute?: boolean;
}

const BINARY_CANDIDATES = [
  process.env.DSH_BINARY,
  "dsh",
  `${process.env.HOME ?? ""}/.local/bin/dsh`,
].filter((value): value is string => typeof value === "string" && value.length > 0);

function resolveBinary(): string {
  for (const candidate of BINARY_CANDIDATES) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
    if (!candidate.includes("/")) return candidate;
  }
  return "dsh";
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    return new Error(String((value as { message: unknown }).message));
  }
  return new Error(fallback);
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class DshProcess {
  readonly #options: DshProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #initializeTask: Promise<void> | undefined;

  constructor(options: DshProcessOptions) {
    this.#options = options;
  }

  /** Spawn the child and complete `initialize`. Idempotent. */
  start(): Promise<void> {
    this.#initializeTask ??= this.#start();
    return this.#initializeTask;
  }

  async #start(): Promise<void> {
    const child = spawn(resolveBinary(), ["--profile", process.env.DSH_PASEO_PROFILE ?? "paseo"], {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.#options.env },
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") this.#options.onLog(line);
      }
    });
    child.on("error", (error) => {
      this.#failAll(error);
      this.#options.onProtocolError(error.message);
    });
    child.on("exit", (code, signal) => {
      this.#closed = true;
      this.#failAll(new Error("DeepSeek Harness process ended"));
      this.#options.onExit(code, signal);
    });

    if (this.#options.initializeRoute === false) return;

    await this.#request("initialize", {
      cwd: this.#options.cwd,
      provider: this.#options.route.provider,
      model: this.#options.route.model,
      ...(this.#options.route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.#options.route.reasoningEffort }),
    });
  }

  /** Read the runtime's provider/model catalog without creating an agent. */
  async catalog(): Promise<DshCatalog> {
    return (await this.#request("paseo/catalog", {}, 60000)) as DshCatalog;
  }

  /** List the session's registered commands and user-invocable skills. */
  async commands(): Promise<DshCommand[]> {
    const result = (await this.#request(
      "paseo/commands",
      { sessionId: this.#options.sessionId },
      60000,
    )) as { commands?: DshCommand[] };
    return result.commands ?? [];
  }

  /** Execute one registered slash command (skills are sent as text instead). */
  async runCommand(name: string, args: string): Promise<{ kind: "success" | "error"; text?: string }> {
    return (await this.#request("paseo/command/run", {
      sessionId: this.#options.sessionId,
      name,
      arguments: args,
    })) as { kind: "success" | "error"; text?: string };
  }

  /** Send one text prompt. Resolves when the bridge accepts it, not when the turn ends. */
  async prompt(
    text: string,
    contentBlocks?: unknown[],
    delivery?: "auto" | "steer",
  ): Promise<void> {
    await this.#request("session/prompt", {
      sessionId: this.#options.sessionId,
      contentBlocks: contentBlocks ?? [{ type: "text", text }],
      ...(delivery === undefined ? {} : { delivery }),
    });
  }

  /** Cancel the running turn while keeping the session usable afterwards. */
  async cancel(): Promise<void> {
    await this.#request("session/cancel", { sessionId: this.#options.sessionId });
  }

  /** Select plan mode and return the committed state. */
  async setPlan(active: boolean): Promise<{ active: boolean; pending: boolean; outcome?: string }> {
    return (await this.#request("paseo/plan/set", {
      sessionId: this.#options.sessionId,
      active,
    })) as { active: boolean; pending: boolean; outcome?: string };
  }

  /** Read the committed plan state. */
  async getPlan(): Promise<{ active: boolean; pending: boolean; available: boolean }> {
    return (await this.#request("paseo/plan/get", {
      sessionId: this.#options.sessionId,
    })) as { active: boolean; pending: boolean; available: boolean };
  }

  /** Switch model and/or reasoning effort on the live agent. */
  async setConfig(changes: {
    model?: string;
    provider?: string;
    reasoningEffort?: string | null;
  }): Promise<{ provider: string; model: string; reasoningEffort: string | null }> {
    return (await this.#request("paseo/config/set", {
      sessionId: this.#options.sessionId,
      ...changes,
    })) as { provider: string; model: string; reasoningEffort: string | null };
  }

  /** Ask the bridge to dispose the agent and exit. */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#request("shutdown", {}, 5000);
    } catch {
      /* the child may exit before answering */
    }
    this.kill();
  }

  /** Terminate the child without a protocol shutdown. */
  kill(): void {
    this.#closed = true;
    this.#child?.kill("SIGTERM");
    const child = this.#child;
    setTimeout(() => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 4000).unref?.();
  }

  #request(method: string, params: unknown, timeoutMs = 120000): Promise<unknown> {
    if (this.#closed || this.#child === undefined) {
      return Promise.reject(new Error("DeepSeek Harness process is not running"));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`DeepSeek Harness did not answer ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(frame: unknown): void {
    try {
      this.#child?.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.#options.onProtocolError(toError(error, "failed to write to the bridge").message);
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.#options.onLog(line);
        continue;
      }
      void this.#dispatch(frame);
    }
  }

  async #dispatch(frame: Record<string, unknown>): Promise<void> {
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const id = frame.id;

    if (method === "paseo/question" && id !== undefined) {
      try {
        const params = (frame.params ?? {}) as DshQuestionRequest;
        const answer = await this.#options.onQuestion({
          callId: params.callId ?? null,
          timed: params.timed === true,
          questions: params.questions ?? [],
        });
        this.#send({ jsonrpc: "2.0", id, result: answer });
      } catch (error) {
        this.#send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: toError(error, "question cancelled").message },
        });
      }
      return;
    }

    if (method === "session.event") {
      this.#options.onEvent(frame.params as DshSessionEvent);
      return;
    }
    if (method === "session.status") {
      const params = frame.params as { status?: string } | undefined;
      this.#options.onStatus(params?.status ?? "unknown");
      return;
    }
    if (method !== undefined) {
      if (id !== undefined) {
        this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported ${method}` } });
      }
      return;
    }

    if (id !== undefined && typeof id === "number") {
      const entry = this.#pending.get(id);
      if (entry === undefined) return;
      this.#pending.delete(id);
      const error = frame.error as { message?: string } | undefined;
      if (error !== undefined) entry.reject(new Error(error.message ?? "bridge request failed"));
      else entry.resolve(frame.result);
    }
  }

  #failAll(error: Error): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
