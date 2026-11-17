#!/usr/bin/env node
/**
 * Guard the locale catalogs and the keys the client asks for.
 *
 * Run it after any change that touches a user-facing string:
 *
 *   node scripts/check-locales.mjs
 *
 * Catalogs are discovered from `client/locales/*.json`, so adding a language
 * needs no change here. English is the source of truth:
 *
 *   - a key the client asks for must exist in `en`
 *   - another language may omit a key (it falls back to English) but may not
 *     invent one, rename a `{{placeholder}}`, or use a non-canonical file name
 *   - a plural base key in `en` needs its `_other` form
 *   - an `en` key nothing in `client/` asks for is dead weight
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localeDir = join(root, "client/locales");

/** Canonical BCP-47 tags only: `en`, `ja`, `zh-CN`, `pt-BR`. */
const CANONICAL_TAG = /^[a-z]{2,3}(?:-[A-Z][a-zA-Z]{3}|-[A-Z]{2})?$/;
const PLURAL = /_(?:zero|one|two|few|many|other)$/;

const files = readdirSync(localeDir).filter((name) => name.endsWith(".json"));
const catalogs = new Map();
const problems = [];

/** Flatten nested resources into dotted paths. */
function flatten(node, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}

/** Interpolation names, so a translation cannot rename one. */
function placeholders(text) {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)/g)].map((match) => match[1]).sort().join(",");
}

for (const file of files) {
  const tag = file.slice(0, -".json".length);
  if (!CANONICAL_TAG.test(tag)) {
    problems.push(`"locales/${file}" is not a canonical language tag (use "zh-CN", not "zh-cn")`);
    continue;
  }
  catalogs.set(tag, flatten(JSON.parse(readFileSync(join(localeDir, file), "utf8"))));
}

const enKeys = catalogs.get("en");
if (enKeys === undefined) {
  console.error('[locales] client/locales/en.json is required: English is the key source of truth');
  process.exit(1);
}

for (const [tag, keys] of catalogs) {
  if (tag === "en") continue;
  for (const [key, value] of keys) {
    if (!enKeys.has(key)) {
      problems.push(`${tag} has "${key}" with no English source`);
      continue;
    }
    if (placeholders(value) !== placeholders(enKeys.get(key))) {
      problems.push(`placeholder mismatch for ${tag} "${key}": "${enKeys.get(key)}" vs "${value}"`);
    }
  }
}

for (const key of enKeys.keys()) {
  const base = key.replace(PLURAL, "");
  if (base === key) continue;
  if (key.endsWith("_other")) continue;
  if (enKeys.has(`${base}_other`)) continue;
  problems.push(`plural base "${base}" has "${key}" but no _other form`);
}

// Keys the client can ask for: `t("a.b")`, `messages.message("a.b")`, and the
// literals used as tool verbs or status keys.
const used = new Set();
const clientDir = join(root, "client");
for (const file of readdirSync(clientDir)) {
  if (!/\.tsx?$/.test(file)) continue;
  const source = readFileSync(join(clientDir, file), "utf8");
  for (const match of source.matchAll(/[mt]\(\s*"((?:timeline|streamStats|settings|plugins)\.[^"]+)"/g)) {
    used.add(match[1]);
  }
  for (const match of source.matchAll(/"((?:timeline|streamStats|settings|plugins)\.[a-zA-Z.-]+)"/g)) {
    used.add(match[1]);
  }
}

for (const key of used) {
  // A plural base is asked for without its suffix.
  if (enKeys.has(key) || enKeys.has(`${key}_other`)) continue;
  problems.push(`client asks for "${key}" but en.json has no such key`);
}

for (const key of enKeys.keys()) {
  const base = key.replace(PLURAL, "");
  if (used.has(key) || used.has(base)) continue;
  // Field labels and hints are reached through `settings.field.<key>.<part>`.
  if (key.startsWith("settings.field.")) continue;
  problems.push(`en.json has "${key}" but nothing in client/ asks for it`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[locales] ${problem}`);
  process.exit(1);
}

const summary = [...catalogs].map(([tag, keys]) => `${tag} ${keys.size}`).join(", ");
console.log(`[locales] ok: ${summary} keys, ${used.size} used`);
