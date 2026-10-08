import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensurePaseoProfile } from "./server/bootstrap";
import { createDshProvider } from "./server/provider";

/**
 * Register the DeepSeek Harness provider, provisioning the DSH profile it needs.
 *
 * Paseo's plugin installer runs no install scripts, so this plugin is
 * self-sufficient: on load it writes `$DSH_HOME/profiles/<name>` and the bridge
 * bundle it carries (see server/bootstrap.ts). Provisioning is best-effort —
 * a filesystem failure is logged and the provider still registers, so the
 * failure surfaces as an honest error when a session tries to start `dsh`.
 */
export default function contribute(server: PluginServerContext) {
  try {
    const provisioned = ensurePaseoProfile();
    process.stderr.write(
      `[dsh-paseo] DSH profile "${provisioned.profile}" ready at ${provisioned.dir}`
        + ` (${provisioned.bridgeFiles} bridge files${provisioned.patchCreated ? ", starter patch written" : ""})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[dsh-paseo] could not provision the DSH profile: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  server.registerProvider(createDshProvider());
  return () => {};
}
