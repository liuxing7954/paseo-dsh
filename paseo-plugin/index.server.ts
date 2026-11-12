import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensurePaseoProfile } from "./server/bootstrap";
import { DshPlugins } from "./server/dsh-plugins";
import { registerDshPluginsRpc } from "./server/dsh-plugins-rpc";
import { createDshProvider } from "./server/provider";

/**
 * Register the DeepSeek Harness provider, provisioning the DSH profile it needs.
 *
 * Paseo's plugin installer runs no install scripts, so this plugin is
 * self-sufficient: on load it writes `$DSH_HOME/profiles/<name>` and the bridge
 * bundle it carries (see server/bootstrap.ts). Provisioning is best-effort —
 * a filesystem failure is logged and the provider still registers, so the
 * failure surfaces as an honest error when a session tries to start `dsh`.
 *
 * The DSH Plugins page is registered even when provisioning fails: it opens on
 * the profile path and shows the real error, instead of disappearing.
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

  const manager = new DshPlugins();
  const disposePlugins = registerDshPluginsRpc(server, manager);
  server.registerProvider(createDshProvider());

  return () => {
    disposePlugins();
  };
}
