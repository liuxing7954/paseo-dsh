# Steering admission and subagent messages

When a subagent message arrives during a foreground turn, Paseo accepts the
provider response only when it is `{ type: "steer", turnId: expectedTurnId }`.
Returning a new-turn result after enqueueing the message makes the host replace
the foreground turn and send the same message again. Different turn IDs prevent
the two message cards from merging.

The provider and its stdio bridge use the following admission rules:

- Refuse idle root and child steers before enqueueing. A refusal has no message
  or timeline side effect and lets the host decide whether it can fall back.
- A successful root steer returns `disposition: "steered"`; the provider retains
  the turn identity captured for that admission. It does not flush the current
  assistant stream or start another turn.
- Emit the steered message after admission. Equal bodies under distinct message
  IDs remain separate messages; no text-based duplicate filter is used.
- If the accepted prompt has `clearPendingPermissions: true`, deny outstanding
  cards owned by that native session and publish their resolution. Root and
  sibling cards are isolated by native owner, including child cards promoted to
  the root UI. Unaccepted steers and prompts without the flag preserve cards.
- Generate distinct root turn IDs even for successive starts in one clock
  millisecond or after a clock rollback.

The bounded wait for a durable message sequence does not decide admission.
A steer may only receive its rewind sequence at a later step boundary; the
existing pending-message path attaches that sequence when it arrives.

All changes use DSH's existing agent and subagent APIs. DSH itself and its
delegated-question policy are unchanged. Direct native tools and PTC tools share
this provider/bridge contract.

`paseo-plugin/test/subsessions.test.cjs` covers root/child admission, refused
steers without duplicate rows, equal-body message identity, permission-owner
isolation, and turn-ID uniqueness. `test/child-bridge.test.cjs` exercises the real
bridge methods against controlled idle/running agents. Before installation,
also check assistant-stream continuity and host projection, regenerate bridge
assets, run the full plugin suite and `harness/plugin-check.cjs`, and validate
the candidate in Paseo.
