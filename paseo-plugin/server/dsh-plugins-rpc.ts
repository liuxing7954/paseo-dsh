import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  inspectSpecRpc,
  jobStatusRpc,
  listRpc,
  setEnabledRpc,
  startJobRpc,
} from "../shared/dsh-plugins-api";
import { failureOf, type DshPlugins } from "./dsh-plugins";

/**
 * Register the page's RPC methods.
 *
 * Reads and job polling reject so Paseo surfaces an error; mutations keep the
 * ok flag in their output so the page can show the failure inline.
 */
export function registerDshPluginsRpc(
  server: PluginServerContext,
  manager: DshPlugins,
): () => void {
  server.handle(listRpc, async () => manager.list());
  server.handle(setEnabledRpc, async (input) => {
    try {
      return await manager.setEnabled(input.name, input.enabled);
    } catch (error) {
      return {
        ok: false,
        changed: false,
        enabled: input.enabled,
        ...failureOf(error),
      };
    }
  });
  server.handle(inspectSpecRpc, async (input) => manager.inspectSpec(input.spec));
  server.handle(startJobRpc, async (input) => {
    try {
      return manager.startJob(input);
    } catch (error) {
      return { ok: false, ...failureOf(error) };
    }
  });
  server.handle(jobStatusRpc, async (input) => manager.status(input.id));

  return () => manager.dispose();
}
