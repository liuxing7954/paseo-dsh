const assert = require('node:assert/strict');
const { test } = require('node:test');

const launch = import('../../dsh-bridge/lib/launch.js');

test('launch transports preserve stdio environment and HTTP headers; legacy SSE fails before mounting', async () => {
  const { launchMcpConfigs, serverNamespace } = await launch;
  const servers = {
    local: { type: 'stdio', command: 'node', args: ['a b'], env: { TOKEN: 'fixture' } },
    'remote tools': { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'fixture' } },
  };
  const configs = launchMcpConfigs(servers, '/workspace');
  assert.deepEqual(configs[0].config, { serverName: 'local', transport: 'stdio', command: 'node', args: ['a b'],
    env: { TOKEN: 'fixture' }, cwd: '/workspace', failOnStartupError: true });
  assert.equal(configs[1].config.serverName, serverNamespace('remote tools'));
  assert.equal(configs[1].config.transport, 'streamable-http');
  assert.deepEqual(configs[1].config.headers, servers['remote tools'].headers);
  assert.throws(() => launchMcpConfigs({ legacy: { type: 'sse' } }), /unsupported transport "sse"/);
  assert.throws(() => launchMcpConfigs({ bad: { type: 'http', url: 'file:///private' } }), /HTTP\(S\)/);
  assert.throws(() => serverNamespace('bad\nname'), /invalid MCP server name/);
  assert.notEqual(serverNamespace('remote tools'), serverNamespace('remote.tools'));
  assert.throws(() => launchMcpConfigs({ 'remote tools': servers['remote tools'],
    [serverNamespace('remote tools')]: servers['remote tools'] }), /namespace collision/);
});

test('MCP preapprovals match exact DSH identities and never override denial or cancellation', async () => {
  const { publicToolName, preapprovalGate } = await launch;
  const name = publicToolName('bridge', 'long/tool.' + 'x'.repeat(80));
  assert.equal(name.length, 64);
  assert.match(name, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(name, publicToolName('bridge', 'long_tool.' + 'x'.repeat(80)));
  assert.equal(publicToolName('paseo', 'list_profiles'), 'mcp__paseo__list_profiles');
  const gate = preapprovalGate(new Set([name]));
  assert.deepEqual(await gate({ name }, async () => ({ kind: 'ask' })), { kind: 'allow' });
  for (const kind of ['deny', 'cancel', 'allow']) assert.deepEqual(await gate({ name }, async () => ({ kind })), { kind });
  assert.deepEqual(await gate({ name: name + 'other' }, async () => ({ kind: 'ask' })), { kind: 'ask' });
  assert.deepEqual(await preapprovalGate(new Set([name]), () => false)({ name }, async () => ({ kind: 'ask' })), { kind: 'ask' });
});

test('launch system instructions are literal and disposable; grants require a launch server', async () => {
  const { mountLaunchContext } = await launch;
  let section, removed = false;
  const ctx = { get: () => ({ getSectionOrder: () => 90, section: value => { section = value; return () => { removed = true; }; } }) };
  const dispose = await mountLaunchContext(ctx, { cwd: '/work', systemPrompt: 'Keep literal {{unregistered}}.' });
  assert.equal(section.interpolate, false);
  assert.equal(section.text, 'Keep literal {{unregistered}}.');
  await dispose(); assert(removed);
  await assert.rejects(mountLaunchContext(ctx, { toolPolicy: { preapproved: [{ kind: 'mcp', server: 'missing', tool: 'x' }] } }), /same launch configuration/);
});
