import { useTranslation as hostUseTranslationImport } from "@getpaseo/plugin/client";
import { useCallback, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { LanguageChoice } from "../shared/settings";
import { messages } from "./messages";

export type Translate = (key: string, args?: Record<string, unknown>) => string;

/**
 * In the native apps the plugin draws its own strings from the bundled catalogs
 * instead of going through the host's `useTranslation`.
 *
 * Paseo 0.16.0's native plugin runtime is where the i18n API is newest, and a
 * throw from that hook reaches React during render — fatal in a release build.
 * Nothing on this path depends on the host: catalogs ship in the bundle,
 * missing keys already fall back to English, and the app language is read from
 * the system locale, which is what the native clients start with. The desktop
 * (web) host keeps the host hook, including live language switching.
 */
const isNativeApp = Platform.OS !== "web";

/**
 * The plugin's language setting. `auto` means "follow the host / system"; the
 * other values force a bundled catalog. It lives at module scope because the
 * setting is read once at load and every surface subscribes to it, instead of
 * each row issuing its own settings request.
 */
let languageOverride: LanguageChoice = "auto";
let overrideLocked = false;
const languageListeners = new Set<() => void>();

function notifyLanguage(): void {
  for (const listener of languageListeners) listener();
}

/** Apply an explicit choice from the settings screen and re-render every surface. */
export function setLanguageOverride(value: LanguageChoice): void {
  overrideLocked = true;
  if (value === languageOverride) return;
  languageOverride = value;
  notifyLanguage();
}

/**
 * Apply the value read from storage. The read is asynchronous and can land
 * after the user picked a new value, so it must not clobber an explicit choice.
 */
export function applyStoredLanguage(value: LanguageChoice): void {
  if (overrideLocked || value === languageOverride) return;
  languageOverride = value;
  notifyLanguage();
}

export function getLanguageOverride(): LanguageChoice {
  return languageOverride;
}

function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

function useLanguageOverride(): LanguageChoice {
  return useSyncExternalStore(subscribeLanguage, getLanguageOverride, getLanguageOverride);
}

function deviceLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof locale === "string" && locale !== "") return locale;
  } catch {
    // Hermes without Intl falls through to English.
  }
  return "en";
}

const localLocale = deviceLocale();

function resolveLocale(fallback: string): string {
  return languageOverride === "auto" ? fallback : languageOverride;
}

function catalogFor(locale: string): unknown {
  return locale.toLowerCase().startsWith("zh")
    ? messages.resources["zh-CN"]
    : messages.resources.en;
}

function lookup(resource: unknown, key: string): string | undefined {
  let node: unknown = resource;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, args?: Record<string, unknown>): string {
  if (args === undefined) return template;
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name: string) => {
    const value = args[name];
    if (value === undefined) return "";
    if (value instanceof Date) return value.toLocaleString();
    return String(value);
  });
}

function pluralCategory(locale: string, count: number): "one" | "other" {
  // Both catalogs only ever need English's one/other split; Chinese is `other`.
  if (locale.toLowerCase().startsWith("zh")) return "other";
  return Math.abs(count) === 1 ? "one" : "other";
}

/** Resolve one catalog key for a locale, with `{{name}}` and count support. */
export function translate(locale: string, key: string, args?: Record<string, unknown>): string {
  const catalog = catalogFor(locale);
  const english = catalogFor("en");
  const count = typeof args?.count === "number" ? args.count : undefined;
  if (count !== undefined) {
    // A catalog may omit a form (Chinese has no `_one`), so a missing plural
    // falls back to English instead of leaking the key into the UI.
    const plural = lookup(catalog, `${key}_${pluralCategory(locale, count)}`)
      ?? lookup(english, `${key}_${pluralCategory("en", count)}`);
    if (plural !== undefined) return interpolate(plural, args);
  }
  return interpolate(lookup(catalog, key) ?? lookup(english, key) ?? key, args);
}

/** The label a host-owned registration takes: resolved on iOS, persistent elsewhere. */
export function translateForLabel(key: string): string {
  return translate(resolveLocale(localLocale), key);
}

function useLocalTranslation() {
  const override = useLanguageOverride();
  const locale = override === "auto" ? localLocale : override;
  const t = useCallback<Translate>((key, args) => translate(locale, key, args), [locale]);
  return { locale, t };
}

const hostUseTranslation = hostUseTranslationImport as unknown as
  | ((resources: unknown) => { locale: string; t: unknown })
  | undefined;

function useHostTranslation() {
  if (hostUseTranslation === undefined) {
    throw new Error("This Paseo client does not provide useTranslation");
  }
  const { locale: hostLocale, t: hostT } = hostUseTranslation(messages);
  const override = useLanguageOverride();
  const locale = override === "auto" ? hostLocale : override;
  const localT = useCallback<Translate>((key, args) => translate(locale, key, args), [locale]);
  return override === "auto"
    ? { locale, t: hostT as unknown as Translate }
    : { locale, t: localT };
}

export const useTranslation: () => { locale: string; t: Translate } = isNativeApp
  ? useLocalTranslation
  : useHostTranslation;
