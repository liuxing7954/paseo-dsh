const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, delimiter, resolve } = require("node:path");
const { test } = require("node:test");
const { DshProcess } = require("../server/dsh-process.ts");

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "paseo dsh 한글 ")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "cli.cjs" } }));
  writeFileSync(join(pkg, "cli.cjs"), `
    const readline = require("node:readline");
    if (process.argv.includes("--version")) { console.log("0.2.2-test"); process.exit(0); }
    process.stderr.write("fixture stderr\\n");
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const frame = JSON.parse(line);
      const result = frame.method === "paseo/catalog"
        ? { providers: [], models: [], cwd: process.cwd(), argv: process.argv.slice(2), marker: process.env.TEST_MARKER, pid: process.pid }
        : {};
      send({ jsonrpc: "2.0", id: frame.id, result });
      if (frame.method === "session/cancel") send({ jsonrpc: "2.0", method: "session.status", params: { status: "idle" } });
      if (frame.method === "shutdown") process.exit(7);
    });
  `);
  writeFileSync(join(dir, "dsh.cmd"), `@"${process.execPath}" "%~dp0node_modules\\@deepseek-ai\\dsh\\cli.cjs" %*\r\n`);
  writeFileSync(join(dir, "dsh"), '#!/usr/bin/env node\nrequire("./node_modules/@deepseek-ai/dsh/cli.cjs");\n');
  chmodSync(join(dir, "dsh"), 0o755);
  const env = { ...process.env, TEST_MARKER: "session environment", DSH_PASEO_PROFILE: 'profile 空白 & %PATH% ! ^ (test)' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = dir + delimiter + (process.env.PATH ?? process.env.Path ?? "");
  delete env.DSH_BINARY;
  const cwd = join(dir, "working directory");
  mkdirSync(cwd);
  return { dir, pkg, env, cwd };
}

function session(t, f) {
  let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  const logs = [], errors = [], statuses = [];
  const child = new DshProcess({
    cwd: f.cwd, env: f.env, sessionId: "fixture", route: { provider: "test", model: "test" },
    onEvent() {}, onStatus: value => statuses.push(value), onQuestion: async () => ({ answers: [] }),
    onLog: value => logs.push(value), onProtocolError: value => errors.push(value),
    onExit: (code, signal) => exited({ code, signal }),
  });
  t.after(() => child.kill());
  return { child, exit, logs, errors, statuses };
}

test("npm-installed DSH preserves cwd, argv, env and streamed JSON-RPC; cancel keeps it alive", { timeout: 10000 }, async t => {
  const f = fixture(t);
  const s = session(t, f);
  await s.child.start();
  const first = await s.child.catalog();
  assert.equal(first.cwd, f.cwd);
  assert.deepEqual(first.argv, ["--profile", f.env.DSH_PASEO_PROFILE]);
  assert.equal(first.marker, f.env.TEST_MARKER);
  await s.child.cancel();
  const next = await s.child.catalog();
  assert.equal(next.pid, first.pid);
  assert(s.statuses.some(value => value.status === "idle"));
  assert(s.logs.some(value => value.includes("fixture stderr")));
  assert.deepEqual(s.errors, []);
  await s.child.shutdown();
  const ended = await s.exit;
  assert(ended.code === 7 || ended.signal === "SIGTERM");
});

test("DSH_BINARY npm shim override uses the session environment", { timeout: 10000 }, async t => {
  const f = fixture(t);
  f.env.DSH_BINARY = join(f.dir, process.platform === "win32" ? "dsh.cmd" : "dsh");
  f.env.PATH = process.env.PATH ?? process.env.Path;
  const s = session(t, f);
  await s.child.start();
  assert.equal((await s.child.catalog()).cwd, f.cwd);
  const pid = (await s.child.catalog()).pid;
  s.child.kill();
  await s.exit;
  const restarted = session(t, f);
  await restarted.child.start();
  assert.notEqual((await restarted.child.catalog()).pid, pid);
  restarted.child.kill();
  await restarted.exit;
});

test("doctor detects npm DSH and treats an unavailable Windows Paseo CLI as optional", t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, "profiles", "paseo", "node_modules", "dsh-paseo-bridge", "lib"), { recursive: true });
  writeFileSync(join(f.dir, "profiles", "paseo", "node_modules", "dsh-paseo-bridge", "lib", "server.js"), "");
  writeFileSync(join(f.dir, "profiles", "paseo", "cordis.patch.yml"), "[]\n");
  const result = spawnSync(process.execPath, [resolve(__dirname, "../bin/paseo-dsh.mjs"), "doctor"], {
    env: { ...f.env, DSH_HOME: f.dir, DSH_PASEO_PROFILE: "paseo", PASEO_CLI: "missing-paseo" }, encoding: "utf8", timeout: 10000,
  });
  assert.match(result.stdout, /dsh 0\.2\.2-test/);
  assert.doesNotMatch(result.stdout, /fail[^\n]*dsh on PATH/);
  if (process.platform === "win32") {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /warn[^\n]*paseo CLI/i);
  }
});


const { resolveDshCommand } = require("../server/dsh-command.mjs");

test("direct Node launch preserves literal arguments, stdin, stderr and nonzero exit code", { timeout: 10000 }, async t => {
  const f = fixture(t);
  const launch = resolveDshCommand("dsh", f.env, f.cwd);
  const args = ["", "space and 한글", 'quote"inside', "trailing\\", "& | < > ^ ( ) ! %PATH%", "line\nbreak"];
  const child = require("node:child_process").spawn(launch.command, [...launch.args, ...args], { cwd: f.cwd, env: f.env, stdio: "pipe" });
  t.after(() => child.kill());
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "paseo/catalog" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown" }) + "\n");
  assert.deepEqual(await closed, { code: 7, signal: null });
  const frame = JSON.parse(stdout.split("\n")[0]);
  assert.deepEqual(frame.result.argv, args);
  assert.equal(frame.result.cwd, f.cwd);
  assert.match(stderr, /fixture stderr/);
});

test("missing executable still rejects startup and reports the process error", { timeout: 10000 }, async t => {
  const f = fixture(t);
  f.env.DSH_BINARY = "missing-dsh-regression-fixture";
  const s = session(t, f);
  await assert.rejects(s.child.start(), { code: "ENOENT" });
  assert(s.errors.some(value => value.includes("ENOENT")));
});

test("macOS/Linux and explicit native executables retain their original launch command", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const platform of ["linux", "darwin"]) {
      Object.defineProperty(process, "platform", { value: platform });
      for (const command of ["dsh", "/opt/tools/dsh", "/home/test/.local/bin/dsh"]) {
        assert.deepEqual(resolveDshCommand(command), { command, args: [] });
      }
    }
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
  assert.deepEqual(resolveDshCommand(process.execPath), { command: process.execPath, args: [] });
});

test("doctor still fails for a missing DSH executable", t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [resolve(__dirname, "../bin/paseo-dsh.mjs"), "doctor"], {
    env: { ...f.env, DSH_BINARY: "missing-dsh-regression-fixture", DSH_HOME: f.dir }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fail[^\n]*dsh on PATH/);
});

