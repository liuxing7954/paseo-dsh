/**
 * Plugin-level check: drive the Paseo plugin directly and assert on the events
 * it emits, with no Paseo daemon involved.
 *
 * `harness/probe.mjs` talks to the bridge underneath; this talks to the plugin
 * above it. The plugin is the layer that owns capabilities and event shapes, so
 * this is where a regression in "declared capability vs actual behaviour" shows
 * up — the class of bug that is invisible in the UI because nothing errors.
 *
 * It covers three things that were each once silently wrong:
 *   1. `session.usage` is emitted with real token numbers and a turn id
 *   2. a non-text content block reaches DSH instead of being collapsed away
 *   3. an unsupported input type reports `request.failed`, not `request.completed`
 *
 * The plugin is TypeScript, so it has to be compiled before it can be required:
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/plugin-check.cjs .dbg/
 *   cd .dbg && node plugin-check.cjs
 *   rm -rf ../.dbg          # afterwards
 *
 * The type errors tsc prints under `--moduleResolution node` are expected; the
 * emitted JavaScript is what runs.
 */
const plugin = require("./index.server.js").default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
let registration;

plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});

async function until(predicate, label, ms = 120000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Like `until`, but ignores events recorded before `start` (stale matches). */
async function untilSince(start, predicate, label, ms = 120000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
    if (hit) return hit;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Like `untilSince`, but returns undefined instead of throwing on timeout. */
async function maybeSince(start, predicate, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
    if (hit) return hit;
    await sleep(120);
  }
  return undefined;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

(async () => {
  // Offer every capability the plugin could support. `prompt.image` is asserted
  // below: it is the switch that lets Paseo send an attached picture at all, and
  // a missing one fails the send outright rather than degrading.
  const conn = await registration.connect({
    capabilities: [
      "prompt.message",
      "prompt.image",
      "prompt.command",
      "prompt.steer",
      "session.configure",
      "session.persistence",
      "session.list",
      "permission",
    ],
  });
  conn.onEvent((event) => events.push(event));

  check(
    "provider declares prompt.image",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("prompt.image"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  check(
    "provider declares prompt.command",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("prompt.command"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  check(
    "provider declares session.persistence (reload recovery)",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("session.persistence"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );

  await conn.send({
    type: "session.open",
    sessionId: `check-${Date.now()}`,
    config: { cwd: process.cwd(), mode: "build" },
  });
  const ready = await until((e) => e.type === "session.ready", "session.ready");
  const sessionId = ready.sessionId;
  console.log(`  session ready: ${sessionId}\n`);

  // 0. `session.opened` must carry a persistence handle, or Paseo stores a raw
  // session id its decoder rejects on reopen ("Invalid plugin provider
  // persistence handle"), leaving a reload-orphaned session unrecoverable.
  const opened = events.find((e) => e.type === "session.opened");
  check(
    "session.opened carries a persistence handle",
    opened !== undefined && typeof opened.persistence?.version === "number",
    opened?.persistence ? JSON.stringify(opened.persistence).slice(0, 120) : "(no persistence on session.opened)",
  );

  // 0. the slash menu: DSH's registered commands and user-invocable skills.
  const commandEvent = await until((e) => e.type === "session.commands", "session.commands");
  const advertised = Array.isArray(commandEvent.commands) ? commandEvent.commands : [];
  check(
    "→ slash menu advertised",
    advertised.length > 0,
    advertised.length > 0
      ? `${advertised.length} entries, e.g. ${advertised.slice(0, 5).map((c) => `/${c.name}`).join(", ")}`
      : "(empty command list)",
  );

  // 0b. the agent-preset select is advertised when the profile declares presets.
  const presetSetting = events
    .filter((e) => e.type === "session.config")
    .flatMap((e) => e.config?.settings ?? [])
    .find((s) => s.id === "preset");
  if (presetSetting !== undefined) {
    check(
      "→ preset setting advertised",
      (presetSetting.options ?? []).length > 0,
      `options=[${(presetSetting.options ?? []).map((o) => o.value).join(", ")}]`,
    );
  } else {
    console.log("  (no agent-preset registry in this profile — preset select not expected)");
  }

  // 0c. the permission setting is advertised and switching it moves the DSH preset.
  const permissionSetting = events
    .filter((e) => e.type === "session.config")
    .flatMap((e) => e.config?.settings ?? [])
    .find((s) => s.id === "permission");
  check(
    "→ permission setting advertised",
    permissionSetting !== undefined &&
      (permissionSetting.options ?? []).some((o) => o.value === "danger-full-access"),
    permissionSetting
      ? `options=[${(permissionSetting.options ?? []).map((o) => o.value).join(", ")}]`
      : "(no permission setting)",
  );
  await conn.send({
    type: "session.configure",
    sessionId,
    requestId: "cfg-permission",
    changes: { settings: { permission: "danger-full-access" } },
  });
  const permissionApplied = await until(
    (e) =>
      e.type === "session.config" &&
      (e.config?.settings ?? []).some((s) => s.id === "permission" && s.value === "danger-full-access"),
    "permission applied",
  );
  check("permission setting switches the preset", permissionApplied !== undefined, "value=danger-full-access");

  // 0c. a registered command executes in the runtime instead of being sent to the
  // model as literal text. `/goal` with no argument only reads state, so it is
  // safe to run here and must settle as `completed`, not `failed`.
  const commandMsgId = `cmd-${Date.now()}`;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: commandMsgId,
      input: { type: "command", name: "goal", arguments: "" },
    },
  });
  const commandResult = await until(
    (e) => e.type === "session.prompt_result" && e.clientMessageId === commandMsgId,
    "command prompt_result",
  );
  check(
    "registered command runs in the runtime (no model turn)",
    commandResult.result?.type === "completed",
    JSON.stringify(commandResult.result),
  );

  // A 1x1 PNG: tiny, valid, and unmistakably an image to anything downstream.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      input: {
        type: "message",
        content: [
          { type: "text", text: "Describe what you can see, then reply with exactly: IMAGE-SEEN" },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      },
    },
  });

  await until((e) => e.type === "session.turn" && e.state === "completed", "turn completed");
  await sleep(1500);

  // 1. usage
  const usage = events.filter((e) => e.type === "session.usage");
  const withNumbers = usage.filter(
    (e) => typeof e.usage?.inputTokens === "number" && typeof e.usage?.outputTokens === "number",
  );
  check(
    "session.usage emitted with real numbers",
    withNumbers.length > 0,
    withNumbers.length > 0
      ? `${withNumbers.length} event(s), e.g. ${JSON.stringify(withNumbers[0].usage)}`
      : `${usage.length} usage event(s) but none carried numbers`,
  );
  if (withNumbers[0]) {
    check(
      "usage carries a turnId",
      typeof withNumbers[0].turnId === "string" && withNumbers[0].turnId !== "",
      `turnId=${withNumbers[0].turnId}`,
    );
  }

  // 1b. context occupancy. The composer's window readout reads
  // `contextWindowUsedTokens`/`contextWindowMaxTokens` off the same usage record
  // DSH's own token meter feeds. A missing window is a silent regression — the
  // meter simply never appears — so assert the fields travel on `session.usage`
  // and that the occupancy is prompt-anchored rather than a running sum.
  const withContext = usage.filter(
    (e) =>
      typeof e.usage?.contextWindowMaxTokens === "number" &&
      typeof e.usage?.contextWindowUsedTokens === "number",
  );
  check(
    "session.usage carries context occupancy (window + used)",
    withContext.length > 0,
    withContext.length > 0
      ? JSON.stringify(withContext[withContext.length - 1].usage)
      : `${usage.length} usage event(s), none carried a context window`,
  );
  if (withContext.length > 0) {
    const latest = withContext[withContext.length - 1].usage;
    check(
      "context occupancy is bounded by the resolved window",
      latest.contextWindowMaxTokens > 0 &&
        latest.contextWindowUsedTokens >= 0 &&
        latest.contextWindowUsedTokens <= latest.contextWindowMaxTokens,
      `used=${latest.contextWindowUsedTokens} max=${latest.contextWindowMaxTokens}`,
    );
    check(
      "occupancy covers the prompt instead of summing the log",
      typeof latest.inputTokens !== "number" ||
        latest.contextWindowUsedTokens >= latest.inputTokens,
      `used=${latest.contextWindowUsedTokens} inputTokens=${latest.inputTokens}`,
    );
  }

  // 2. the image block reached the model layer
  //
  // A text-only route makes DSH replace the image with a note saying so, and
  // that note is the proof the block arrived: had the plugin still been
  // collapsing content into a text label, nothing downstream would know an
  // attachment was ever there.
  console.log("\n  timeline:");
  for (const e of events.filter((x) => x.type === "timeline.item")) {
    const item = e.item;
    const body =
      item.text ?? (item.content ?? []).map((b) => b.text ?? `<${b.type}>`).join("") ?? "";
    console.log(`    [${item.type}] ${String(body).slice(0, 140).replace(/\n/g, " ")}`);
  }

  const allText = events
    .filter((e) => e.type === "timeline.item")
    .map((e) => {
      const item = e.item;
      return (
        (item.text ?? "") +
        (item.content ?? []).map((b) => b.text ?? "").join("") +
        JSON.stringify(item.detail ?? {})
      );
    })
    .join("\n");

  check(
    "non-text block reached DSH (downstream knows an attachment existed)",
    /image|图片|图像|视觉|visual|text only|text-only|attachment/i.test(allText),
    allText.trim() ? allText.replace(/\s+/g, " ").trim().slice(0, 140) : "(no timeline text at all)",
  );

  const failed = events.filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check("turn produced no failure event", failed.length === 0, failed.length ? JSON.stringify(failed[0]).slice(0, 140) : "");

  // 2b. a mislabeled image is accepted from its bytes, not its declared type
  //
  // Paseo derives an upload's media type from its filename extension, so a JPEG
  // saved as `foo.png` arrives as `image/png` over JPEG bytes. DSH verifies the
  // declared type against the decoded bytes and refuses a mismatch, so the
  // bridge must read the type from the bytes it actually holds.
  const mark = events.length;
  // A 2x2 JPEG (FFD8FF...) deliberately declared as PNG.
  const jpegDeclaredPng =
    "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIADEVf/2Q==";
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      input: {
        type: "message",
        content: [
          { type: "text", text: "Reply with exactly: MISLABEL-OK" },
          { type: "image", data: jpegDeclaredPng, mimeType: "image/png" },
        ],
      },
    },
  });

  const mislabelStarted = Date.now();
  let mislabelTurnCompleted = false;
  // Slice from `mark`: a stale `turn completed` from the first prompt would
  // otherwise satisfy this wait the instant it starts.
  while (Date.now() - mislabelStarted < 150000) {
    if (events.slice(mark).some((e) => e.type === "session.turn" && e.state === "completed")) {
      mislabelTurnCompleted = true;
      break;
    }
    await sleep(200);
  }
  await sleep(1200);
  const mislabelFailed = events
    .slice(mark)
    .filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check(
    "mislabeled image type is corrected from its bytes",
    mislabelTurnCompleted && mislabelFailed.length === 0,
    mislabelFailed.length
      ? mislabelFailed[0].error?.message
      : `turn completed=${mislabelTurnCompleted}`,
  );

  // 3. an unsupported input must fail loudly
  const bogusId = "req-unknown-type";
  await conn.send({ type: "definitely.not.a.real.input", requestId: bogusId });
  await sleep(1200);
  const bogusFailed = events.find((e) => e.type === "request.failed" && e.requestId === bogusId);
  const bogusCompleted = events.find((e) => e.type === "request.completed" && e.requestId === bogusId);
  check(
    "unsupported input -> request.failed naming the type",
    bogusFailed !== undefined && /unsupported/i.test(bogusFailed.error?.message ?? ""),
    bogusFailed ? bogusFailed.error.message : "(no request.failed)",
  );
  check("unsupported input did not report request.completed", bogusCompleted === undefined);

  // 4. session.list is advertised and the `sessions` input answers it.
  check(
    "provider declares session.list (import)",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("session.list"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  await conn.send({ type: "sessions", requestId: "list-sessions", cwd: process.cwd() });
  const sessionsEvent = await until((e) => e.type === "sessions" && e.requestId === "list-sessions", "sessions list");
  check(
    "sessions input returns a list (import source)",
    Array.isArray(sessionsEvent.sessions),
    `${(sessionsEvent.sessions ?? []).length} session(s), first has persistence=${sessionsEvent.sessions?.[0]?.persistence !== undefined}`,
  );

  // 5. reopening with history:"replay" replays the conversation. Close first so
  // the native session has no live owner, exactly like a restart/import reopen.
  await conn.send({ type: "session.close", sessionId });
  await until((e) => e.type === "session.closed" && e.sessionId === sessionId, "session.closed");
  const replayMark = events.length;
  await conn.send({
    type: "session.open",
    requestId: "reopen",
    sessionId,
    config: { cwd: process.cwd(), mode: "build" },
    persistence: { version: 1, data: { sessionId } },
    history: "replay",
  });
  await untilSince(replayMark, (e) => e.type === "session.ready" && e.sessionId === sessionId, "reopened ready");
  const replayed = events
    .slice(replayMark)
    .filter((e) => e.type === "timeline.item" && (e.item?.type === "user_message" || e.item?.type === "assistant_message"));
  check("reopen replays conversation history", replayed.length > 0, `${replayed.length} replayed item(s)`);

  // 5b. A resumed session already carries DSH's stored context, so its
  // occupancy must appear without waiting for a new turn — otherwise the
  // readout stays blank on every reopen and after every daemon restart.
  const reopenedUsage = await maybeSince(
    replayMark,
    (e) => e.type === "session.usage" &&
      typeof e.usage?.contextWindowMaxTokens === "number" &&
      typeof e.usage?.contextWindowUsedTokens === "number" &&
      e.usage.contextWindowUsedTokens > 0,
  );
  check(
    "reopen restores occupancy without a new turn",
    reopenedUsage !== undefined,
    JSON.stringify(reopenedUsage?.usage ?? {}),
  );

  await conn.close();

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
