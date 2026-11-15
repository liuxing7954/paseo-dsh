import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeTimelineSettings } from "./client/settings-screen";
import { contributeTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    contributeStreamStats(client),
    contributeTimeline(client),
    contributeTimelineSettings(client),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
