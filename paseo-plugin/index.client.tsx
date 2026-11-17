import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DshPluginsPage } from "./client/dsh-plugins-page";
import { messages } from "./client/messages";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeTimelineSettings } from "./client/settings-screen";
import { contributeTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  // The screen and sidebar labels are persistent host-owned registrations, so
  // they take a catalog message rather than a string: a `t()` result is a
  // snapshot and would keep the language the plugin loaded with.
  const title = messages.message("plugins.page.title");
  const cleanups = [
    contributeStreamStats(client),
    contributeTimeline(client),
    contributeTimelineSettings(client),
    client.addScreen({
      id: "dsh-plugins",
      title,
      Component: DshPluginsPage,
    }),
    client.addSidebarItem({
      id: "dsh-plugins",
      title,
      icon: "Blocks",
      surface: "dsh-plugins",
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
