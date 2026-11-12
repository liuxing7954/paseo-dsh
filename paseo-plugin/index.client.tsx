import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DshPluginsPage } from "./client/dsh-plugins-page";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeTimelineSettings } from "./client/settings-screen";
import { contributeTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    contributeStreamStats(client),
    contributeTimeline(client),
    contributeTimelineSettings(client),
    client.addScreen({
      id: "dsh-plugins",
      title: "DSH Plugins",
      Component: DshPluginsPage,
    }),
    client.addSidebarItem({
      id: "dsh-plugins",
      title: "DSH Plugins",
      icon: "Blocks",
      surface: "dsh-plugins",
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
