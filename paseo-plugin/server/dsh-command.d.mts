import type { ProcessEnv } from "node:process";

export function resolveDshCommand(
  binary: string,
  env?: ProcessEnv,
  cwd?: string,
): { command: string; args: string[] };

