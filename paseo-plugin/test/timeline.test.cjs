require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TimelineBuilder } = require("../server/timeline.ts");
const { RUN_CODE_KIND, REASONING_KIND, runCodeSchema, reasoningSchema, reasoningPreview } = require("../shared/work-display.ts");
const content = text => [{ type: "text", text }];
const call = (id, name, input) => ({ type: "tool/call", data: { callId: id, name, arguments: JSON.stringify(input) } });
const result = (id, text, isError = false) => ({ type: "tool/result", data: {
  message: { toolCallId: id, content: content(text), isError },
} });

test("PTC work is a provider-owned summary rather than an Overview-grouped tool", () => {
  const timeline = new TimelineBuilder();
  const code = 'return await tools.read({ file_path: "src/main.c" });';
  const [started] = timeline.consume(call("program", "run_code", { description: "Inspect reset handling", code }));
  assert.equal(started.type, "plugin");
  assert.equal(started.pluginId, "dsh-paseo");
  assert.equal(started.kind, RUN_CODE_KIND);
  assert.deepEqual(runCodeSchema.parse(started.data), { description: "Inspect reset handling", code, status: "running" });
  const [finished] = timeline.consume(result("program", "handler found"));
  assert.equal(finished.id, started.id);
  assert.equal(finished.data.status, "completed");
  assert.equal(finished.data.output, "handler found");
  const [duplicate] = timeline.consume(call("program", "run_code", { description: "Inspect reset handling", code }));
  assert.deepEqual(duplicate, finished);
});

test("internal file and shell operations do not become extra transcript rows", () => {
  const timeline = new TimelineBuilder();
  const data = { rootCallId: "program", parentCallId: "program", subCallId: "program:ptc:1",
    name: "read", arguments: { file_path: "src/main.c" } };
  assert.deepEqual(timeline.consume({ type: "tool/ptc-dispatch-start", data }), []);
  assert.deepEqual(timeline.consume({ type: "tool/ptc-dispatch", data: { ...data, content: content("source"), isError: false } }), []);
});

test("PTC task updates retain the native todo widget without an extra tool row", () => {
  const timeline = new TimelineBuilder();
  const items = timeline.consume({ type: "tool/ptc-dispatch", data: {
    subCallId: "program:ptc:3", name: "todo_write",
    arguments: { todos: [{ content: "Verify reset", status: "in_progress" }] },
    content: content("Tasks updated"), isError: false,
  } });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "todo");
  assert.equal(items[0].items[0].status, "in_progress");
});

test("provider reasoning streams and replays under one id, without generated prose", () => {
  const timeline = new TimelineBuilder();
  const text = "**Checking reset**\nCompare the two paths.";
  const [live] = timeline.reasoning(1, 2, text, "running");
  const [settled] = timeline.consume({ type: "assistant/message", data: {
    turn: 1, step: 2, message: { content: [{ type: "reasoning", text }] },
  } });
  assert.equal(live.id, settled.id);
  assert.equal(settled.kind, REASONING_KIND);
  assert.equal(settled.pluginId, "dsh-paseo");
  assert.deepEqual(reasoningSchema.parse(settled.data), { text, status: "completed" });
  assert.deepEqual(timeline.reasoning(1, 3, "", "running"), []);
});

test("reasoning preview follows DSH paragraph boundaries", () => {
  assert.equal(reasoningPreview("**Checking reset**", "running"), "");
  assert.equal(reasoningPreview("**Checking reset**\n\nUnfinished", "running"), "Checking reset");
  assert.equal(reasoningPreview("**Checking reset**\nDetails\n\n**Checking IRQ**\nMore", "running"), "Checking IRQ");
  assert.equal(reasoningPreview("**Checking reset**\nDetails\n\n**Checking IRQ**", "completed"), "Checking reset");
});

test("missing descriptions have a neutral fallback and failures retain their output", () => {
  const timeline = new TimelineBuilder();
  const [started] = timeline.consume(call("program", "run_code", { code: "await work();" }));
  assert.equal(started.data.description, "Run code");
  const [failed] = timeline.consume(result("program", "Error: execution deadline reached", true));
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.output, "Error: execution deadline reached");
});

test("turn cancellation and runtime failure settle pending DSH display rows", () => {
  for (const [kind, status] of [["aborted", "canceled"], ["error", "failed"]]) {
    const timeline = new TimelineBuilder();
    timeline.consume(call("program", "run_code", { description: "Run tests", code: "await tests();" }));
    timeline.reasoning(1, 1, "Checking\nTests", "running");
    const items = timeline.consume({ type: "turn/end", data: { turn: 1, reason: { kind } } });
    const display = items.filter(item => item.type === "plugin");
    assert.equal(display.length, 2);
    assert.ok(display.every(item => item.data.status === status));
    assert.deepEqual(timeline.finishPending(status), []);
  }
});

test("native read and ordinary assistant messages keep their original types", () => {
  const timeline = new TimelineBuilder();
  const [started] = timeline.consume(call("native", "read", { file_path: "AGENTS.md" }));
  assert.equal(started.detail.type, "read");
  const [finished] = timeline.consume(result("native", "instructions"));
  assert.equal(finished.id, started.id);
  assert.equal(finished.detail.content, "instructions");
  const [message] = timeline.consume({ type: "assistant/message", data: {
    turn: 1, step: 2, message: { content: content("Tests complete.") },
  } });
  assert.equal(message.type, "assistant_message");
  assert.equal(message.text, "Tests complete.");
});
