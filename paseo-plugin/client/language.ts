import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { languageSettings } from "../shared/settings";
import { report } from "./guard";
import { applyStoredLanguage } from "./i18n";

/**
 * Read the device's language choice once when the plugin loads.
 *
 * `auto` is the safe fallback: a host that predates the settings RPC, a first
 * install and a failed read all leave the plugin following the app language.
 * The value is validated against the schema because a settings document can
 * come from an older or newer plugin build.
 */
export function bootstrapLanguage(client: PluginClientContext): void {
  void Promise.resolve()
    .then(() => client.rpc(settingsRpc(languageSettings.id).read, {}))
    .then((state) => {
      if (state.status !== "ready") return;
      const parsed = languageSettings.schema.safeParse(state.values);
      if (parsed.success) applyStoredLanguage(parsed.data.language);
    })
    .catch((error) => {
      report("language settings", error);
    });
}
