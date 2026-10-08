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
import { DshProcess, type DshCatalog } from "./dsh-process";
import { DshSession, MODES, parseRoute } from "./session";

const CAPABILITIES = [
  "prompt.message",
  // Without this Paseo refuses to send any prompt carrying an image, so an
  // attached picture never reaches the bridge (the same class of silent loss as
  // an un-declared `prompt.steer`). The bridge already admits image blocks into
  // DSH's attachment store; declaring the capability is what makes Paseo use it.
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "permission",
] as const;

/** Provider id registered with Paseo; distinct from the ACP `deepseek-harness` entry. */
export const PROVIDER_ID = "deepseek-harness-native";

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

/** The DSH profile that must exist for this provider to work. */
function profileName(): string {
  return process.env.DSH_PASEO_PROFILE ?? "paseo";
}

let catalogCache: { at: number; cwd: string; value: DisplayCatalog } | undefined;

interface DisplayCatalog {
  models: ProviderModel[];
  thinkingOptions: ProviderThinkingOption[];
  /** The profile's configured default route, used when a session names none. */
  fallbackRoute: { provider: string; model: string };
  defaults: ProviderCatalog;
}

/** Read the runtime catalog through a short-lived process and cache it. */
async function loadCatalog(cwd: string): Promise<DisplayCatalog> {
  if (catalogCache !== undefined && catalogCache.cwd === cwd && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.value;
  }
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
  try {
    await probe.start();
    const raw: DshCatalog = await probe.catalog();
    const value = toDisplayCatalog(raw);
    catalogCache = { at: Date.now(), cwd, value };
    return value;
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
  #display: DisplayCatalog | undefined;
  #closed = false;

  constructor(capabilities: readonly string[]) {
    this.capabilities = capabilities;
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
      const message = messageOf(error);
      if ("requestId" in input && typeof input.requestId === "string") {
        this.#emit({ type: "request.failed", requestId: input.requestId, error: { message } });
      } else if ("sessionId" in input && typeof input.sessionId === "string") {
        this.#emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: { message } });
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async #dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        return this.#catalog(input.requestId, input.cwd);
      case "session.open":
        return this.#open(input);
      case "session.prompt":
        return this.#require(input.sessionId).prompt(input.prompt);
      case "session.permission":
        this.#require(input.sessionId).resolvePermission(input.permissionId, input.response);
        return;
      case "session.configure": {
        const session = this.#require(input.sessionId);
        await session.configure(input.changes);
        this.#emit({ type: "session.config", sessionId: input.sessionId, config: session.configState() });
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.interrupt": {
        await this.#require(input.sessionId).interrupt();
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        const session = this.#sessions.get(input.sessionId);
        this.#sessions.delete(input.sessionId);
        await session?.close();
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
    const display = await loadCatalog(cwd ?? process.cwd());
    this.#display = display;
    this.#emit({ type: "catalog", requestId, catalog: display.defaults });
  }

  async #open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config } = input;
    const display = this.#display ?? (await loadCatalog(config.cwd));
    this.#display = display;

    const route = parseRoute(config.model, display.fallbackRoute);
    const session = new DshSession({
      sessionId,
      cwd: config.cwd,
      env: config.env ?? {},
      route,
      mode: config.mode ?? "build",
      models: display.models,
      thinkingOptions: display.thinkingOptions,
      emit: (event) => this.#emit(event),
      log: (line) => {
        process.stderr.write(`[${PROVIDER_ID}] ${line}\n`);
      },
    });
    this.#sessions.set(sessionId, session);

    await session.open();

    if (config.thinkingOption !== undefined) {
      await session.configure({ thinkingOption: config.thinkingOption });
    }

    this.#emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId,
      capabilities: [...this.capabilities],
      restoration: "core",
      cwd: config.cwd,
      ...(config.title === undefined ? {} : { title: config.title }),
    });
    this.#emit({ type: "session.config", sessionId, config: session.configState() });
    this.#emit({ type: "session.ready", requestId: input.requestId, sessionId });
  }

  #require(sessionId: string): DshSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown session: ${sessionId}`);
    return session;
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

/** The provider registration Paseo installs for `dsh --profile paseo`. */
export function createDshProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "DeepSeek Harness (native)",
    icon: "icon.svg",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return new DshConnection(capabilities);
    },
  };
}

export { profileName };
