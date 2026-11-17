import type { PluginClientContext } from "@getpaseo/plugin/client";
import { guardCleanup, report } from "./client/guard";
import { DshPluginsPage } from "./client/dsh-plugins-page";
import { persistentLabel } from "./client/labels";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeTimelineSettings } from "./client/settings-screen";
import { contributeTimeline } from "./client/timeline";

/**
 * The icon travels as inline SVG rather than a Lucide name: the app ships a
 * pruned icon set, and a name it does not know is rejected while the host
 * registers the sidebar row.
 */
const PLUGIN_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/></svg>',
};

function buildContributions(client: PluginClientContext) {
  const title = persistentLabel("plugins.page.title");
  const cleanups = [
    guardCleanup("stream stats", () => contributeStreamStats(client)),
    guardCleanup("timeline", () => contributeTimeline(client)),
    guardCleanup("timeline settings", () => contributeTimelineSettings(client)),
    guardCleanup("plugins screen", () => client.addScreen({
      id: "dsh-plugins",
      title,
      Component: DshPluginsPage,
    })),
    guardCleanup("plugins sidebar", () => client.addSidebarItem({
      id: "dsh-plugins",
      title,
      icon: PLUGIN_ICON,
      surface: "dsh-plugins",
    })),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Nothing this entry point does may reach the host as an exception: release
 * Hermes reports an uncaught plugin error as fatal and closes the whole app,
 * including for users who never opened a DSH screen.
 */
export default function contribute(client: PluginClientContext) {
  try {
    return buildContributions(client);
  } catch (error) {
    report("plugin client entry", error);
    return () => {};
  }
}
