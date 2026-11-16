# Launch context and native model selection

Paseo passes session-scoped `mcpServers`, `systemPrompt`, and `toolPolicy` in
`ProviderSessionConfig`. The provider forwards these fields through `DshSession`
and the stdio `initialize` request. They are never written into a DSH profile or
credential file. Each root session retains its own bridge process and launch
context.

The bridge validates all launch server configurations before connecting. It
mounts and awaits DSH MCP clients at the bridge root, following `dsh-acp`, and
disposes those clients on shutdown or failed initialization. Supported transports
are stdio and Streamable HTTP, including their environment and headers. Legacy
SSE and unsupported configurations fail the open before it reports ready.

Root mounting makes the tools visible across preset composition and inherited
or independent child presets. DSH's explicit tool filters still apply. A preset
cannot silently shadow a launch MCP namespace. Exact preapprovals use the
original server/tool identity and DSH's public-name mapping; they can resolve an
ask, but cannot override a denial, cancellation, or a tool restriction.

The launch system prompt is a disposable DSH system-prompt section with
`interpolate: false`. Literal text such as `{{unregistered}}` is not interpreted
as a DSH prompt variable.

## Why the model-selection changes are included

Validating preset composition during open creates the native agent before the
first prompt. The initial thinking choice must therefore reach `initialize`,
rather than being applied to a detached selection reference afterwards. That
combination previously left an initial Medium UI choice at the profile's Low
value. Eager composition is part of this launch change; that initial-selection
regression was not introduced by upstream main.

Subsequent model/thinking changes use the native `agent.model.current()` and
`agent.model.select()` contract. Model and effort are validated together before
commit, serialized across asynchronous requests, and read back from the native
selection. A rejected change leaves the previous selection intact. Resume and
rewind preserve the recorded selection; switching to another model does not
inherit an incompatible profile effort.

This also fixes main on its own. Main writes later changes to the bridge's own
selection reference, which DSH 0.2.2-rc.1's `installModelSelection()` does not
read, so a model or thinking change made after a session opens is reported to
Paseo but never reaches the agent.

As on main, a thinking option the model does not offer is dropped with a log:
a saved choice after a profile edit, a host default shared across models, or a
live change. It never reaches `initialize`, a stale durable selection is
replaced too, and the read-back reports the effort actually applied.

## Validation

From `paseo-plugin`, run `npm run typecheck` and `npm test`. The suite covers
transports, literal prompts, exact grants, concurrent independent opens,
failed-open cleanup, initial/live/restored model selection, and thinking
options the model does not offer. Native-model contract tests use a
locally installed DSH and explicitly skip when it is absent; the remaining tests
use deterministic stdio fixtures. The suite needs no model credentials and passes
on Windows, macOS, and Linux.

The existing `harness/plugin-check.cjs` exercises the real configured runtime;
its header documents CJS compilation. For local runtime validation, use disposable
profile copies and inspect actual MCP tool visibility, preset collisions,
restrictions, disposal, and outgoing model requests. Do not substitute a mock
forwarding assertion for those runtime checks.

This change does not add child-session routing or change timeline presentation.
