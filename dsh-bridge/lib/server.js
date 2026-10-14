/**
 * A Paseo-drivable DeepSeek Harness runtime over one JSON-RPC transport peer.
 *
 * The surface is the shipped SDK contract (`initialize`, `session/prompt`,
 * `shutdown` plus the `session.event` / `session.status` notifications) with
 * three additions on top:
 *
 * - `paseo/plan/get` and `paseo/plan/set` drive the mounted plan-mode service.
 * - `paseo/config/set` mutates the live per-agent model selection, which is how
 *   the thinking-effort control takes effect without restarting the runtime.
 * - `paseo/usage` reports the session's current context occupancy from DSH's
 *   own replay-aware token meter, which is what the composer's usage readout
 *   needs to show a context window.
 * - `paseo/question` is a *server -> client request*: the bridge sends it when
 *   the model calls the user-question tool and waits for the answer batch.
 *
 * @module dsh-paseo-bridge/server
 */
import { resolve } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

function encodedImage(block) {
  return block.type === 'image' && 'data' in block;
}

/**
 * Media type read from the raster's own magic bytes, or undefined when the
 * bytes are not one of the formats DSH admits.
 *
 * The prompt's declared `mimeType` is not trustworthy: Paseo derives it from
 * the upload's filename extension, so a JPEG saved as `foo.png` arrives as
 * `{mimeType: "image/png", data: <jpeg>}`. DSH verifies the declared type
 * against the decoded bytes and refuses a mismatch, which would reject a
 * perfectly readable picture. The bytes are the authoritative answer, and this
 * is a trusted translator rather than a caller asserting content, so read the
 * type from them.
 */
function sniffImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

async function durablePromptContent(ctx, blocks) {
  const images = blocks.filter(encodedImage);
  if (images.length === 0) return blocks;
  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('image prompt requires an attachment store');
  const refs = await admitEncodedImages(
    attachments,
    images.map((image) => {
      const bytes = Buffer.from(typeof image.data === 'string' ? image.data : '', 'base64');
      // Prefer the bytes; keep the declared type only when they are unreadable,
      // so an unsupported format still fails loudly with DSH's own error.
      const mediaType = sniffImageMediaType(bytes) ?? image.mimeType;
      return { data: image.data, mediaType };
    }),
  );
  let next = 0;
  return blocks.map((block) =>
    encodedImage(block) ? { type: 'image', attachment: refs[next++] } : block,
  );
}

function effortOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return ReasoningEffortId(value);
}

/** Await a promise, rejecting if it has not settled within `ms`. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class PaseoHarnessServer {
  constructor(ctx, transport, options = {}) {
    this.ctx = ctx;
    this.transport = transport;
    this.options = options;

    this.cwd = process.cwd();
    // Deliberately unset: a hardcoded route would silently pick a provider for a
    // deployment that never configured one. `initialize` falls back to the
    // profile's own default instead, and fails loudly when there is none.
    this.provider = options.provider;
    this.model = options.model;
    this.reasoningEffort = effortOf(options.reasoningEffort);
    this.maxTokens = undefined;

    /**
     * Plan-mode intent recorded before a session's agent exists. Paseo opens a
     * session purely to read its composer features and never prompts it, so plan
     * and route changes must be queueable instead of requiring a live agent.
     */
    this.pendingPlanMode = false;

    /**
     * sessionId -> preset id chosen before its agent existed. A preset is a
     * creation-time choice (DSH locks it once the session's first turn starts),
     * so a pick made while the composer is still being configured is remembered
     * here and applied when the agent is created.
     */
    this.pendingPresets = new Map();

    /** sessionId -> { selection, dispose } for live per-agent model control. */
    this.controls = new Map();
    /** sessionId -> { handle } for agents this server owns. */
    this.sessions = new Map();
    this.sessionCreations = new Map();
    this.disposers = [];
    this.initialized = false;
    this.shuttingDown = false;
    this.shutdownTask = undefined;
    this.llmFiber = undefined;

    this.disposers.push(
      ctx.on('session/event', (session, event) => {
        this.transport.notify('session.event', { sessionId: String(session.id), event });
      }),
    );
    this.disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        this.transport.notify('session.status', { sessionId: String(agent.session.id), status });
      }),
    );
  }

  /** Whether this server owns the live agent behind a session id. */
  owns(sessionId) {
    return this.sessions.has(sessionId) || this.sessionCreations.has(sessionId);
  }

  /**
   * The route the profile itself configured, used when neither the caller nor
   * the constructor named one. Undefined when no default-model service is
   * composed, which callers must treat as an error rather than guess around.
   */
  profileDefault() {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') return selection;
    } catch {
      /* the deployment composes no default-model service */
    }
    return undefined;
  }

  /** Validate the route and record the defaults applied to every created agent. */
  async initialize(params) {
    if (params.cwd === undefined) throw new TypeError('initialize requires cwd');
    if (params.reasoningEffort !== undefined) effortOf(params.reasoningEffort);
    const cwd = resolve(params.cwd);
    const fallback = this.profileDefault();
    const provider = params.provider ?? this.provider ?? fallback?.provider;
    const model = params.model ?? this.model ?? fallback?.model;
    if (provider === undefined || model === undefined) {
      throw new Error('no provider/model was given and this profile configures no default model');
    }
    const reasoningEffort = params.reasoningEffort !== undefined
      ? effortOf(params.reasoningEffort)
      : this.reasoningEffort
        ?? (fallback?.reasoningEffort === undefined ? undefined : effortOf(fallback.reasoningEffort));

    if (!this.hasAdapterFor(provider)) {
      const adapter = this.options.adapters?.[provider];
      if (adapter === undefined) {
        throw new Error(
          `no adapter registered for provider "${provider}"; declare it in the profile's llm route `
          + 'or list it under the paseo-bridge `adapters` config',
        );
      }
      const mod = await import(adapter);
      this.llmFiber = await this.ctx.plugin(mod);
    }

    await this.ctx.get('llm').resolveCallConfig({
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
    });

    this.cwd = cwd;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = params.maxTokens;
    this.initialized = true;
    return {
      serverInfo: { name: 'deepseek-harness-paseo-bridge', version: '0.1.0' },
      route: { provider, model, reasoningEffort: reasoningEffort ?? null },
    };
  }

  /** Queue one identified prompt for a session, creating its agent on first use. */
  async prompt(params) {
    if (!this.initialized) throw new Error('paseo bridge is not initialized');
    const rec = await this.getOrCreateSession(params.sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    const content = await durablePromptContent(this.ctx, params.contentBlocks ?? []);
    this.assertLiveAgent(rec, params.sessionId);
    const message = createUserMessage({ content, source: { kind: 'user' } });
    // A steer belongs inside the turn already running; a plain prompt starts the
    // next one. Without this distinction an interjection queues behind the very
    // turn it was meant to correct.
    if (params.delivery === 'steer') rec.handle.agent.steer(message);
    else rec.handle.agent.followup(message);
    return { messageId: String(message.id) };
  }

  /**
   * Cancel the running turn while keeping the session and its history alive, so
   * the conversation can continue afterwards.
   */
  async cancel(params) {
    const rec = this.requireSession(params.sessionId);
    rec.handle.agent.cancel({ kind: 'user' });
    return { canceled: true };
  }

  /** Report the mounted plan state for one session, or the queued intent before it exists. */
  async planGet(params) {
    const planMode = this.ctx.get('planMode');
    if (planMode === undefined) return { available: false, active: false, pending: false };
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) {
      return { available: true, active: this.pendingPlanMode === true, pending: false };
    }
    this.assertLiveAgent(rec, params.sessionId);
    const state = planMode.get(rec.handle.agent);
    return { available: true, active: state.active === true, pending: state.pending === true };
  }

  /** Select plan mode for one session, queueing the intent until its agent exists. */
  async planSet(params) {
    const planMode = this.ctx.get('planMode');
    if (planMode === undefined) throw new Error('plan mode is not mounted in this profile');
    const active = params.active === true;
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) {
      this.pendingPlanMode = active;
      return { available: true, active, pending: false, outcome: 'queued' };
    }
    this.assertLiveAgent(rec, params.sessionId);
    const outcome = planMode.set(rec.handle.agent, active);
    const state = planMode.get(rec.handle.agent);
    return {
      available: true,
      active: state.active === true,
      pending: state.pending === true,
      outcome,
    };
  }

  /** Mutate the per-agent route, or the default route while no agent exists yet. */
  async configSet(params) {
    if (typeof params.preset === 'string' && params.preset !== '') {
      await this.setPreset(params.sessionId, params.preset);
    }
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) {
      if (typeof params.provider === 'string') this.provider = params.provider;
      if (typeof params.model === 'string') this.model = params.model;
      if (params.reasoningEffort !== undefined) {
        this.reasoningEffort = effortOf(params.reasoningEffort);
      }
      return {
        provider: this.provider,
        model: this.model,
        reasoningEffort: this.reasoningEffort ?? null,
        preset: this.currentPreset(params.sessionId),
      };
    }
    this.assertLiveAgent(rec, params.sessionId);
    const selection = rec.control.selection;
    const next = { ...(selection.current ?? {}) };
    if (typeof params.provider === 'string') next.provider = params.provider;
    if (typeof params.model === 'string') next.model = params.model;
    if (params.reasoningEffort !== undefined) {
      const effort = effortOf(params.reasoningEffort);
      if (effort === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = effort;
    }
    if (next.provider === undefined || next.model === undefined) {
      throw new Error('model selection requires both provider and model');
    }
    selection.current = next;
    return {
      ...next,
      reasoningEffort: next.reasoningEffort ?? null,
      preset: this.currentPreset(params.sessionId),
    };
  }

  /** The preset a session runs (chosen, else the stored projection, else default). */
  currentPreset(sessionId) {
    const service = this.ctx.get('agentPresets');
    if (service === undefined) return null;
    // A preset chosen or applied in this process is authoritative: the session
    // projection folds the selection event asynchronously, so reading it right
    // after a switch would still show the previous value.
    const chosen = this.pendingPresets.get(sessionId);
    if (chosen !== undefined) return chosen;
    const rec = this.sessions.get(sessionId);
    if (rec !== undefined) {
      try {
        const stored = this.ctx.get('sessionProjections')?.stateOf(rec.handle.agent.session, 'agentPreset');
        if (stored !== undefined) return stored;
      } catch {
        /* projection unavailable; fall through to the default value */
      }
    }
    return service.defaultId ?? null;
  }

  /**
   * Choose a session's agent preset. Before the agent exists the choice is
   * queued; once it does, DSH's `select` applies it — and refuses once the
   * session's first turn has started, which is the lock the composer must honor.
   */
  async setPreset(sessionId, id) {
    const service = this.ctx.get('agentPresets');
    if (service === undefined) throw new Error('agent presets are not mounted in this profile');
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      this.pendingPresets.set(sessionId, id);
      return;
    }
    this.assertLiveAgent(rec, sessionId);
    const applied = await service.select(rec.handle.agent, id);
    this.pendingPresets.set(sessionId, applied ?? id);
  }

  /** Report the configured agent presets and the one this session runs. */
  async presets(params) {
    const service = this.ctx.get('agentPresets');
    if (service === undefined) return { available: false, presets: [], current: null, default: null };
    const list = await service.list();
    return {
      available: true,
      default: service.defaultId ?? null,
      current: this.currentPreset(params.sessionId),
      presets: list.map((preset) => ({
        id: preset.id,
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      })),
    };
  }

  /**
   * List the DSH sessions a user can import into Paseo. Reads the persistence
   * backend directly: the session-query corpus is not mounted for listing here
   * (`openAt: never`), and it hangs rather than answering. Titles are
   * best-effort; a missing title never hides an importable session.
   */
  async listSessions(params = {}) {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return { available: false, sessions: [] };
    let snapshots = [];
    try {
      snapshots = await persistence.list();
    } catch {
      snapshots = [];
    }
    const query = typeof params.query === 'string' && params.query !== '' ? params.query.toLowerCase() : undefined;
    const cwdFilter = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : undefined;
    const candidates = [];
    for (const snapshot of snapshots) {
      const id = snapshot?.header?.id === undefined ? undefined : String(snapshot.header.id);
      if (id === undefined || id === '') continue;
      if (cwdFilter !== undefined && snapshot.header.cwd !== cwdFilter) continue;
      if (query !== undefined && !id.toLowerCase().includes(query)) continue;
      candidates.push(snapshot);
    }
    candidates.sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0));
    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 40;
    const picked = candidates.slice(0, limit);
    // A title and a first-message preview make sessions distinguishable; both
    // come from the log prefix, read concurrently so a long list stays quick.
    const summaries = await Promise.all(picked.map((snapshot) => this.#sessionSummary(persistence, snapshot)));
    return { available: true, sessions: summaries };
  }

  /** Read one session's log prefix for its title and first user message. */
  async #sessionSummary(persistence, snapshot) {
    const id = String(snapshot.header.id);
    const row = {
      sessionId: id,
      ...(snapshot.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }),
      ...(snapshot.header.createdAt === undefined
        ? {}
        : { updatedAt: new Date(snapshot.header.createdAt).toISOString() }),
    };
    let handle;
    try {
      handle = await withTimeout(persistence.open(id, 'read'), 10000, 'opening session summary');
      const result = await withTimeout(handle.read(0, 200), 10000, 'reading session summary');
      let title;
      let preview;
      for (const event of result.events ?? []) {
        if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
          title = event.data.title;
        }
        if (preview === undefined && event.type === 'user/message' && event.data?.source?.kind === 'user') {
          const text = (event.data.content ?? [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text !== '') preview = text.slice(0, 120);
        }
      }
      if (typeof title === 'string' && title !== '') row.title = title;
      if (typeof preview === 'string' && preview !== '') row.preview = preview;
    } catch {
      /* A session that will not read is still listed, just without a summary. */
    } finally {
      try {
        await handle?.close();
      } catch {
        /* idempotent close */
      }
    }
    return row;
  }

  /**
   * Read one stored session's raw event log, for replay into a Paseo timeline.
   * Read-only, so it works while a live agent still owns the session.
   */
  async history(params) {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return { available: false, events: [] };
    let handle;
    try {
      // A session mid-write can stall a read; bound it so a stuck read never
      // stalls the session open that asked for the replay.
      handle = await withTimeout(persistence.open(params.sessionId, 'read'), 15000, 'opening session history');
    } catch {
      // Unknown/unmaterialized session (or a stalled read): an empty history is
      // the honest answer.
      return { available: true, events: [] };
    }
    try {
      const result = await withTimeout(handle.read(), 15000, 'reading session history');
      return {
        available: true,
        events: (result.events ?? []).map((event) => ({
          type: event.type,
          ...(event.seq === undefined ? {} : { seq: event.seq }),
          ...(event.time === undefined ? {} : { time: event.time }),
          data: event.data,
        })),
      };
    } catch {
      return { available: true, events: [] };
    } finally {
      try {
        await handle.close();
      } catch {
        /* handle close is idempotent; a failure here must not mask the read */
      }
    }
  }

  /**
   * The slash-commands the composer may offer for one session: the registered
   * human commands plus every user-invocable skill.
   *
   * Skills ship a `userInvocable` policy precisely so a human-facing catalog can
   * advertise them next to commands, and DSH injects a skill from a bare
   * `/name` token in user input. They are not registered commands, so the two
   * are tagged and handled differently when run.
   */
  async commands(params) {
    const rec = await this.getOrCreateSession(params.sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    const agent = rec.handle.agent;
    const out = [];
    const seen = new Set();
    const commands = this.ctx.get('commands');
    if (commands !== undefined) {
      for (const command of commands.list(agent)) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        out.push({
          name: command.name,
          description: command.description,
          ...(command.input?.hint === undefined ? {} : { argumentHint: command.input.hint }),
          kind: 'command',
        });
      }
    }
    const skills = this.ctx.get('skills');
    if (skills !== undefined) {
      let list;
      try {
        list = await skills.list({ cwd: this.cwd, scope: agent });
      } catch {
        // A skill source that fails discovery must not take commands down with it.
        list = [];
      }
      for (const skill of list) {
        if (skill.invocation?.userInvocable !== true) continue;
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        out.push({ name: skill.name, description: skill.description, kind: 'skill' });
      }
    }
    return { commands: out };
  }

  /**
   * Run one registered command for a session. A skill is not handled here: the
   * plugin sends its `/name` line as ordinary user input, which is how DSH's own
   * `skill` tool injects it.
   */
  async runCommand(params) {
    const rec = this.requireSession(params.sessionId);
    const commands = this.ctx.get('commands');
    if (commands === undefined) throw new Error('command registry is not mounted in this profile');
    const line = typeof params.arguments === 'string' && params.arguments.trim() !== ''
      ? `/${params.name} ${params.arguments}`
      : `/${params.name}`;
    const execution = await commands.execute(rec.handle.agent, line, [], new AbortController().signal);
    if (execution === undefined) throw new Error(`unknown command "${params.name}"`);
    return {
      kind: execution.result.kind,
      ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
    };
  }

  /** Report the session's permission preset and the switchable ones. */
  async permission(params) {
    const service = this.ctx.get('permissionPresets');
    if (service === undefined) return { available: false, current: null, presets: [] };
    const rec = await this.getOrCreateSession(params.sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    return {
      available: true,
      current: service.current(rec.handle.agent.session),
      presets: [...service.names],
    };
  }

  /**
   * Report the session's current context occupancy for the composer's usage
   * readout.
   *
   * The figure is DSH's own replay-aware token meter, never a sum of the log:
   * `contextPressure` pairs the newest provider-reported prompt pressure — plus
   * the surface's movement since that sample — with the newest known route
   * capacity, which is exactly what DSH's own context meter displays. Summing
   * the log's `tokenUsage` would instead report cumulative billing: it
   * overstates a compacted session and counts cache reads twice. Capacity is
   * resolved for the session's *current* route, so a model switch cannot leave
   * the previous model's window paired with the new model's pressure. Every
   * unknown field is omitted rather than defaulted, because a fabricated
   * occupancy is worse than none.
   */
  async usage(params) {
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) return { available: false };
    this.assertLiveAgent(rec, params.sessionId);
    const session = rec.handle.agent.session;
    const loggedRoute = session.requestContext?.();
    const selection = this.controls.get(params.sessionId)?.selection?.current;
    const route = selection ?? loggedRoute;
    const sameRoute = route?.provider === loggedRoute?.provider && route?.model === loggedRoute?.model;
    const pressure = this.#contextPressure(session);
    // A prior model's pressure/limit must not be presented as a measurement of
    // the newly selected model. Reprice via DSH when the route changed.
    const usedTokens = sameRoute
      ? pressure?.projectedTokens ?? pressure?.pressureTokens ?? this.#measuredTokens(session)
      : this.#measuredTokens(session, route);
    const contextWindow = await this.#routeContextWindow(route);
    return {
      available: true,
      ...(Number.isSafeInteger(usedTokens) && usedTokens >= 0 ? { usedTokens } : {}),
      ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    };
  }

  /**
   * DSH's `contextPressure` projection — the newest pressure sample and route
   * capacity, read through the unit's client view so `projectedTokens` (which
   * folds the surface movement a compaction produces) is present.
   */
  #contextPressure(session) {
    try {
      return this.ctx.get('sessionProjections')?.snapshot(session, ['contextPressure'])?.values
        ?.contextPressure;
    } catch {
      return undefined;
    }
  }

  /** Current request pressure straight from the token meter, before any sample exists. */
  #measuredTokens(session, route) {
    try {
      const header = session.requestHeader?.();
      const requestHeader = route?.provider !== undefined && route?.model !== undefined
        ? {
          ...(header?.tools === undefined ? {} : { tools: header.tools }),
          config: {
            ...(header?.config ?? {}),
            provider: route.provider,
            model: route.model,
          },
        }
        : undefined;
      const measured = this.ctx.get('tokenMeter')?.measure(session, requestHeader);
      return typeof measured?.totalTokens === 'number' ? measured.totalTokens : undefined;
    } catch {
      return undefined;
    }
  }

  /** The live route's resolved context capacity, preferring the current selection. */
  async #routeContextWindow(route) {
    if (route?.provider === undefined || route?.model === undefined) return undefined;
    try {
      const info = await this.ctx.get('llm')?.resolveModelInfo(route.provider, route.model);
      const contextWindow = info?.context?.contextWindow;
      return typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined;
    } catch {
      return undefined;
    }
  }

  /** Report the routes and models the runtime can serve, for the Paseo catalog. */
  async catalog() {
    const llm = this.ctx.get('llm');
    if (llm === undefined) {
      return { providers: [], models: [], planMode: this.ctx.get('planMode') !== undefined };
    }
    const providers = llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name }));
    const models = [];
    // A provider with no credential, or a model with no resolved capability
    // record, reports nothing; it must not take the whole catalog down.
    for (const provider of providers) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          let reasoning;
          try {
            const info = await llm.resolveModelInfo(provider.id, model.id);
            if (info?.reasoning !== undefined) {
              reasoning = {
                ...(info.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: String(info.reasoning.defaultEffort) }),
                efforts: (info.reasoning.efforts ?? []).map((effort) => ({
                  id: String(effort.id),
                  name: effort.name,
                  ...(effort.description === undefined ? {} : { description: effort.description }),
                })),
              };
            }
          } catch {
            /* model declares no reasoning control */
          }
          models.push({
            provider: model.provider,
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(reasoning === undefined ? {} : { reasoning }),
          });
        }
      } catch {
        /* provider advertises no usable catalog */
      }
    }
    // A catalog read happens before any session pins a route, so the profile's
    // configured default is the honest answer.
    let defaultProvider = this.provider;
    let defaultModel = this.model;
    let defaultReasoningEffort = this.reasoningEffort ?? null;
    const selection = this.profileDefault();
    if (selection !== undefined) {
      defaultProvider = selection.provider;
      defaultModel = selection.model;
      defaultReasoningEffort = selection.reasoningEffort ?? null;
    }
    return {
      providers,
      models,
      defaultProvider,
      defaultModel,
      defaultReasoningEffort,
      planMode: this.ctx.get('planMode') !== undefined,
    };
  }

  /** Dispose server-owned agents, the fallback adapter and subscriptions. */
  shutdown() {
    this.shutdownTask ??= this.performShutdown();
    return this.shutdownTask;
  }

  async performShutdown() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.sessionCreations.values()]);
    this.sessionCreations.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    const failures = [];
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const rec of records) {
      try {
        rec.control?.dispose?.();
      } catch (error) {
        failures.push(error);
      }
    }
    this.controls.clear();
    const teardown = await Promise.allSettled([
      ...records.map((rec) => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined
        ? []
        : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ]);
    this.llmFiber = undefined;
    failures.push(
      ...teardown.filter((result) => result.status === 'rejected').map((result) => result.reason),
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'paseo bridge teardown failed');
    return {};
  }

  /** Dispatch one incoming JSON-RPC request to its typed handler. */
  async handleRequest(method, params) {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'session/prompt':
        return this.prompt(params);
      case 'session/cancel':
        return this.cancel(params);
      case 'paseo/catalog':
        return this.catalog();
      case 'paseo/commands':
        return this.commands(params);
      case 'paseo/command/run':
        return this.runCommand(params);
      case 'paseo/permission':
        return this.permission(params);
      case 'paseo/usage':
        return this.usage(params);
      case 'paseo/presets':
        return this.presets(params);
      case 'paseo/sessions':
        return this.listSessions(params);
      case 'paseo/history':
        return this.history(params);
      case 'paseo/plan/get':
        return this.planGet(params);
      case 'paseo/plan/set':
        return this.planSet(params);
      case 'paseo/config/set':
        return this.configSet(params);
      case 'shutdown':
        return this.shutdown();
      default:
        throw new Error(`unknown paseo bridge method: ${method}`);
    }
  }

  requireSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) throw new Error(`unknown or not-yet-created session: ${sessionId}`);
    this.assertLiveAgent(rec, sessionId);
    return rec;
  }

  assertLiveAgent(rec, sessionId) {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`);
    }
  }

  async getOrCreateSession(sessionId) {
    if (this.shuttingDown) throw new Error('paseo bridge is shutting down');
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const pending = this.sessionCreations.get(sessionId);
    if (pending !== undefined) return pending;
    const creation = this.createSession(sessionId);
    this.sessionCreations.set(sessionId, creation);
    creation.then(
      () => this.sessionCreations.delete(sessionId),
      () => this.sessionCreations.delete(sessionId),
    );
    return creation;
  }

  async createSession(sessionId) {
    // Mirrors the ACP adapter: the durable option carries the initial route and
    // a scoped mutable selection ref installed during setup owns later switches.
    const initial = {
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort }),
    };
    const control = { selection: { current: initial, assembled: undefined }, dispose: undefined };
    const installSelection = (agentCtx) => {
      control.dispose = installModelSelection(agentCtx, control.selection);
    };

    // A session that runs under an agent preset mounts it during setup, exactly
    // like api-session-controller's composeAgent. Without a preset registry in
    // the profile this is skipped and the session composes at the host plane as
    // before, so preset support stays opt-in.
    const presets = this.ctx.get('agentPresets');
    let agentPreset;
    let setup = installSelection;
    if (presets !== undefined) {
      const resolvedId = (await presets.resolve(this.pendingPresets.get(sessionId))).id;
      agentPreset = resolvedId;
      setup = async (agentCtx, agent) => {
        installSelection(agentCtx);
        await presets.mount(agentCtx, resolvedId);
      };
    }

    const agentOptions = {
      ...initial,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
    const meta = { cwd: this.cwd, ...(agentPreset === undefined ? {} : { agentPreset }) };
    let handle;
    try {
      handle = await this.ctx.agents.create({
        sessionId: brandString(sessionId),
        meta,
        agentOptions,
        setup,
      });
    } catch (error) {
      // DSH persists sessions, so opening an id it already knows is a conflict
      // rather than a failure. Paseo re-opens an agent with its existing session
      // id on refresh and reconnect, so resume the persisted session and keep
      // the conversation alive instead of failing the open.
      if (!/already exists/i.test(String(error?.message ?? error))) throw error;
      // A resumed session keeps the preset it was created with; re-mount the same
      // one so its projected composition stays consistent.
      let resumeSetup = installSelection;
      if (presets !== undefined) {
        const session = this.ctx.get('sessions')?.get(brandString(sessionId));
        let storedPreset;
        try {
          storedPreset = session === undefined ? undefined : this.ctx.get('sessionProjections')?.stateOf(session, 'agentPreset');
        } catch {
          storedPreset = undefined;
        }
        const resolvedId = (await presets.resolve(storedPreset ?? this.pendingPresets.get(sessionId))).id;
        resumeSetup = async (agentCtx) => {
          installSelection(agentCtx);
          await presets.mount(agentCtx, resolvedId);
        };
      }
      handle = await this.ctx.agents.resume({
        resumeSessionId: brandString(sessionId),
        agentOptions,
        setup: resumeSetup,
      });
    }
    const rec = { handle, control };
    this.controls.set(sessionId, control);
    this.sessions.set(sessionId, rec);
    if (this.pendingPlanMode) {
      const planMode = this.ctx.get('planMode');
      if (planMode !== undefined) planMode.set(handle.agent, true);
    }
    return rec;
  }

  hasAdapterFor(provider) {
    return this.ctx.get('llm')?.listProviders().some((entry) => entry.id === provider) ?? false;
  }
}
