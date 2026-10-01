import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDshProvider } from "./server/provider";

/**
 * Register the DeepSeek Harness provider.
 *
 * The provider owns one `dsh --profile paseo` process per Paseo session and
 * translates its JSON-RPC surface into Paseo provider events: timeline rows,
 * composer controls (model, build/plan mode, thinking effort), and the question
 * cards that back `ask_user_question`.
 */
export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDshProvider());
  return () => {};
}
