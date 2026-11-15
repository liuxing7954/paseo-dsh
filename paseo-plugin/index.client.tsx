import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  const cleanups = [contributeStreamStats(client), contributeTimeline(client)];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
