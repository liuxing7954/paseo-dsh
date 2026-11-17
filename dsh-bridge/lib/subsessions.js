/** Native session lineage and the exact tool execution that created it. */
import { AsyncLocalStorage } from 'node:async_hooks';

export class Subsessions {
  constructor(ctx, isRoot, notify) {
    this.ctx = ctx;
    this.isRoot = isRoot;
    this.notify = notify;
    this.observed = new Map();
    this.calls = new Map();
    this.workflows = new Map();
    this.execution = new AsyncLocalStorage();
    this.disposers = [
      ctx.on('tools/execute', (exec, next) => {
        if (exec.agent === undefined) return next();
        const input = exec.arguments;
        return this.execution.run({
          parentSessionId: String(exec.agent.session.id),
          toolCallId: String(exec.callId),
          rootToolCallId: String(exec.rootCallId ?? exec.callId),
          toolName: exec.name,
          ...(typeof input?.description === 'string' ? { toolTitle: input.description }
            : typeof input?.meta?.name === 'string' ? { toolTitle: input.meta.name } : {}),
        }, next);
      }),
      ctx.on('session/created', session => {
        if (!this.owns(session)) return;
        const envelope = this.envelope(session);
        if (envelope.origin === 'subagent' && envelope.toolCallId !== undefined) notify('session.child', envelope);
      }),
      ctx.on('workflow/start', info => {
        const call = this.execution.getStore();
        if (call !== undefined) this.workflows.set(String(info.id), call);
      }),
      ctx.on('workflow/agent-start', (info, child) => {
        const call = this.workflows.get(String(info.id));
        const session = this.session(String(child.childId));
        // Workflow workers can cross an IPC boundary and lose async context.
        // Their explicit member event restores correlation by id, never timing.
        if (call === undefined || session?.header.parentSession !== call.parentSessionId) return;
        this.calls.set(String(session.id), call);
        notify('session.child', this.envelope(session));
      }),
      ctx.on('workflow/end', info => { this.workflows.delete(String(info.id)); }),
    ];
  }

  session(id) {
    return this.observed.get(id) ?? this.ctx.get('agents')?.get(id)?.session ?? this.ctx.get('sessions')?.get(id);
  }

  owns(value) {
    let id = typeof value === 'string' ? value : String(value.id);
    let session = typeof value === 'string' ? this.session(id) : value;
    const seen = new Set();
    while (!seen.has(id)) {
      if (this.isRoot(id)) return true;
      seen.add(id);
      if (session?.header.origin !== 'subagent' || session.header.parentSession === undefined) return false;
      id = String(session.header.parentSession);
      session = this.session(id);
    }
    return false;
  }

  envelope(session, extra = {}) {
    const id = String(session.id);
    this.observed.set(id, session);
    const header = session.header ?? {};
    const call = this.execution.getStore();
    if (!this.calls.has(id) && header.origin === 'subagent' && call?.parentSessionId === header.parentSession) {
      this.calls.set(id, call);
    }
    return {
      sessionId: id,
      ...(header.parentSession === undefined ? {} : { parentSessionId: String(header.parentSession) }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
      ...this.calls.get(id),
      ...extra,
    };
  }

  dispose() {
    for (const off of this.disposers.splice(0)) off();
    this.execution.disable();
    this.observed.clear();
    this.calls.clear();
    this.workflows.clear();
  }
}
