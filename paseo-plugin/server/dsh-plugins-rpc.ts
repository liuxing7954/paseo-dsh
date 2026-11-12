import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  inspectSpecRpc,
  jobStatusRpc,
  listRpc,
  setEnabledRpc,
  startJobRpc,
} from "../shared/dsh-plugins-api";
import type { DshPlugins } from "./dsh-plugins";

/**
 * Register the page's RPC methods.
 *
 * Handlers deliberately let errors reject: Paseo turns a rejected RPC into a
 * visible failure, while a resolved error object would look like success.
 */
export function registerDshPluginsRpc(
  server: PluginServerContext,
  manager: DshPlugins,
): () => void {
  server.handle(listRpc, async () => manager.list());
  server.handle(setEnabledRpc, async (input) => manager.setEnabled(input.name, input.enabled));
  server.handle(inspectSpecRpc, async (input) => manager.inspectSpec(input.spec));
  server.handle(startJobRpc, async (input) => manager.startJob(input));
  server.handle(jobStatusRpc, async (input) => manager.status(input.id));

  return () => manager.dispose();
}
