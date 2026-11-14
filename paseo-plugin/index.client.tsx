import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeWorkDisplay } from "./client/work-display";

export default function contribute(client: PluginClientContext) {
  const removeStats = contributeStreamStats(client);
  const removeWork = contributeWorkDisplay(client);
  return () => { removeWork(); removeStats(); };
}
