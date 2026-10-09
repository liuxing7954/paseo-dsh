#!/usr/bin/env node
/**
 * `paseo-dsh` CLI — helper commands for a DeepSeek Harness × Paseo install.
 *
 *   paseo-dsh doctor   self-check the install (CLIs, profile, bridge, route, key)
 *   paseo-dsh probe    probe a model route's reasoning/developer-role support
 *   paseo-dsh help
 *
 * Ships inside the `paseo-dsh` npm package, so it runs from `npx paseo-dsh ...`
 * with no repository clone.
 *
 * @module paseo-dsh/bin
 */
import { runDoctor } from "../lib/doctor.mjs";
import { runProbe } from "../lib/probe-provider.mjs";

const HELP = `paseo-dsh — DeepSeek Harness × Paseo helper

Usage:
  paseo-dsh doctor                 Check this install: dsh/paseo, the DSH
                                   profile, the bridge, the model route, keys.
  paseo-dsh probe [options]        Probe a model route before writing its config.
      --base-url <url>             OpenAI-compatible endpoint, e.g. https://gw/v1
      --api-key-env <ENV_VAR>      Env var holding the key (never printed)
      --model <id> [--model <id>]  One or more model ids
  paseo-dsh help

Install the plugin itself with:  paseo plugin add npm:paseo-dsh
`;

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "doctor":
    runDoctor();
    break;
  case "probe":
    await runProbe(rest, "paseo-dsh probe");
    break;
  case "help":
  case "-h":
  case "--help":
    process.stdout.write(HELP);
    break;
  default:
    process.stderr.write(`unknown command "${command}"\n\n${HELP}`);
    process.exitCode = 2;
}
