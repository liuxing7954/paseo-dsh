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
  JobKind,
  JobState,
  JobStatus,
  PluginsSnapshot,
  SetEnabledOutput,
  StartJobInput,
} from "../shared/dsh-plugins-api";
import { dshHomeDir, profileDir, profileName } from "./bootstrap";
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
  error?: string;
  updates?: Record<string, string>;
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
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

function readProfileManifest(dir: string): ProfileManifest {
  const path = join(dir, "package.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`读不到 profile 的 package.json：${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed as ProfileManifest;
  } catch {
    throw new Error(`profile 的 package.json 不是有效 JSON：${path}`);
  }
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
    return { supported: false, reason: "dsh.bundle.platforms 声明无效，不能启用。" };
  }
  if (!platforms.includes(process.platform)) {
    return {
      supported: false,
      reason: `当前平台 ${process.platform} 不在支持列表（${platforms.join(", ")}）中，不能启用。`,
    };
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
        throw new Error(`等待 profile 写锁超时（${Math.round(LOCK_WAIT_MS / 1000)} 秒）。`);
      }
      await sleep(100);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  try {
    return await action();
  } finally {
    rmSync(lockPath, { force: true });
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
    if (bundleName === "") throw new Error("bundle 名称不能为空。");
    if (PROTECTED_BUNDLES.has(bundleName)) {
      throw new Error(`${bundleName} 是受保护的 bundle，不能更改。`);
    }

    return withPackageLock(this.dir, () => {
      const manifest = readProfileManifest(this.dir);
      const deps = dependencies(manifest);
      const current = selectedBundles(manifest);
      if (enabled) {
        if (deps[bundleName] === undefined) {
          throw new Error(`${bundleName} 没有安装，不能启用。`);
        }
        const installed = readInstalledPackage(this.dir, bundleName);
        if (installed === undefined || !hasBundleManifest(installed)) {
          throw new Error(`${bundleName} 没有声明 dsh.bundle，不能加入 profile 层。`);
        }
        const platform = bundlePlatformSupport(installed);
        if (!platform.supported) throw new Error(platform.reason);
        if (current.includes(bundleName)) {
          return { changed: false, enabled: true };
        }
        current.push(bundleName);
      } else {
        if (!current.includes(bundleName)) {
          return { changed: false, enabled: false };
        }
        const index = current.indexOf(bundleName);
        current.splice(index, 1);
      }

      const dsh = isRecord(manifest.dsh) ? manifest.dsh : {};
      const profile = isRecord(dsh.profile) ? dsh.profile : {};
      manifest.dsh = { ...dsh, profile: { ...profile, bundles: current } };
      writeProfileManifest(this.dir, manifest);
      return { changed: true, enabled };
    });
  }

  /** Inspect an npm registry spec before the user commits to installing it. */
  async inspectSpec(spec: string): Promise<{
    ok: boolean;
    name?: string;
    version?: string;
    description?: string;
    client: boolean;
    error?: string;
  }> {
    const value = spec.trim();
    if (!isRegistrySpec(value)) {
      return {
        ok: false,
        client: false,
        error: "只支持 npm registry 包名，例如 pkg 或 pkg@1.2.3；本地路径、git、tarball 都不支持。",
      };
    }

    let result: RunResult;
    try {
      result = await this.#runPlugin(["view", value, "--json"], VIEW_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, client: false, error: errorMessage(error) };
    }
    if (result.code !== 0) {
      return { ok: false, client: false, error: this.#commandError(result) };
    }

    let manifest: unknown;
    try {
      manifest = parseJsonLoose(result.stdout);
    } catch {
      return { ok: false, client: false, error: "无法解析 registry 返回的包信息。" };
    }
    if (!isRecord(manifest)) {
      return { ok: false, client: false, error: "registry 没有返回有效的包信息。" };
    }
    const dsh = packageDsh(manifest);
    if (!isRecord(dsh?.bundle)) {
      return {
        ok: false,
        client: false,
        error: "这个包没有声明 dsh.bundle，装进 profile 不会生效。",
      };
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
  startJob(input: StartJobInput): { id: string } {
    if (this.#disposed) throw new Error("插件已卸载，不能开始新的任务。");
    if (this.#activeJobId !== undefined) {
      throw new Error("已有管理任务在运行，请等待它完成。");
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
        job.error = errorMessage(error);
        if (job.output.trim() === "") job.output = job.error;
      })
      .finally(() => {
        job.finishedAt = Date.now();
        if (this.#activeJobId === job.id) this.#activeJobId = undefined;
        this.#pruneJobs();
      });

    return { id: job.id };
  }

  status(id: string): JobStatus {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new Error("任务不存在或已过期。");
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      output: job.output,
      ...(job.error === undefined ? {} : { error: job.error }),
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
        job.error = "插件已卸载，任务中止。";
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
      ? "DeepSeek Harness 基础 bundle"
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
        if (!inspected.ok) throw new Error(inspected.error ?? "无法检查这个包。");
        const name = inspected.name ?? registryName(spec);
        const manifest = readProfileManifest(this.dir);
        if (dependencies(manifest)[name] !== undefined) {
          throw new Error(`${name} 已经安装；请在列表里启用它，或使用更新。`);
        }
        const result = await this.#runPlugin(
          ["add", "--save-exact", spec],
          INSTALL_TIMEOUT_MS,
          job,
        );
        if (result.code !== 0) throw new Error(this.#commandError(result));
        return;
      }
      case "remove": {
        const name = input.name.trim();
        if (PROTECTED_BUNDLES.has(name)) {
          throw new Error(`${name} 是受保护的 bundle，不能卸载。`);
        }
        const manifest = readProfileManifest(this.dir);
        if (dependencies(manifest)[name] === undefined) {
          throw new Error(`只有 package.json 依赖里的包可以卸载：${name}`);
        }
        const result = await this.#runPlugin(["remove", name], INSTALL_TIMEOUT_MS, job);
        if (result.code !== 0) throw new Error(this.#commandError(result));
        return;
      }
      case "update": {
        const name = input.name.trim();
        const version = input.version.trim();
        if (PROTECTED_BUNDLES.has(name)) {
          throw new Error(`${name} 是受保护的 bundle，不能更新。`);
        }
        if (!isRegistrySpec(`${name}@${version}`)) {
          throw new Error("更新版本不是有效的 registry 版本。");
        }
        const manifest = readProfileManifest(this.dir);
        if (dependencies(manifest)[name] === undefined) {
          throw new Error(`${name} 不在 profile 依赖里，不能更新。`);
        }
        const installed = readInstalledPackage(this.dir, name);
        if (installed === undefined || !hasBundleManifest(installed)) {
          throw new Error(`${name} 不是 DSH bundle，不能更新。`);
        }
        const result = await this.#runPlugin(
          ["add", "--save-exact", `${name}@${version}`],
          INSTALL_TIMEOUT_MS,
          job,
        );
        if (result.code !== 0) throw new Error(this.#commandError(result));
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
    const candidates = snapshot.bundles.filter((bundle) => bundle.updatable);
    this.#updates.clear();
    if (candidates.length === 0) {
      job.output = `${job.output}没有可检查更新的 bundle。\n`;
      job.updates = {};
      return;
    }

    const failures: string[] = [];
    for (const bundle of candidates) {
      job.output = `${job.output}检查 ${bundle.name}…\n`.slice(-OUTPUT_LIMIT);
      const result = await this.#runPlugin(
        ["view", bundle.name, "version", "--json"],
        VIEW_TIMEOUT_MS,
        job,
      );
      if (result.code !== 0) {
        failures.push(`${bundle.name}：${lastLines(result.output, 4) || "查询失败"}`);
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
        failures.push(`${bundle.name}：无法解析最新版本`);
        continue;
      }
      if (bundle.version !== undefined && isNewer(latest, bundle.version)) {
        this.#updates.set(bundle.name, latest);
      }
    }
    job.updates = Object.fromEntries(this.#updates);
    if (failures.length > 0) {
      throw new Error(`部分 bundle 检查失败：\n${failures.join("\n")}`);
    }
  }

  #commandError(result: RunResult): string {
    const reason = result.timedOut
      ? "命令超时"
      : `命令退出码 ${result.code}`;
    const tail = lastLines(result.output, 20);
    return tail === "" ? reason : `${reason}\n${tail}`;
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
      return Promise.reject(new Error("插件已卸载，不能启动新的进程。"));
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(resolveDshBinary(), args, {
          cwd: this.dir,
          env: { ...process.env, DSH_HOME: this.dshHome },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(new Error(`无法启动 ${resolveDshBinary()}：${errorMessage(error)}`));
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
        fail(new Error(`无法启动 ${resolveDshBinary()}：${error.message}`));
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
