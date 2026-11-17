import * as paseo from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Platform } from "react-native";
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
  const count = typeof args?.count === "number" ? args.count : undefined;
  if (count !== undefined) {
    const plural = lookup(catalog, `${key}_${pluralCategory(locale, count)}`);
    if (plural !== undefined) return interpolate(plural, args);
  }
  return interpolate(lookup(catalog, key) ?? key, args);
}

/** The label a host-owned registration takes: resolved on iOS, persistent elsewhere. */
export function translateForLabel(key: string): string {
  return translate(localLocale, key);
}

function useLocalTranslation() {
  const locale = localLocale;
  const t = useCallback<Translate>((key, args) => translate(locale, key, args), [locale]);
  return { locale, t };
}

const hostUseTranslation = (paseo as unknown as {
  useTranslation?: (resources: unknown) => { locale: string; t: unknown };
}).useTranslation;

function useHostTranslation() {
  if (hostUseTranslation === undefined) {
    throw new Error("This Paseo client does not provide useTranslation");
  }
  const { locale, t } = hostUseTranslation(messages);
  return { locale, t: t as unknown as Translate };
}

export const useTranslation: () => { locale: string; t: Translate } = isNativeApp
  ? useLocalTranslation
  : useHostTranslation;
