import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { guardCleanup, installFatalGuard, report } from "./client/guard";
import { PluginsIcon } from "./client/icons";
import { DshPluginsPage } from "./client/dsh-plugins-page";
import { bootstrapLanguage } from "./client/language";
import { persistentLabel } from "./client/labels";
import { contributeStreamStats } from "./client/stream-stats";
import {
  DISPLAY_SETTINGS_ID,
  contributeDisplaySettingsCommand,
  contributeTimelineSettings,
} from "./client/settings-screen";
import { contributeTimeline } from "./client/timeline";


function buildContributions(client: PluginClientContext) {
  bootstrapLanguage(client);
  const title = persistentLabel("plugins.page.title");
  const openDisplaySettings = () => client.openSettings(DISPLAY_SETTINGS_ID);
  const PluginsScreen = (props: PluginSurfaceProps) => (
    <DshPluginsPage {...props} openDisplaySettings={openDisplaySettings} />
  );
  const cleanups = [
    guardCleanup("stream stats", () => contributeStreamStats(client)),
    guardCleanup("timeline", () => contributeTimeline(client)),
    guardCleanup("timeline settings", () => contributeTimelineSettings(client)),
    guardCleanup("display settings command", () => contributeDisplaySettingsCommand(client)),
    guardCleanup("plugins screen", () => client.addScreen({
      id: "dsh-plugins",
      title,
      Component: PluginsScreen,
    })),
    guardCleanup("plugins sidebar", () => client.addSidebarItem({
      id: "dsh-plugins",
      title,
      icon: PluginsIcon,
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
  installFatalGuard();
  try {
    return buildContributions(client);
  } catch (error) {
    report("plugin client entry", error);
    return () => {};
  }
}
