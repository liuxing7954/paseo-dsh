#!/usr/bin/env node
/**
 * Discover what a model route can actually do, so its capabilities can be
 * declared in a DSH profile with evidence instead of guesswork.
 *
 * DSH resolves a route's reasoning support from its model metadata. A route the
 * installed catalog knows nothing about — any self-hosted or self-configured
 * provider — reports *no* reasoning at all, and DSH then rejects every effort
 * with `UNSUPPORTED_REASONING_EFFORT`. That reads like a model limitation but is
 * usually just a missing declaration, so this probes the endpoint itself.
 *
 * It answers the two questions that decide the profile config:
 *   1. Does the route do reasoning, and which `reasoning_effort` spellings does
 *      it accept? (`off` is special: the parameter must be omitted entirely,
 *      because most gateways reject the literal string.)
 *   2. Does it accept the OpenAI reasoning-model `developer` role? If not, the
 *      profile must set `compat.supportsDeveloperRole: false`, or every turn
 *      fails with a 422 the moment reasoning is declared.
 *
 * Usage:
 *   node tools/probe-provider.mjs \
 *     --base-url https://gateway.example/v1 \
 *     --api-key-env MY_API_KEY \
 *     --model deepseek-v4-flash
 *
 * The key is read from the named environment variable and never printed.
 *
 * @module paseo-dsh/tools/probe-provider
 */

const CANDIDATE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Parse `--flag value` pairs into a plain object. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function usage(message) {
  if (message !== undefined) process.stderr.write(`error: ${message}\n\n`);
  process.stderr.write(
    "usage: probe-provider.mjs --base-url <url> --api-key-env <ENV_VAR> --model <id> [--model <id>...]\n",
  );
  process.exit(message === undefined ? 0 : 2);
}

/** One chat completion, reporting whether the endpoint accepted the request. */
async function attempt(endpoint, apiKey, body) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const detail = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 240);
    return { ok: false, status: response.status, detail: String(detail) };
  }
  return { ok: true, status: response.status, body: parsed };
}

/** The message object of the first choice, if the response carried one. */
function messageOf(body) {
  return body?.choices?.[0]?.message;
}

function reasoningChars(message) {
  return String(message?.reasoning_content ?? message?.reasoning ?? "").length;
}

async function probeModel(endpoint, apiKey, model) {
  const findings = { levels: [], developerRole: undefined, reasonsAtBaseline: undefined };

  const baseline = await attempt(endpoint, apiKey, {
    model,
    messages: [{ role: "user", content: "What is 17*23? Reply with just the number." }],
    max_tokens: 256,
  });
  if (!baseline.ok) return { ...findings, fatal: baseline };

  const baselineMessage = messageOf(baseline.body);
  findings.reasonsAtBaseline =
    baselineMessage === undefined ? false : "reasoning_content" in baselineMessage || reasoningChars(baselineMessage) > 0;

  const developer = await attempt(endpoint, apiKey, {
    model,
    messages: [
      { role: "developer", content: "You are terse." },
      { role: "user", content: "What is 17*23? Reply with just the number." },
    ],
    max_tokens: 256,
  });
  findings.developerRole = developer.ok;

  for (const level of CANDIDATE_LEVELS) {
    const result = await attempt(endpoint, apiKey, {
      model,
      messages: [{ role: "user", content: "What is 17*23? Reply with just the number." }],
      max_tokens: 256,
      reasoning_effort: level,
    });
    findings.levels.push({ level, ok: result.ok, status: result.status, detail: result.detail });
  }
  return findings;
}

/** Render the profile fragment a user can paste after the probe. */
function profileSnippet(model, findings) {
  const accepted = findings.levels.filter((entry) => entry.ok).map((entry) => entry.level);
  const lines = [`          - id: ${model}`, `            name: ${model}`];
  if (accepted.length === 0) return lines.join("\n");
  lines.push("            reasoningEfforts:");
  // `off` must carry no value: omitting the parameter is what turns thinking
  // off, while the literal string is rejected by most gateways.
  lines.push("              off:");
  for (const level of accepted) lines.push(`              ${level}: ${level}`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) usage();
  const baseUrl = typeof args["base-url"] === "string" ? args["base-url"].replace(/\/$/, "") : undefined;
  const keyEnv = typeof args["api-key-env"] === "string" ? args["api-key-env"] : undefined;
  const models = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--model" && process.argv[i + 1] !== undefined) models.push(process.argv[i + 1]);
  }
  if (baseUrl === undefined) usage("--base-url is required");
  if (keyEnv === undefined) usage("--api-key-env is required");
  if (models.length === 0) usage("at least one --model is required");

  const apiKey = process.env[keyEnv];
  if (apiKey === undefined || apiKey === "") {
    process.stderr.write(`error: environment variable ${keyEnv} is empty or unset\n`);
    process.exit(2);
  }

  const endpoint = `${baseUrl}/chat/completions`;
  process.stdout.write(`endpoint: ${endpoint}\n\n`);

  for (const model of models) {
    process.stdout.write(`model: ${model}\n`);
    const findings = await probeModel(endpoint, apiKey, model);
    if (findings.fatal !== undefined) {
      process.stdout.write(
        `  baseline call .......... FAILED (${findings.fatal.status || "network"}) ${findings.fatal.detail}\n`,
      );
      process.stdout.write("  cannot probe further; check the base URL, key, and model id\n\n");
      continue;
    }
    process.stdout.write(
      `  baseline call .......... ok (reasoning content at baseline: ${
        findings.reasonsAtBaseline ? "yes" : "no"
      })\n`,
    );
    process.stdout.write(
      `  role=developer ......... ${
        findings.developerRole ? "accepted" : "REJECTED -> needs compat.supportsDeveloperRole: false"
      }\n`,
    );
    for (const entry of findings.levels) {
      process.stdout.write(
        `  reasoning_effort=${entry.level.padEnd(8)} ${entry.ok ? "accepted" : `rejected (${entry.status})`}\n`,
      );
    }
    const accepted = findings.levels.filter((entry) => entry.ok);
    process.stdout.write("\n  profile fragment:\n\n");
    process.stdout.write(`${profileSnippet(model, findings)}\n`);
    if (accepted.length === 0) {
      process.stdout.write(
        "\n  no reasoning_effort spelling was accepted; declare `reasoningEfforts: false`\n"
        + "  for this model so DSH reports it as a non-reasoning route\n",
      );
    }
    process.stdout.write("\n");
  }
}

await main();
