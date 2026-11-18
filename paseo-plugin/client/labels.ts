import { Platform } from "react-native";
import { translateForLabel } from "./i18n";
import { messages } from "./messages";

/** Host-owned labels this plugin registers; each is a key in every catalog. */
export type PersistentKey = "plugins.page.title" | "settings.title" | "settings.command";

/**
 * The screen, sidebar and settings labels are persistent host-owned
 * registrations, so they take a catalog message rather than a string: a `t()`
 * result is a snapshot and would keep the language the plugin loaded with.
 *
 * Paseo 0.16.0's native apps are the exception. Their host registers and draws
 * these labels before resolving a `PluginMessage`, so the object is either
 * rejected while the contribution registers or reaches React as a child.
 * Either path ends in an uncaught JS error, and release Hermes turns that into
 * an abort of the whole app. Resolve the entry from the bundled catalog there;
 * the desktop (web) host keeps the persistent message.
 */
export function persistentLabel(key: PersistentKey) {
  if (Platform.OS === "web") return messages.message(key);
  return translateForLabel(key);
}
