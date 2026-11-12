/**
 * Minimal check for the profile package.json lock used by the DSH Plugins page.
 *
 * The plugin is TypeScript, so compile it first:
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/plugins-lock-check.cjs .dbg/
 *   cd .dbg && node plugins-lock-check.cjs
 *   rm -rf ../.dbg
 *
 * The type errors tsc prints under `--moduleResolution node` are expected;
 * the emitted JavaScript is what this check runs.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DshPlugins } = require("./server/dsh-plugins.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugins-lock-"));
const profileDir = path.join(root, "profile");
const manifestPath = path.join(profileDir, "package.json");
const lockPath = path.join(profileDir, "package.json.lock");
const bundleName = "@example/dsh-demo";

function writeManifest(value) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function bundles() {
  return readManifest().dsh?.profile?.bundles ?? [];
}

function installBundle() {
  const dir = path.join(profileDir, "node_modules", ...bundleName.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({
      name: bundleName,
      version: "1.0.0",
      dsh: { bundle: {} },
    }, null, 2)}\n`,
  );
}

async function main() {
  fs.mkdirSync(profileDir, { recursive: true });
  writeManifest({
    name: "paseo-profile",
    dependencies: { [bundleName]: "1.0.0" },
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"],
      },
    },
  });
  installBundle();

  const plugins = new DshPlugins({ dir: profileDir, profile: "paseo", dshHome: root });

  const enabled = await plugins.setEnabled(bundleName, true);
  assert.deepEqual(enabled, { changed: true, enabled: true });
  assert.deepEqual(bundles(), ["@deepseek-ai/dsh-base", "dsh-paseo-bridge", bundleName]);
  assert.equal(fs.existsSync(lockPath), false, "successful write must release the lock");

  const idempotent = await plugins.setEnabled(bundleName, true);
  assert.deepEqual(idempotent, { changed: false, enabled: true });

  // Two concurrent changes must serialize: exactly one observes a change.
  const concurrent = await Promise.all([
    plugins.setEnabled(bundleName, false),
    plugins.setEnabled(bundleName, false),
  ]);
  assert.equal(concurrent.filter((result) => result.changed).length, 1);
  assert.deepEqual(bundles(), ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"]);
  assert.equal(fs.existsSync(lockPath), false, "serialized writes must release the lock");

  // A stale lock from a dead process must be reclaimed.
  fs.writeFileSync(lockPath, "99999999\n");
  const reclaimed = await plugins.setEnabled(bundleName, true);
  assert.deepEqual(reclaimed, { changed: true, enabled: true });
  assert.equal(fs.existsSync(lockPath), false, "stale lock must be removed");

  const protectedResult = plugins.setEnabled("@deepseek-ai/dsh-base", false);
  await assert.rejects(protectedResult, /受保护/);
  assert.equal(fs.existsSync(lockPath), false, "rejected write must release the lock");

  // A corrupt manifest must fail without rewriting it, and without leaking the lock.
  fs.writeFileSync(manifestPath, "{\n");
  const before = fs.readFileSync(manifestPath, "utf8");
  await assert.rejects(plugins.setEnabled(bundleName, false), /不是有效 JSON/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
  assert.equal(fs.existsSync(lockPath), false, "failed parse must release the lock");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("PLUGINS_LOCK_OK");
}

main().catch((error) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
