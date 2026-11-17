import { defineTranslations } from "@getpaseo/plugin/client";
import type { PluginTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/**
 * Every user-visible string the plugin draws in the app.
 *
 * English is the source of truth for the key set; `zh-CN` may omit a key and
 * falls back to English. Paseo resolves the app language per installation, so
 * the same bundle serves both catalogs and a language switch re-renders the
 * rows without reloading the plugin.
 *
 * `defineTranslations` is read off the module instead of imported by name: a
 * client whose plugin runtime predates the i18n API still has to load this
 * bundle. The fallback keeps `message()` usable as a plain English label,
 * which such a host accepts where it would reject a `PluginMessage` object.
 */
type Catalog = typeof en;

const resources = { en, "zh-CN": zhCN } as const;

// A client that predates the i18n API has no such export; the compiled bundle
// then reads `undefined` here instead of throwing at module link time.
const define = defineTranslations as unknown as
  | ((input: { resources: unknown }) => PluginTranslations<Catalog>)
  | undefined;

function english(key: string): string {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : key;
}

function createMessages(): PluginTranslations<Catalog> {
  if (typeof define === "function") {
    try {
      return define({ resources });
    } catch (error) {
      // A broken host runtime must not take the bundle down while it loads.
      try {
        console.error("[dsh-paseo] defineTranslations", error);
      } catch {
        // Ignore a console that is itself unavailable.
      }
    }
  }
  return {
    resources,
    message: (key: string) => english(key),
  } as unknown as PluginTranslations<Catalog>;
}

export const messages = createMessages();

/** Bare verb keys a tool row can resolve to; they carry no interpolation. */
export type ToolVerbKey =
  | "timeline.tool.command"
  | "timeline.tool.image"
  | "timeline.tool.read"
  | "timeline.tool.write"
  | "timeline.tool.edit"
  | "timeline.tool.search"
  | "timeline.tool.webSearch"
  | "timeline.tool.fetch"
  | "timeline.tool.browser"
  | "timeline.tool.code"
  | "timeline.tool.tasks"
  | "timeline.tool.question";

export type BrowserVerbKey =
  | "timeline.browser.open"
  | "timeline.browser.click"
  | "timeline.browser.type"
  | "timeline.browser.snapshot"
  | "timeline.browser.scroll"
  | "timeline.browser.navigate"
  | "timeline.browser.wait"
  | "timeline.browser.close"
  | "timeline.browser.run"
  | "timeline.browser.find";

/** A resolve-on-render verb: a catalog key, or the provider's raw tool name. */
export type ToolVerb = ToolVerbKey | BrowserVerbKey | { readonly text: string };
