/**
 * The Paseo provider that drives DeepSeek Harness through the `paseo` DSH profile.
 *
 * One Paseo session maps onto one `dsh --profile paseo` process, because DSH
 * pins the working directory and initial route at `initialize`. The provider
 * reports DSH's real catalog — providers, models and each model's adapter-owned
 * reasoning efforts — so the composer offers only what the runtime can serve.
 *
 * @module dsh-paseo/server/provider
 */
import {
  negotiateProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderModel,
  type ProviderRegistration,
  type ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dshHomeDir, profileDir } from "./bootstrap";
import { BRIDGE_PACKAGE_NAME } from "./bridge-assets";
import { resolveDshCommand } from "./dsh-command.mjs";
import { DshProcess, resolveDshBinary, type DshCatalog } from "./dsh-process";
import { DshSession, MODES, offersThinking, parseRoute } from "./session";

const CAPABILITIES = [
  "prompt.message",
  // Without this Paseo refuses to send any prompt carrying an image, so an
  // attached picture never reaches the bridge (the same class of silent loss as
  // an un-declared `prompt.steer`). The bridge already admits image blocks into
  // DSH's attachment store; declaring the capability is what makes Paseo use it.
  "prompt.image",
  // The `/` menu is capability-gated too: without `prompt.command` Paseo never
  // asks for DSH's commands, so its registered commands and user-invocable
  // skills are invisible.
  "prompt.command",
  "prompt.steer",
  "session.configure",
  // Without a persistence handle Paseo falls back to a raw session id that its
  // own decoder rejects on reopen, so a session orphaned by a plugin reload or
  // daemon restart can never be resumed ("Invalid plugin provider persistence
  // handle"). Declaring the capability and emitting a handle in `session.opened`
  // lets Paseo reopen the session, which DSH then resumes by id.
  "session.persistence",
  // Advertises that DSH sessions can be enumerated and imported ("Import
  // session" lists providers that support this). Implemented over the session
  // log below.
  "session.list",
  // DSH 0.2.2 runs subagents as child sessions. Advertising this lets Paseo
  // accept a `session.opened` whose parentSessionId points at this session;
  // without it the server rejects the child outright.
  "session.subsession",
  // DSH can fork a session at any durable event boundary. Rewinding is a fork
  // that keeps only the events before the chosen message, so the old history is
  // never mutated. Files are not part of the rewind contract: the bridge can
  // only reproduce conversation state.
  "session.revert.conversation",
  // Paseo releases a session after an hour without activity. It rules out its
  // own foreground work first, but a background shell, a running subagent or a
  // scheduled reminder lives only in the DSH process, and releasing a root
  // session ends that process. Without this capability Paseo releases the
  // session without asking; with it, the bridge answers from DSH's own archive
  // admission and Paseo keeps the runtime while that work runs.
  "session.can_stop_runtime",
  "permission",
  "permission.tool_policy",
] as const;

/** Provider id registered with Paseo; distinct from the ACP `deepseek-harness` entry. */
export const PROVIDER_ID = "deepseek-harness-native";

/** The plugin ID this provider ships under. */
const DEFAULT_PLUGIN_ID = "dsh-paseo";

/**
 * Last-resort route. The DSH profile's `agent-default-model` is the real source
 * of truth and is read from every catalog; this only backs a profile that
 * composes no default at all, so it deliberately names nothing anyone runs.
 */
const FALLBACK_ROUTE = { provider: "unset", model: "unset" };
const CATALOG_TTL_MS = 5 * 60 * 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The DSH profile that must exist for this provider to work. */
function profileName(): string {
  return process.env.DSH_PASEO_PROFILE ?? "paseo";
}

/**
 * Cached catalogs, one per workspace. An entry is served only while the inputs
 * that produced it hash the same, so an edit reaches the next read without a
 * reload. The TTL still bounds what the hash cannot see, such as DSH upgraded in
 * place.
 */
const catalogCache = new Map<string, { at: number; inputs: string; value: DisplayCatalog }>();

/** A catalog read whose inputs changed while it ran; the same read can be retried. */
class CatalogInputsChangedError extends Error {
  readonly code = "catalog_inputs_changed";

  constructor() {
    super("DSH configuration changed while the model list was read; try again / 读取模型列表时 DSH 配置发生了变化，请重试");
  }
}

function providerError(error: unknown): { message: string; code?: string } {
  return error instanceof CatalogInputsChangedError
    ? { message: error.message, code: error.code }
    : { message: messageOf(error) };
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Regular files under `dir` in name order; a missing directory has none. */
async function filesIn(dir: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
    const path = join(dir, entry.name);
    if (entry.isFile()) files.push(path);
    else if (recursive && entry.isDirectory()) files.push(...(await filesIn(path, true)));
  }
  return files;
}

/**
 * Hash everything a catalog read depends on. The probe runs the resolved DSH
 * command in `cwd` with this process's environment, and DSH composes the catalog
 * from the home patch, the credentials, the profile's own files and the bridge
 * installed in the profile. These files are small: hashing them costs far less
 * than the DSH process a miss starts.
 */
async function catalogInputs(cwd: string): Promise<string> {
  const env = process.env;
  const profile = profileName();
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      cwd,
      launch: resolveDshCommand(resolveDshBinary(env), env, cwd),
      profile,
      env: Object.entries(env).sort(([a], [b]) => byName(a, b)),
    }),
  );
  const home = dshHomeDir();
  const dir = profileDir(profile, home);
  const files = [
    join(home, "cordis.patch.yml"),
    join(home, ".credentials.yaml"),
    ...(await filesIn(dir, false)),
    ...(await filesIn(join(dir, "node_modules", BRIDGE_PACKAGE_NAME), true)),
  ];
  for (const file of files) {
    const content = await readFile(file).catch(() => undefined);
    // Length-prefixed, so no file boundary can be mistaken for another; a
    // missing file hashes differently from an empty one.
    hash.update(`\0${file}\0${content === undefined ? "-" : content.length}\0`);
    if (content !== undefined) hash.update(content);
  }
  return hash.digest("hex");
}

interface DisplayCatalog {
  models: ProviderModel[];
  thinkingOptions: ProviderThinkingOption[];
  /** The profile's configured default route, used when a session names none. */
  fallbackRoute: { provider: string; model: string };
  defaults: ProviderCatalog;
}

/**
 * Read the runtime catalog: from the cache while its inputs are unchanged,
 * otherwise through a short-lived process. Aborting `signal` stops that process
 * and rejects with the signal's reason at once.
 */
async function loadCatalog(cwd: string, signal: AbortSignal): Promise<DisplayCatalog> {
  const inputs = await catalogInputs(cwd);
  const cached = catalogCache.get(cwd);
  if (cached !== undefined && cached.inputs === inputs && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.value;
  }
  signal.throwIfAborted();
  const probe = new DshProcess({
    cwd,
    sessionId: "catalog-probe",
    route: FALLBACK_ROUTE,
    initializeRoute: false,
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  // Kill inside `abort()`, so `close()` has stopped the process by the time it
  // returns, and reject at once instead of waiting for the exit to fail the
  // pending request.
  const stop = (): void => {
    probe.kill();
    rejectStopped(signal.reason);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const raw: DshCatalog = await Promise.race([probe.start().then(() => probe.catalog()), stopped]);
    const value = toDisplayCatalog(raw);
    // A file saved while DSH was reading may or may not be in this result, so it
    // is cached under neither version of the inputs.
    if ((await catalogInputs(cwd)) !== inputs) throw new CatalogInputsChangedError();
    catalogCache.set(cwd, { at: Date.now(), inputs, value });
    return value;
  } finally {
    signal.removeEventListener("abort", stop);
    probe.kill();
  }
}

/** List DSH's importable sessions through a short-lived process. */
async function listDshSessions(
  cwd: string,
  options: { query?: string; limit?: number },
): Promise<Array<{ sessionId: string; cwd?: string; title?: string; createdAt?: number }>> {
  const probe = new DshProcess({
    cwd,
    sessionId: "sessions-probe",
    route: FALLBACK_ROUTE,
    initializeRoute: false,
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
  try {
    await probe.start();
    return await probe.sessions({
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  } finally {
    probe.kill();
  }
}

function toDisplayCatalog(raw: DshCatalog): DisplayCatalog {
  const providerName = new Map(raw.providers.map((entry) => [entry.id, entry.name]));
  const models: ProviderModel[] = raw.models.map((model) => {
    const thinkingOptions = (model.reasoning?.efforts ?? []).map((effort) => ({
      id: effort.id,
      label: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    }));
    return {
      // `provider/model` survives the round trip because DSH model ids carry no slash.
      id: `${model.provider}/${model.id}`,
      label: model.name,
      description: providerName.get(model.provider) ?? model.provider,
      ...(model.description === undefined ? {} : {}),
      ...(model.reasoning?.defaultEffort === undefined || thinkingOptions.length === 0
        ? {}
        : {
            defaultThinkingOptionId: thinkingOptions.some((option) => option.id === model.reasoning?.defaultEffort)
              ? model.reasoning.defaultEffort
              : thinkingOptions[0]?.id,
          }),
      ...(thinkingOptions.length === 0 ? {} : { thinkingOptions }),
    };
  });

  // Provider-wide options, so they must be ones *every* model declares. A union
  // offered the composer efforts some models cannot serve, and every dropped
  // choice snapped the selector back to off. Models keep their own list, so the
  // ones that do reason still show their real levels.
  const thinkingOptions: ProviderThinkingOption[] = (models[0]?.thinkingOptions ?? []).filter((option) =>
    models.every((model) => (model.thinkingOptions ?? []).some((entry) => entry.id === option.id)),
  );

  const defaultModel =
    raw.defaultProvider !== undefined && raw.defaultModel !== undefined
      ? `${raw.defaultProvider}/${raw.defaultModel}`
      : models[0]?.id;

  return {
    models,
    thinkingOptions,
    fallbackRoute:
      raw.defaultProvider !== undefined && raw.defaultModel !== undefined
        ? { provider: raw.defaultProvider, model: raw.defaultModel }
        : FALLBACK_ROUTE,
    defaults: {
      models,
      modes: MODES,
      thinkingOptions,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      defaultMode: "build",
      ...(raw.defaultReasoningEffort === undefined || raw.defaultReasoningEffort === null
        ? {}
        : { defaultThinkingOption: raw.defaultReasoningEffort }),
    },
  };
}

class DshConnection implements ProviderConnection {
  readonly version = 1;
  readonly capabilities: readonly string[];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  readonly #sessions = new Map<string, DshSession>();
  readonly #childOwners = new Map<string, DshSession>();
  readonly #pluginId: string;
  /** Aborted by `close()`, which stops this connection's catalog probes. */
  readonly #stopProbes = new AbortController();
  #closed = false;

  constructor(capabilities: readonly string[], pluginId: string) {
    this.capabilities = capabilities;
    this.#pluginId = pluginId;
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async send(input: ProviderInput): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#dispatch(input);
    } catch (error) {
      if ("requestId" in input && typeof input.requestId === "string") {
        this.#emit({ type: "request.failed", requestId: input.requestId, error: providerError(error) });
      } else if ("sessionId" in input && typeof input.sessionId === "string") {
        this.#emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: { message: messageOf(error) } });
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopProbes.abort(new Error("the provider connection closed / 提供方连接已关闭"));
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#childOwners.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async #dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        return this.#catalog(input.requestId, input.cwd);
      case "sessions":
        return this.#listSessions(input);
      case "session.open":
        return this.#open(input);
      case "session.prompt":
        return this.#require(input.sessionId).prompt(input.prompt, input.sessionId);
      case "session.permission":
        this.#require(input.sessionId).resolvePermission(input.permissionId, input.response, input.sessionId);
        return;
      case "session.revert": {
        // The capability is conversation-only; a files/both request reaching
        // here would be a host bug and must fail loudly instead of pretending
        // the working tree was restored.
        const session = this.#requireRoot(input.sessionId);
        await session.revert(input.token, input.scope);
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.configure": {
        const session = this.#requireRoot(input.sessionId);
        await session.configure(input.changes);
        this.#emit({ type: "session.config", sessionId: input.sessionId, config: session.configState() });
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.interrupt": {
        await this.#require(input.sessionId).interrupt(input.sessionId);
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.can_stop_runtime": {
        // The answer is this event and nothing else. A failure reaches Paseo as
        // `request.failed` (see `send`), which keeps the runtime, as a timeout
        // does; `request.completed` would be an invalid reply.
        const canStop = await this.#require(input.sessionId).canStopRuntime(input.sessionId);
        this.#emit({ type: "session.can_stop_runtime", requestId: input.requestId, sessionId: input.sessionId, canStop });
        return;
      }
      case "session.close": {
        const owner = this.#childOwners.get(input.sessionId);
        if (owner !== undefined) {
          await owner.closeChild(input.sessionId);
          this.#emit({ type: "request.completed", requestId: input.requestId });
          return;
        }
        const session = this.#sessions.get(input.sessionId);
        this.#sessions.delete(input.sessionId);
        await session?.close();
        for (const [id, owner] of this.#childOwners) if (owner === session) this.#childOwners.delete(id);
        this.#emit({ type: "session.closed", sessionId: input.sessionId });
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default:
        // This provider declares no capability for the input, so the caller must
        // not be told it succeeded. Reporting `request.completed` here made an
        // unimplemented request indistinguishable from a finished one.
        this.#emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: `unsupported provider input "${input.type}"` },
        });
    }
  }

  async #catalog(requestId: string, cwd: string | undefined): Promise<void> {
    try {
      const display = await loadCatalog(cwd ?? process.cwd(), this.#stopProbes.signal);
      // A closed connection publishes no catalog, not even one read just before
      // it closed.
      this.#stopProbes.signal.throwIfAborted();
      this.#emit({ type: "catalog", requestId, catalog: display.defaults });
    } catch (error) {
      // A failed probe must still answer the request. Leaving it unanswered
      // made Paseo wait out its 60s timeout and report "did not answer
      // paseo/catalog" instead of the real cause — typically `dsh` missing
      // from PATH after a node version switch.
      this.#emit({
        type: "request.failed",
        requestId,
        error: providerError(error),
      });
    }
  }

  /** List DSH's stored sessions so Paseo can offer to import them. */
  async #listSessions(input: Extract<ProviderInput, { type: "sessions" }>): Promise<void> {
    const cwd = input.cwd ?? process.cwd();
    let sessions: Array<{ sessionId: string; cwd?: string; title?: string; preview?: string; updatedAt?: string }>;
    try {
      sessions = await listDshSessions(cwd, {
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    } catch (error) {
      this.#emit({ type: "request.failed", requestId: input.requestId, error: { message: messageOf(error) } });
      return;
    }
    this.#emit({
      type: "sessions",
      requestId: input.requestId,
      sessions: sessions.map((session) => ({
        persistence: { version: 1, data: { sessionId: session.sessionId } },
        cwd: session.cwd ?? cwd,
        ...(session.title === undefined ? {} : { title: session.title }),
        // A short first-message preview, so rows with the same title still differ.
        ...(session.preview === undefined ? {} : { description: session.preview }),
        ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
      })),
    });
  }

  async #open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config } = input;
    // Read through the cache rather than reuse this connection's last catalog,
    // so thinking options are checked against the profile as it is now.
    const display = await loadCatalog(config.cwd, this.#stopProbes.signal);
    const route = { ...parseRoute(config.model, display.fallbackRoute) };
    // Only an option the model offers reaches initialize; configure() below
    // drops any other with a log, as it does for live changes.
    if (config.thinkingOption === null || config.thinkingOption === "") {
      route.reasoningEffort = null;
    } else if (config.thinkingOption !== undefined && offersThinking(display.models, route, config.thinkingOption)) {
      route.reasoningEffort = config.thinkingOption;
    }

    // DSH's session id: the Paseo-minted one normally, but the native id when
    // Paseo reopens an imported session under a fresh agent id.
    const nativeId = input.persistence?.data;
    const dshSessionId =
      isRecord(nativeId) && typeof nativeId["sessionId"] === "string" ? nativeId["sessionId"] : sessionId;

    const settings = config.settings ?? {};
    // Carry the preset into `open()` so the process can queue it before the agent
    // exists: that is what puts the right id in the session header, instead of
    // writing the profile default first and correcting it afterwards.
    const initialPreset =
      typeof settings["preset"] === "string" && settings["preset"] !== "" ? settings["preset"] : undefined;
    const session = new DshSession({
      sessionId,
      dshSessionId,
      cwd: config.cwd,
      env: config.env ?? {},
      mcpServers: config.mcpServers,
      ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
      ...(config.toolPolicy === undefined ? {} : { toolPolicy: config.toolPolicy }),
      route,
      mode: config.mode ?? "build",
      ...(initialPreset === undefined ? {} : { initialPreset }),
      models: display.models,
      thinkingOptions: display.thinkingOptions,
      capabilities: this.capabilities,
      pluginId: this.#pluginId,
      emit: (event) => {
        if (event.type === "session.opened" && event.parentSessionId !== undefined) this.#childOwners.set(event.sessionId, session);
        if (event.type === "session.closed") this.#childOwners.delete(event.sessionId);
        this.#emit(event);
      },
      log: (line) => {
        process.stderr.write(`[${PROVIDER_ID}] ${line}\n`);
      },
    });
    this.#sessions.set(sessionId, session);

    try {
      await session.open();
      // Fresh agents receive the choice at initialize. A resumed agent owns a
      // durable selection, so apply only the caller's explicit overrides.
      if (config.model !== undefined || config.thinkingOption !== undefined) {
        await session.configure({
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.thinkingOption === undefined ? {} : { thinkingOption: config.thinkingOption }),
        });
      }
    }
    catch (error) {
      this.#sessions.delete(sessionId);
      await session.close();
      throw error;
    }
    // The preset already reached the process before `initialize` (see
    // `initialPreset` above), so this only covers a choice that lands later — a
    // resumed session or a pick made while the session was still opening. The
    // bridge keeps its own queued-preset fallback for the same reason.
    const preset = settings["preset"];
    if (typeof preset === "string" && preset !== "" && preset !== initialPreset) {
      try {
        await session.configure({ settings: { preset } });
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] preset "${preset}" rejected: ${messageOf(error)}\n`);
      }
    }

    // Advertise the `/` menu before `session.ready` so the composer has it the
    // moment the session is usable. A command catalog is an enhancement, never a
    // precondition: a discovery failure logs and leaves the menu empty rather
    // than failing the whole open.
    try {
      await session.loadCommands();
      await session.loadPermission();
      await session.loadPresets();
      // initialize validated the composed agent before these independent reads.
      void session.refreshUsage();
    } catch (error) {
      process.stderr.write(`[${PROVIDER_ID}] command catalog failed: ${messageOf(error)}\n`);
    }

    // Permission applies to the live agent (it runs `/permission`), so it must
    // wait until one exists.
    const permission = settings["permission"];
    if (typeof permission === "string" && permission !== "") {
      try {
        await session.configure({ settings: { permission } });
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] permission "${permission}" rejected: ${messageOf(error)}\n`);
      }
    }

    // Paseo asks for `replay` when it reopens a session (restart or import).
    // DSH's resume restores context but re-emits no events, so replay the stored
    // conversation into the timeline or the reopened session shows as empty.
    if (input.history === "replay") {
      try {
        await session.replayHistory();
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] history replay failed: ${messageOf(error)}\n`);
      }
    }

    this.#emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId,
      capabilities: [...this.capabilities],
      restoration: "core",
      cwd: config.cwd,
      // Reopen key: DSH persists the session under this exact id, so a plugin
      // reload or daemon restart resumes it. `data.sessionId` is DSH's id, which
      // stays the native one when an imported session is reopened.
      persistence: { version: 1, data: { sessionId: dshSessionId } },
      ...(config.title === undefined ? {} : { title: config.title }),
    });
    this.#emit({ type: "session.config", sessionId, config: session.configState() });
    this.#emit({ type: "session.ready", requestId: input.requestId, sessionId });
  }

  #require(sessionId: string): DshSession {
    const session = this.#sessions.get(sessionId) ?? this.#childOwners.get(sessionId);
    if (session === undefined) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  #requireRoot(sessionId: string): DshSession {
    if (this.#childOwners.has(sessionId)) throw new Error(`configuration and rewind are not supported on native child session: ${sessionId}`);
    return this.#require(sessionId);
  }

  #emit(event: ProviderEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] listener failed: ${messageOf(error)}\n`);
      }
    }
  }
}

export interface DshProviderOptions {
  /**
   * ID of the plugin that registers this provider. Paseo accepts a plugin's
   * timeline items only under that plugin's own ID, so a plugin that reuses
   * this provider must pass its ID. Defaults to `dsh-paseo`.
   */
  pluginId?: string;
}

/** The provider registration Paseo installs for `dsh --profile paseo`. */
export function createDshProvider(options: DshProviderOptions = {}): ProviderRegistration {
  const pluginId = options.pluginId ?? DEFAULT_PLUGIN_ID;
  return {
    id: PROVIDER_ID,
    label: "DeepSeek Harness (native)",
    icon: "icon.svg",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return new DshConnection(capabilities, pluginId);
    },
  };
}

export { profileName };
