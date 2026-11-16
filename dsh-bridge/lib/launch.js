/** Paseo's launch-only configuration, scoped to this one bridge process. */
import { createHash } from 'node:crypto';

// Same naming rules as dsh-acp's normalizeServerName and dsh-mcp-client's
// publicToolName. Keep the original server -> namespace mapping for grants;
// never parse a model-facing tool name to recover its MCP identity.
export function serverNamespace(name) {
  if (name.trim() === '' || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid MCP server name');
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name)) return name;
  const stem = name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'server';
  return `${stem}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`.slice(0, 32);
}

export function publicToolName(server, tool) {
  const joined = `mcp__${server}__${tool}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined === normalized && joined.length <= 64) return joined;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

export function launchMcpConfigs(servers = {}, cwd) {
  const names = new Set();
  return Object.entries(servers).map(([name, server]) => {
    const serverName = serverNamespace(name);
    if (names.has(serverName)) throw new Error(`MCP namespace collision for "${name}"`);
    names.add(serverName);
    const common = { serverName, failOnStartupError: true };
    if (server.type === 'stdio') {
      return { name, config: { ...common, transport: 'stdio', command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd } };
    }
    if (server.type === 'http') {
      let url;
      try { url = new URL(server.url); } catch { /* reported without credentials */ }
      if (url?.protocol !== 'http:' && url?.protocol !== 'https:') throw new Error(`MCP server "${name}" requires an absolute HTTP(S) URL`);
      return { name, config: { ...common, transport: 'streamable-http', url: server.url, headers: server.headers ?? {} } };
    }
    throw new Error(`MCP server "${name}": unsupported transport "${server.type}"; DSH supports stdio and Streamable HTTP`);
  });
}

/** Exact grants can resolve an ask, but never replace a denial or cancellation. */
export function preapprovalGate(grants, matchesIdentity = () => true) {
  return async (exec, next) => {
    const decision = await next();
    return decision.kind === 'ask' && grants.has(exec.name) && matchesIdentity(exec) ? { kind: 'allow' } : decision;
  };
}

/** Follow dsh-acp's validated, awaited MCP mounting; preserve preset restrictions. */
export async function mountLaunchContext(ctx, params) {
  const configs = launchMcpConfigs(params.mcpServers, params.cwd);
  const grants = new Set();
  const namespaces = new Map(configs.map(({ name, config }) => [name, config.serverName]));
  for (const grant of params.toolPolicy?.preapproved ?? []) {
    const namespace = namespaces.get(grant.server);
    if (grant.kind !== 'mcp' || namespace === undefined || typeof grant.tool !== 'string' || grant.tool === '') {
      throw new Error('MCP preapproval requires an exact tool and a server in the same launch configuration');
    }
    grants.add(publicToolName(namespace, grant.tool));
  }
  const disposers = [];
  const dispose = async () => {
    const results = await Promise.allSettled(disposers.splice(0).reverse().map(fn => Promise.resolve().then(fn)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Paseo launch context cleanup failed');
  };
  try {
    if (configs.length > 0) {
      const McpClient = await import('@deepseek-ai/dsh-mcp-client');
      // Validate the entire list before starting any connection.
      const parsed = configs.map(({ name, config }) => {
        try { return { name, config: McpClient.Config(config) }; }
        catch { throw new Error(`invalid MCP configuration for server "${name}"`); }
      });
      for (const { name, config } of parsed) {
        try {
          const fiber = ctx.plugin(McpClient, config);
          disposers.push(() => fiber.dispose());
          await fiber;
        } catch {
          throw new Error(`MCP server "${name}" failed to connect or register its tools`);
        }
      }
    }
    if (params.systemPrompt !== undefined && params.systemPrompt !== '') {
      const prompt = ctx.get('systemPrompt');
      if (prompt === undefined) throw new Error('Paseo systemPrompt requires DSH systemPrompt service');
      disposers.push(prompt.section({
        name: 'paseo:system-prompt',
        order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        interpolate: false,
        text: params.systemPrompt,
      }));
    }
    if (configs.length > 0) {
      const tools = ctx.get('tools');
      const prefixes = configs.map(({ config }) => `mcp__${config.serverName}__`);
      const validate = agent => {
        for (const definition of tools.definitions(agent)) {
          if (prefixes.some(prefix => definition.name.startsWith(prefix)) && tools.get(definition.name) !== definition) {
            throw new Error(`launch MCP namespace is also declared by the selected preset: ${definition.name}`);
          }
        }
      };
      disposers.push(ctx.on('agent/created', ({ agent }) => validate(agent)));
      // Check again after preset switches; restrictions may hide a tool, but a
      // scoped server must never silently replace the launch server's identity.
      disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.agent !== undefined) validate(exec.agent);
        return next();
      }, { prepend: true }));
      if (grants.size > 0) disposers.push(ctx.on('tools/pre-execute', preapprovalGate(grants,
        exec => tools.get(exec.name) !== undefined && tools.get(exec.name) === tools.get(exec.name, exec.agent)), { prepend: true }));
    }
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
