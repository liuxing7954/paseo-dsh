/**
 * Resolve the official Windows npm launcher to its Node entrypoint.
 * No command shell is inserted, so stdio, argv and child termination stay native.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveDshCommand(binary, env = process.env, cwd = process.cwd()) {
  const unchanged = { command: binary, args: [] };
  if (process.platform !== "win32" || !/^dsh(?:\.cmd|\.ps1)?$/i.test(basename(binary))) return unchanged;

  const explicit = /[/\\]/.test(binary);
  // Node uses the first case-insensitive PATH key in lexicographic order.
  const pathKey = Object.keys(env).sort().find(key => key.toLowerCase() === "path");
  const directories = explicit
    ? [dirname(resolve(cwd, binary))]
    : (env[pathKey] ?? "").split(";").map(value => resolve(cwd, value.replace(/^"|"$/g, "")));

  for (const directory of directories) {
    // Preserve a native executable that would take precedence over an npm shim.
    if (!explicit && (existsSync(join(directory, "dsh.exe")) || existsSync(join(directory, "dsh.com")))) return unchanged;
    if (!existsSync(explicit ? resolve(cwd, binary) : join(directory, "dsh.cmd"))) continue;
    const packageDir = join(directory, "node_modules", "@deepseek-ai", "dsh");
    try {
      const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
      if (pkg.name !== "@deepseek-ai/dsh" || typeof bin !== "string") return unchanged;
      const entry = resolve(packageDir, bin);
      const local = relative(packageDir, entry);
      if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep) || !existsSync(entry)) return unchanged;
      // Match npm's launcher: use node.exe beside the shim, otherwise Node on PATH.
      const node = join(directory, "node.exe");
      return { command: existsSync(node) ? node : "node.exe", args: [entry] };
    } catch {
      // Leave missing or unrecognized installations to the normal spawn error.
      return unchanged;
    }
  }
  return unchanged;
}

