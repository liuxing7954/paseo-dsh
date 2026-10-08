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
      "prompt.steer",
      "session.configure",
      "permission",
    ],
  });
  conn.onEvent((event) => events.push(event));

  check(
    "provider declares prompt.image",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("prompt.image"),
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

  await conn.close();

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
