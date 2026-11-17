/**
 * Bundle management for the DSH profile the Paseo provider drives.
 *
 * The heavy lifting (compatibility preflight, pnpm, rollback, bundle
 * activation) belongs to `dsh plugin`; this module only reads the profile,
 * exposes the bundle inventory, and shells out to that command. The one direct
 * write is enabling/disabling an already-installed bundle, which is a
 * `dsh.profile.bundles` edit under the same `package.json.lock` protocol DSH
 * uses. That keeps this page from inventing a second package manager.
 *
 * @module dsh-paseo/server/dsh-plugins
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BundleInfo,
  BundleRow,
  FailureCode,
  JobKind,
  JobState,
  InspectSpecOutput,
  JobStatus,
  PluginsSnapshot,
  SetEnabledOutput,
  StartJobInput,
  StartJobOutput,
} from "../shared/dsh-plugins-api";
import { dshHomeDir, profileDir, profileName } from "./bootstrap";
import { resolveDshCommand } from "./dsh-command.mjs";
import { resolveDshBinary } from "./dsh-process";

const BASE_BUNDLE = "@deepseek-ai/dsh-base";
const BRIDGE_BUNDLE = "dsh-paseo-bridge";
const PROTECTED_BUNDLES = new Set([BASE_BUNDLE, BRIDGE_BUNDLE]);

const OUTPUT_LIMIT = 16 * 1024;
const CAPTURE_LIMIT = 2 * 1024 * 1024;
const VIEW_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOCK_WAIT_MS = 120_000;
const MAX_RETAINED_JOBS = 20;

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: {
    profile?: { bundles?: string[] };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RunResult {
  code: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: string;
}

interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  output: string;
  errorCode?: FailureCode;
  errorDetail?: string;
  updates?: Record<string, string>;
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
}

export class ManagerError extends Error {
  readonly code: FailureCode;
  readonly detail?: string;

  constructor(code: FailureCode, detail?: string) {
    super(code);
    this.name = "ManagerError";
    this.code = code;
    this.detail = detail;
  }
}

export function failureOf(error: unknown): { errorCode: FailureCode; errorDetail?: string } {
  if (error instanceof ManagerError) {
    return {
      errorCode: error.code,
      ...(error.detail === undefined ? {} : { errorDetail: error.detail }),
    };
  }
  const detail = errorMessage(error);
  return {
    errorCode: "command-failed",
    ...(detail === "" ? {} : { errorDetail: detail }),
  };
}

export interface DshPluginsOptions {
  profile?: string;
  dir?: string;
  dshHome?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortDir(dir: string): string {
  const home = homedir();
  if (dir === home) return "~";
  if (dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
  return dir;
}

function parseProfileManifest(path: string, text: string): ProfileManifest {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed as ProfileManifest;
  } catch {
    throw new ManagerError("profile-invalid", path);
  }
}

function readProfileManifest(dir: string): ProfileManifest {
  const path = join(dir, "package.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ManagerError("profile-unreadable", path);
  }
  return parseProfileManifest(path, text);
}

/**
 * The manifest when the profile has one, `undefined` when it does not exist yet.
 *
 * A profile this plugin has never provisioned has no `package.json`, and
 * `dsh plugin` initializes it on first use. Treating that state like an
 * unreadable file made the first install fail on a profile the page could have
 * created. A file that exists but cannot be read or parsed still fails loudly:
 * that one hides real damage.
 */
function readProfileManifestIfPresent(dir: string): ProfileManifest | undefined {
  const path = join(dir, "package.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ManagerError("profile-unreadable", path);
  }
  return parseProfileManifest(path, text);
}

function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  const path = join(dir, "package.json");
  const temporary = join(dir, `.package.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function selectedBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles;
  return Array.isArray(bundles)
    ? bundles.filter((name): name is string => typeof name === "string")
    : [];
}

function dependencies(manifest: ProfileManifest): Record<string, string> {
  const value = manifest.dependencies;
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") result[name] = spec;
  }
  return result;
}

function readInstalledPackage(dir: string, name: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"),
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // A broken or absent package is a normal inventory state, not a reason to
    // fail the whole list.
    return undefined;
  }
}

function packageDsh(pkg: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(pkg.dsh) ? pkg.dsh : undefined;
}

function hasBundleManifest(pkg: Record<string, unknown>): boolean {
  const dsh = packageDsh(pkg);
  return isRecord(dsh?.bundle);
}

function hasClientUi(pkg: Record<string, unknown>): boolean {
  const dsh = packageDsh(pkg);
  return isRecord(dsh?.client);
}

const NODE_PLATFORMS = new Set([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);

/** Whether this host may load the bundle's optional `dsh.bundle.platforms` list. */
function bundlePlatformSupport(
  pkg: Record<string, unknown>,
): { supported: true } | { supported: false; reason: string } {
  const bundle = packageDsh(pkg)?.bundle;
  if (!isRecord(bundle) || bundle.platforms === undefined) return { supported: true };
  const platforms = bundle.platforms;
  if (
    !Array.isArray(platforms)
    || platforms.length === 0
    || !platforms.every((value) => typeof value === "string" && NODE_PLATFORMS.has(value))
  ) {
    return { supported: false, reason: "" };
  }
  if (!platforms.includes(process.platform)) {
    return { supported: false, reason: platforms.join(", ") };
  }
  return { supported: true };
}

/** Best-effort row ids from a bundle's patch file; a parse failure yields []. */
function readRows(packageDir: string, pkg: Record<string, unknown>): BundleRow[] {
  const bundle = packageDsh(pkg)?.bundle;
  if (!isRecord(bundle)) return [];
  const patch = bundle.patch;
  const paths = typeof patch === "string"
    ? [patch]
    : Array.isArray(patch)
      ? patch.filter((entry): entry is string => typeof entry === "string")
      : [];
  const rows: BundleRow[] = [];
  const seen = new Set<string>();
  for (const relativePath of paths) {
    try {
      const text = readFileSync(join(packageDir, relativePath), "utf8");
      const pattern = /^\s*-\s+id:\s*["']?([A-Za-z0-9._:@/-]+)["']?\s*$/gm;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const id = match[1];
        if (!seen.has(id)) {
          seen.add(id);
          rows.push({ id });
        }
      }
    } catch {
      // The patch may be generated or absent; rows are display-only here.
    }
  }
  return rows;
}

function isRegistrySpec(spec: string): boolean {
  const value = spec.trim();
  if (value === "" || value.length > 214) return false;
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) return false;
  if (value.includes("\\") || value.includes(":") || value.includes("..")) return false;
  if (/\s/.test(value)) return false;
  return /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9^~<>=.*+|-]+)?$/i.test(value);
}

/**
 * Dependency specs are version ranges, not package names. Keep this separate
 * from `isRegistrySpec`, which validates the spec typed into the install box.
 */
function isRegistryDependencySpec(spec: string): boolean {
  const value = spec.trim();
  if (value === "" || value.length > 214) return false;
  if (/^(?:file|link|git|github|https?|ssh|workspace|portal|npm):/i.test(value)) return false;
  if (value.includes("\\") || value.includes("/") || value.includes("..")) return false;
  if (/\s/.test(value)) return false;
  if (value === "latest" || value === "next" || value === "*") return true;
  return /^[\^~<>=v]?\d/.test(value);
}

function registryName(spec: string): string {
  const value = spec.trim();
  const at = value.lastIndexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

function versionParts(version: string): { numbers: number[]; prerelease?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

function isNewer(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const previous = versionParts(current);
  if (!next || !previous) return candidate !== current;
  for (let index = 0; index < 3; index += 1) {
    if (next.numbers[index] !== previous.numbers[index]) {
      return next.numbers[index] > previous.numbers[index];
    }
  }
  if (next.prerelease === previous.prerelease) return false;
  if (next.prerelease === undefined) return true;
  if (previous.prerelease === undefined) return false;
  return next.prerelease > previous.prerelease;
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("empty JSON");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const startObject = trimmed.indexOf("{");
    const startArray = trimmed.indexOf("[");
    const start = startObject < 0
      ? startArray
      : startArray < 0
        ? startObject
        : Math.min(startObject, startArray);
    if (start < 0) throw new Error("no JSON value");
    const endObject = trimmed.lastIndexOf("}");
    const endArray = trimmed.lastIndexOf("]");
    const end = Math.max(endObject, endArray);
    if (end <= start) throw new Error("no complete JSON value");
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n").trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function withPackageLock<T>(dir: string, action: () => Promise<T> | T): Promise<T> {
  const lockPath = join(dir, "package.json.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockPid(lockPath);
      if (holder !== undefined && !isProcessAlive(holder)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ManagerError("lock-timeout", `package.json.lock (${Math.round(LOCK_WAIT_MS / 1000)}s)`);
      }
      await sleep(100);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  try {
    return await action();
  } finally {
    // Release only a lock this process still holds. DSH takes a dead holder's
    // lock over, so an unconditional unlink could delete the lock its new
    // owner had just created and let two writers into the manifest.
    const holder = readLockPid(lockPath);
    if (holder === undefined || holder === process.pid) rmSync(lockPath, { force: true });
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const pid = child.pid;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // The process may already be gone.
      }
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3_000);
  timer.unref();
}

export class DshPlugins {
  readonly profile: string;
  readonly dir: string;
  readonly dshHome: string;

  #jobs = new Map<string, Job>();
  #activeJobId: string | undefined;
  #updates = new Map<string, string>();
  #dshVersionPromise: Promise<string | undefined> | undefined;
  #children = new Set<ChildProcess>();
  #disposed = false;

  constructor(options: DshPluginsOptions = {}) {
    this.profile = options.profile ?? profileName();
    this.dshHome = options.dshHome ?? dshHomeDir();
    this.dir = options.dir ?? profileDir(this.profile, this.dshHome);
  }

  /** Read the profile inventory. Never starts a package operation. */
  async list(): Promise<PluginsSnapshot> {
    try {
      return await this.#snapshot();
    } catch (error) {
      const failure = failureOf(error);
      return {
        profile: this.profile,
        dir: this.dir,
        displayDir: shortDir(this.dir),
        bundles: [],
        busy: false,
        ...failure,
      };
    }
  }

  async #snapshot(): Promise<PluginsSnapshot> {
    const manifest = readProfileManifest(this.dir);
    const deps = dependencies(manifest);
    const selected = selectedBundles(manifest);
    const names: string[] = [];
    const add = (name: string) => {
      if (!names.includes(name)) names.push(name);
    };
    add(BASE_BUNDLE);
    add(BRIDGE_BUNDLE);
    selected.forEach(add);
    Object.keys(deps).forEach(add);

    const dshVersion = await this.#getDshVersion();
    const bundles = names.map((name) => this.#describe(name, deps[name], selected, dshVersion));
    const activeJob = this.#activeJobId === undefined ? undefined : this.#jobs.get(this.#activeJobId);
    return {
      profile: this.profile,
      dir: this.dir,
      displayDir: shortDir(this.dir),
      bundles,
      busy: activeJob !== undefined,
      ...(activeJob === undefined ? {} : {
        activeJobId: activeJob.id,
        activeJobKind: activeJob.kind,
      }),
    };
  }

  /**
   * Enable or disable an installed bundle by editing only the ordered
   * `dsh.profile.bundles` list. Dependencies stay installed, so disabling is
   * reversible without a download.
   */
  async setEnabled(name: string, enabled: boolean): Promise<SetEnabledOutput> {
    const bundleName = name.trim();
    if (bundleName === "") throw new ManagerError("invalid-name");
    if (PROTECTED_BUNDLES.has(bundleName)) {
      throw new ManagerError("protected", bundleName);
    }

    return withPackageLock(this.dir, () => {
      const manifest = readProfileManifest(this.dir);
      const deps = dependencies(manifest);
      const current = selectedBundles(manifest);
      if (enabled) {
        if (deps[bundleName] === undefined) {
          throw new ManagerError("not-installed", bundleName);
        }
        const installed = readInstalledPackage(this.dir, bundleName);
        if (installed === undefined || !hasBundleManifest(installed)) {
          throw new ManagerError("not-a-bundle", bundleName);
        }
        const platform = bundlePlatformSupport(installed);
        if (!platform.supported) throw new ManagerError("invalid-platform", platform.reason);
        if (current.includes(bundleName)) {
          return { ok: true, changed: false, enabled: true };
        }
        current.push(bundleName);
      } else {
        if (!current.includes(bundleName)) {
          return { ok: true, changed: false, enabled: false };
        }
        const index = current.indexOf(bundleName);
        current.splice(index, 1);
      }

      const dsh = isRecord(manifest.dsh) ? manifest.dsh : {};
      const profile = isRecord(dsh.profile) ? dsh.profile : {};
      manifest.dsh = { ...dsh, profile: { ...profile, bundles: current } };
      writeProfileManifest(this.dir, manifest);
      return { ok: true, changed: true, enabled };
    });
  }

  /** Inspect an npm registry spec before the user commits to installing it. */
  async inspectSpec(spec: string): Promise<InspectSpecOutput> {
    const value = spec.trim();
    if (!isRegistrySpec(value)) {
      return { ok: false, client: false, errorCode: "invalid-spec" };
    }

    let result: RunResult;
    try {
      result = await this.#runPlugin(["view", value, "--json"], VIEW_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, client: false, ...failureOf(error) };
    }
    if (result.code !== 0) {
      return { ok: false, client: false, ...this.#commandFailure(result) };
    }

    let manifest: unknown;
    try {
      manifest = parseJsonLoose(result.stdout);
    } catch {
      return { ok: false, client: false, errorCode: "registry-unreadable" };
    }
    if (!isRecord(manifest)) {
      return { ok: false, client: false, errorCode: "registry-invalid" };
    }
    const dsh = packageDsh(manifest);
    if (!isRecord(dsh?.bundle)) {
      return { ok: false, client: false, errorCode: "not-a-bundle" };
    }

    return {
      ok: true,
      name: stringValue(manifest.name) ?? registryName(value),
      version: stringValue(manifest.version),
      description: stringValue(manifest.description) ?? "",
      client: hasClientUi(manifest),
    };
  }

  /** Start one package operation. At most one may run at a time. */
  startJob(input: StartJobInput): StartJobOutput {
    if (this.#disposed) throw new ManagerError("disposed");
    if (this.#activeJobId !== undefined) {
      throw new ManagerError("busy", this.#activeJobId);
    }
    const job: Job = {
      id: randomUUID(),
      kind: input.kind,
      state: "running",
      output: "",
      startedAt: Date.now(),
    };
    this.#jobs.set(job.id, job);
    this.#activeJobId = job.id;

    void this.#runJob(job, input)
      .then(() => {
        job.state = "succeeded";
      })
      .catch((error) => {
        job.state = "failed";
        const failure = failureOf(error);
        job.errorCode = failure.errorCode;
        job.errorDetail = failure.errorDetail;
      })
      .finally(() => {
        job.finishedAt = Date.now();
        if (this.#activeJobId === job.id) this.#activeJobId = undefined;
        this.#pruneJobs();
      });

    return { ok: true, id: job.id };
  }

  status(id: string): JobStatus {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new ManagerError("job-missing", id);
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      output: job.output,
      ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
      ...(job.errorDetail === undefined ? {} : { errorDetail: job.errorDetail }),
      ...(job.updates === undefined ? {} : { updates: job.updates }),
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    };
  }

  /** Kill running children when Paseo unloads the plugin. */
  dispose(): void {
    this.#disposed = true;
    for (const child of this.#children) killTree(child);
    this.#children.clear();
    if (this.#activeJobId !== undefined) {
      const job = this.#jobs.get(this.#activeJobId);
      if (job !== undefined) {
        if (job.child !== undefined) killTree(job.child);
        job.state = "failed";
        job.errorCode = "disposed";
        job.finishedAt = Date.now();
      }
      this.#activeJobId = undefined;
    }
    this.#jobs.clear();
  }

  #describe(
    name: string,
    spec: string | undefined,
    selected: string[],
    dshVersion: string | undefined,
  ): BundleInfo {
    const official = name === BASE_BUNDLE;
    const protectedBundle = PROTECTED_BUNDLES.has(name);
    const pkg = official ? undefined : readInstalledPackage(this.dir, name);
    const installed = official || pkg !== undefined;
    const bundleManifest = official || (pkg !== undefined && hasBundleManifest(pkg));
    const enabled = selected.includes(name);
    const version = official
      ? dshVersion
      : pkg === undefined
        ? undefined
        : stringValue(pkg.version);
    const kind: BundleInfo["kind"] = !installed
      ? "missing"
      : bundleManifest || enabled
        ? "bundle"
        : "dependency";
    const client = pkg !== undefined && hasClientUi(pkg);
    const platform = pkg === undefined ? { supported: true as const } : bundlePlatformSupport(pkg);
    const rows = pkg === undefined ? [] : readRows(join(this.dir, "node_modules", name), pkg);
    const description = official
      ? ""
      : pkg !== undefined
        ? stringValue(pkg.description) ?? ""
        : "";
    const updatable = !official
      && !protectedBundle
      && installed
      && bundleManifest
      && version !== undefined
      && versionParts(version) !== undefined
      && spec !== undefined
      && isRegistryDependencySpec(spec);
    const cachedUpdate = this.#updates.get(name);
    const update = cachedUpdate !== undefined
      && version !== undefined
      && isNewer(cachedUpdate, version)
      ? cachedUpdate
      : undefined;

    return {
      name,
      ...(version === undefined ? {} : { version }),
      description,
      enabled,
      installed,
      kind,
      protected: protectedBundle,
      official,
      client,
      platformSupported: platform.supported,
      ...(platform.supported ? {} : { platformReason: platform.reason }),
      removable: !protectedBundle && installed && spec !== undefined,
      updatable,
      ...(update === undefined ? {} : { update }),
      rows,
    };
  }

  async #runJob(job: Job, input: StartJobInput): Promise<void> {
    switch (input.kind) {
      case "install": {
        const spec = input.spec.trim();
        const inspected = await this.inspectSpec(spec);
        if (!inspected.ok) {
          throw new ManagerError(inspected.errorCode ?? "command-failed", inspected.errorDetail);
        }
        const name = inspected.name ?? registryName(spec);
        const manifest = readProfileManifestIfPresent(this.dir);
        if (manifest !== undefined && dependencies(manifest)[name] !== undefined) {
          throw new ManagerError("already-installed", name);
        }
        const result = await this.#runPlugin(
          ["add", "--save-exact", spec],
          INSTALL_TIMEOUT_MS,
          job,
        );
        if (result.code !== 0) throw new ManagerError("command-failed", this.#commandFailure(result).errorDetail);
        return;
      }
      case "remove": {
        const name = input.name.trim();
        if (PROTECTED_BUNDLES.has(name)) {
          throw new ManagerError("protected", name);
        }
        const manifest = readProfileManifest(this.dir);
        if (dependencies(manifest)[name] === undefined) {
          throw new ManagerError("not-removable", name);
        }
        const result = await this.#runPlugin(["remove", name], INSTALL_TIMEOUT_MS, job);
        if (result.code !== 0) throw new ManagerError("command-failed", this.#commandFailure(result).errorDetail);
        return;
      }
      case "update": {
        const name = input.name.trim();
        const version = input.version.trim();
        if (PROTECTED_BUNDLES.has(name)) {
          throw new ManagerError("protected", name);
        }
        if (!isRegistrySpec(`${name}@${version}`)) {
          throw new ManagerError("invalid-version", version);
        }
        const manifest = readProfileManifest(this.dir);
        if (dependencies(manifest)[name] === undefined) {
          throw new ManagerError("not-in-dependencies", name);
        }
        const installed = readInstalledPackage(this.dir, name);
        if (installed === undefined || !hasBundleManifest(installed)) {
          throw new ManagerError("not-a-bundle", name);
        }
        const result = await this.#runPlugin(
          ["add", "--save-exact", `${name}@${version}`],
          INSTALL_TIMEOUT_MS,
          job,
        );
        if (result.code !== 0) throw new ManagerError("command-failed", this.#commandFailure(result).errorDetail);
        this.#updates.delete(name);
        return;
      }
      case "check":
        await this.#checkUpdates(job);
        return;
    }
  }

  async #checkUpdates(job: Job): Promise<void> {
    const snapshot = await this.list();
    if (snapshot.errorCode !== undefined) {
      throw new ManagerError(snapshot.errorCode, snapshot.errorDetail);
    }
    const candidates = snapshot.bundles.filter((bundle) => bundle.updatable);
    this.#updates.clear();
    if (candidates.length === 0) {
      job.updates = {};
      return;
    }

    const failures: string[] = [];
    for (const bundle of candidates) {
      const result = await this.#runPlugin(
        ["view", bundle.name, "version", "--json"],
        VIEW_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        failures.push(`${bundle.name}: ${lastLines(result.output, 4)}`);
        continue;
      }
      let latest: string | undefined;
      try {
        const parsed = parseJsonLoose(result.stdout);
        latest = typeof parsed === "string"
          ? parsed
          : isRecord(parsed)
            ? stringValue(parsed.version)
            : undefined;
      } catch {
        latest = undefined;
      }
      if (latest === undefined) {
        failures.push(`${bundle.name}: unreadable version`);
        continue;
      }
      if (bundle.version !== undefined && isNewer(latest, bundle.version)) {
        this.#updates.set(bundle.name, latest);
      }
    }
    job.updates = Object.fromEntries(this.#updates);
    if (failures.length > 0) {
      throw new ManagerError("check-failed", failures.join("\n"));
    }
  }

  #commandFailure(result: RunResult): { errorCode: "command-failed"; errorDetail: string } {
    const reason = result.timedOut ? "timeout" : `exit ${result.code}`;
    const tail = lastLines(result.output, 20);
    return {
      errorCode: "command-failed",
      errorDetail: tail === "" ? reason : `${reason}\n${tail}`,
    };
  }

  async #getDshVersion(): Promise<string | undefined> {
    this.#dshVersionPromise ??= this.#readDshVersion();
    return this.#dshVersionPromise;
  }

  async #readDshVersion(): Promise<string | undefined> {
    try {
      const result = await this.#runDsh(["--version"], 5_000);
      const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${result.stdout}\n${result.output}`);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  #runPlugin(args: string[], timeoutMs: number, job?: Job): Promise<RunResult> {
    return this.#runDsh(["plugin", "--profile", this.profile, ...args], timeoutMs, job);
  }

  #runDsh(args: string[], timeoutMs: number, job?: Job): Promise<RunResult> {
    if (this.#disposed) {
      return Promise.reject(new ManagerError("disposed"));
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      const env = { ...process.env, DSH_HOME: this.dshHome };
      const launch = resolveDshCommand(resolveDshBinary(env), env, this.dir);
      try {
        child = spawn(launch.command, [...launch.args, ...args], {
          cwd: this.dir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(new ManagerError("spawn-failed", `${launch.command}: ${errorMessage(error)}`));
        return;
      }

      this.#children.add(child);
      if (job !== undefined) job.child = child;

      let stdout = "";
      let stderr = "";
      let output = "";
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        const fallback = setTimeout(() => {
          finish({ code: 124, timedOut: true, stdout, stderr, output });
        }, 5_000);
        fallback.unref();
      }, timeoutMs);
      timer.unref();

      const push = (chunk: string): void => {
        output = (output + chunk).slice(-OUTPUT_LIMIT);
        if (job !== undefined) {
          job.output = `${job.output}${chunk}`.slice(-OUTPUT_LIMIT);
        }
      };
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (job !== undefined && job.child === child) job.child = undefined;
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (job !== undefined && job.child === child) job.child = undefined;
        reject(error);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-CAPTURE_LIMIT);
        push(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-CAPTURE_LIMIT);
        push(chunk);
      });
      child.on("error", (error) => {
        this.#children.delete(child);
        fail(new ManagerError("spawn-failed", `${launch.command}: ${error.message}`));
      });
      child.on("close", (code) => {
        this.#children.delete(child);
        finish({
          code: code ?? (timedOut ? 124 : 1),
          timedOut,
          stdout,
          stderr,
          output,
        });
      });
    });
  }

  #pruneJobs(): void {
    for (const [id] of this.#jobs) {
      if (this.#jobs.size <= MAX_RETAINED_JOBS) break;
      if (id !== this.#activeJobId) this.#jobs.delete(id);
    }
  }
}
