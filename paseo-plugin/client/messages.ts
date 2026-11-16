import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/**
 * Every user-visible string the plugin draws in the app.
 *
 * English is the source of truth for the key set; `zh-CN` may omit a key and
 * falls back to English. Paseo resolves the app language per installation, so
 * the same bundle serves both catalogs and a language switch re-renders the
 * rows without reloading the plugin.
 */
export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });

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
