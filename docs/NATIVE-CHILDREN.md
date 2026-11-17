# Native child-session lifecycle

One bridge process owns a Paseo root session and its DSH-native descendants.
Ordinary conversation forks are not children: an owned native child must have
`origin: "subagent"` and an ancestry chain back to that root. DSH uses this same
origin for subagent, subagent_fork, and workflow members.

`Subsessions` records the actual `tools/execute` causal scope, including call ID,
root call ID, and native parent. Direct calls and nested PTC dispatches therefore
retain their own spawning call even when they run concurrently. Explicit
workflow member events restore correlation across the workflow IPC boundary.
The association is forwarded alongside child events, status, and live assistant
frames. The older tool-result/fallback path remains for runtimes that lack this
metadata.

The provider registers child ownership when it publishes `session.opened`.
Child prompt, interrupt, permission response, and close requests route through
the owning root to DSH's native subagent manager. Continuation preserves the
child's recorded composition. Closing a child drains that child's descendants;
interrupting it cancels its turn. Neither operation kills the root process.

Only implemented child capabilities are advertised. Continuable children can
accept messages, images, and steering when negotiated; one-shot children do not
advertise these inputs. Configuration and rewind remain root operations and fail
explicitly for child targets.

Questions and approvals carry their native session and transport request IDs.
Promoted child cards use owner-qualified IDs so equal tool-call IDs in sibling
sessions cannot collide. Cancellation settles the matching card. A denial sent
with `interrupt: true` also cancels the turn that asked: the root turn for a root
card, only that child for a promoted child card. DSH's own
delegated human-interaction policy is unchanged. Steering admission, pending
permission clearing, and unique turn IDs are documented in [STEERING.md](./STEERING.md).

The timeline uses Paseo's native assistant, reasoning, tool, and subagent items.
PTC delegation cards preserve the child link when their result arrives. This
change adds no custom reasoning or Run code renderer.

## Validation

From `paseo-plugin`, run `npm run typecheck` and `npm test`. Deterministic stdio
tests cover concurrent association, nested descendants, streaming before a
snapshot, child-only controls, permission ownership and cancellation, stable
live/snapshot identities and replayed results, refused/accepted steering races,
and turn-ID protection. A native
bridge contract test uses a locally installed DSH and explicitly skips if it is
unavailable. The suite needs no model credentials and passes on Windows, macOS,
and Linux.

The existing `harness/plugin-check.cjs` remains a separate real-runtime check;
its header documents CJS compilation. Local integration checks should also run
spawn/fork/workflow in both direct and PTC modes, continue and interrupt a child,
then close only that child and verify another root turn. These checks need a
configured model and spend tokens. Use disposable profiles rather than editing
the user's profile files.

Launch MCP servers, the system prompt and the tool policy come from the launch
context already on main (#15), and native children inherit them through
`composeFrom()`. This change routes the children without touching that path.
