/**
 * `paseo-dsh doctor` — one-command self-check for a DeepSeek Harness × Paseo
 * install.
 *
 * It verifies the things that silently break a fresh install: the CLIs are
 * present, the plugin has provisioned the DSH profile (which only happens once
 * the daemon loads the plugin), the bridge is materialized, a model route is
 * actually configured, and every referenced `apiKeyEnv` has a credential. It
 * only reads; it never changes anything.
 *
 * @module paseo-dsh/lib/doctor
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

const results = [];
function report(level, label, detail) {
  results.push(level);
  const tag = level === "ok" ? `${GREEN}ok  ${RESET}` : level === "warn" ? `${YELLOW}warn${RESET}` : `${RED}fail${RESET}`;
  process.stdout.write(`  [${tag}] ${label}${detail ? `\n         ${DIM}${detail}${RESET}` : ""}\n`);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function findPaseo() {
  // Prefer the app-bundled CLI: a `paseo` on PATH is often a stale npm install.
  const bundled = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  if (existsSync(bundled)) {
    const v = run(bundled, ["--version"]);
    if (v !== undefined) return { cmd: bundled, version: v };
  }
  const v = run("paseo", ["--version"]);
  if (v !== undefined) return { cmd: "paseo", version: v };
  return undefined;
}

function line(v) {
  return v.split("\n").find((entry) => entry.trim() !== "") ?? v;
}

/** Strip full-line comments so "route configured?" isn't fooled by the template. */
function activeLines(text) {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

export function runDoctor() {
  const pluginVersion = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profile = process.env.DSH_PASEO_PROFILE ?? "paseo";
  const profileDir = join(dshHome, "profiles", profile);

  process.stdout.write(`\n${DIM}paseo-dsh doctor  (plugin ${pluginVersion})${RESET}\n\n`);

  // 1. CLIs
  const dshVersion = run("dsh", ["--version"]);
  if (dshVersion === undefined) {
    report("fail", "dsh on PATH", "install the official DeepSeek Harness and put `dsh` on the daemon's PATH");
  } else {
    const dshLine = line(dshVersion);
    const dshMM = dshLine.match(/(\d+)\.(\d+)/);
    const pluginMM = pluginVersion.match(/^(\d+)\.(\d+)/);
    if (dshMM && pluginMM && `${dshMM[1]}.${dshMM[2]}` !== `${pluginMM[1]}.${pluginMM[2]}`) {
      report("warn", `dsh ${dshLine}`, `plugin ${pluginVersion} targets the ${pluginMM[1]}.${pluginMM[2]}.x DSH line`);
    } else {
      report("ok", `dsh ${dshLine}`);
    }
  }

  const paseo = findPaseo();
  if (paseo === undefined) {
    report("fail", "paseo CLI not found", "expected `paseo` on PATH or /Applications/Paseo.app");
  } else if (Number(paseo.version.match(/\d+\.(\d+)/)?.[1] ?? 0) < 9) {
    report("warn", `paseo ${paseo.version}`, "needs Paseo >= 0.9.2 for the direct provider plugin API");
  } else {
    report("ok", `paseo ${paseo.version}`);
  }

  // 2. profile provisioned by the plugin
  if (!existsSync(profileDir)) {
    report(
      "fail",
      `DSH profile "${profile}" missing`,
      `expected ${profileDir}. Install the plugin and restart the daemon — the plugin creates it on load.`,
    );
    finish(pluginVersion);
    return;
  }
  report("ok", `DSH profile at ${profileDir}`);

  const bridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
  const bridgeEntry = join(bridgeDir, "lib", "server.js");
  if (existsSync(bridgeEntry)) {
    report("ok", "bridge bundle provisioned", bridgeDir);
  } else {
    report("fail", "bridge bundle missing", `expected ${bridgeEntry}; restart the daemon to let the plugin re-provision`);
  }

  // 3. model route
  const patchPath = join(profileDir, "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    report("fail", "no cordis.patch.yml", `the plugin should have written one at ${patchPath}`);
    finish(pluginVersion);
    return;
  }
  const patch = readFileSync(patchPath, "utf8");
  const active = activeLines(patch);
  const configured = active.includes("agent-default-model") && /providers:\s*$/m.test(active);
  if (configured) {
    const tail = active.split("agent-default-model").pop() ?? "";
    const provider = tail.match(/provider:\s*([^\s#]+)/)?.[1];
    const model = tail.match(/model:\s*([^\s#]+)/)?.[1];
    report("ok", "model route configured", provider && model ? `default: ${provider} / ${model}` : undefined);
  } else {
    report(
      "warn",
      "model route not configured yet",
      `edit ${patchPath} (see the README install walkthrough) then restart the daemon`,
    );
  }

  // 4. credentials for every referenced apiKeyEnv
  const credentialPath = join(dshHome, ".credentials.yaml");
  const credentialText = existsSync(credentialPath) ? readFileSync(credentialPath, "utf8") : "";
  const referenced = [...active.matchAll(/apiKeyEnv:\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const unique = [...new Set(referenced)];
  if (unique.length === 0) {
    report("warn", "no apiKeyEnv referenced", "the route above should name the credential to use");
  } else {
    for (const name of unique) {
      const has = new RegExp(`(^|\\n)\\s*${name}\\s*:`).test(credentialText);
      if (has) report("ok", `credential ${name} found`);
      else
        report(
          "warn",
          `credential ${name} missing`,
          `add "${name}: <your-key>" under refs: in ${credentialPath}`,
        );
    }
  }

  finish(pluginVersion);
}

function finish() {
  const fails = results.filter((r) => r === "fail").length;
  const warns = results.filter((r) => r === "warn").length;
  process.stdout.write("\n");
  if (fails > 0) {
    process.stdout.write(`${RED}${fails} blocking issue(s)${RESET}${warns ? `, ${warns} warning(s)` : ""}.\n`);
    process.exitCode = 1;
  } else if (warns > 0) {
    process.stdout.write(`${YELLOW}${warns} warning(s)${RESET} — nothing blocking, but fix the above before relying on it.\n`);
  } else {
    process.stdout.write(`${GREEN}All checks passed.${RESET} New a session in Paseo with provider "DeepSeek Harness (native)".\n`);
  }
}
