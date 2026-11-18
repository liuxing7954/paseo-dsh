import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { setLanguageOverride, translateForLabel, useTranslation } from "./i18n";
import { FailedRow, guardAsync, withPluginBoundary } from "./guard";
import { SlidersIcon } from "./icons";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  LANGUAGE_DEFAULTS,
  TIMELINE_STYLE_DEFAULTS,
  TIMELINE_STYLE_KEYS,
  languageSettings,
  timelineStyleSettings,
  type LanguageChoice,
  type TimelineStyleKey,
  type TimelineStyleValues,
} from "../shared/settings";
import { persistentLabel } from "./labels";

/** Editor rows: the key order is shared, the wording comes from the catalogs. */
const FIELDS = TIMELINE_STYLE_KEYS.map((key) => ({
  key,
  label: `settings.field.${key}.label` as const,
  hint: `settings.field.${key}.hint` as const,
}));

/** The three language choices; the catalogs own the wording. */
const LANGUAGE_OPTIONS = [
  { value: "auto", label: "settings.language.auto" },
  { value: "en", label: "settings.language.en" },
  { value: "zh-CN", label: "settings.language.zhCN" },
] as const satisfies readonly { value: LanguageChoice; label: string }[];

/** Numeric editor for the timeline row spacing and command drawer height, plus the plugin language. */
export function TimelineSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useTranslation();
  const settings = useSettings(timelineStyleSettings);
  const language = useSettings(languageSettings);
  const [draft, setDraft] = useState<Partial<Record<TimelineStyleKey, string>>>({});
  const [pickedLanguage, setPickedLanguage] = useState<LanguageChoice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current: TimelineStyleValues = settings.status === "ready" ? settings.values : TIMELINE_STYLE_DEFAULTS;
  const currentLanguage: LanguageChoice = pickedLanguage
    ?? (language.status === "ready" ? language.values.language : LANGUAGE_DEFAULTS.language);
  const compact = layout.compact;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: compact ? 12 : 14 },
      title: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
      intro: { color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14, lineHeight: compact ? 19 : 21 },
      field: { gap: 5 },
      label: { color: theme.colors.foreground, fontSize: compact ? 13 : 14, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 12.5, lineHeight: 17 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: compact ? 9 : 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        fontSize: compact ? 13 : 14,
      },
      languageRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      languageButton: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: compact ? 8 : 9,
        backgroundColor: theme.colors.surface1,
      },
      languageButtonSelected: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      languageLabel: { color: theme.colors.foreground, fontSize: compact ? 12.5 : 13, fontWeight: "600" as const },
      languageLabelSelected: { color: theme.colors.accentForeground },
      actions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
      button: {
        paddingHorizontal: 16,
        paddingVertical: compact ? 9 : 10,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        opacity: settings.status !== "ready" || settings.saving ? 0.6 : 1,
      },
      secondary: {
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const, fontSize: compact ? 13 : 14 },
      secondaryText: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: compact ? 13 : 14 },
      notice: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 },
    }),
    [theme, compact, settings.status, settings.saving],
  );

  const textOf = (key: TimelineStyleKey): string => draft[key] ?? String(current[key]);
  const edit = (key: TimelineStyleKey, value: string) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setNotice(null);
  };

  const save = async () => {
    if (settings.status !== "ready") return;
    const next: TimelineStyleValues = { ...current };
    for (const field of FIELDS) {
      const value = Number.parseFloat(textOf(field.key));
      if (!Number.isFinite(value)) {
        setNotice(t("settings.invalidNumber", { label: t(field.label) }));
        return;
      }
      next[field.key] = value;
    }
    const saved = await settings.save(next, settings.revision);
    setNotice(saved ? t("settings.saved") : (settings.saveError ?? t("settings.saveFailed")));
    if (saved) setDraft({});
  };

  const reset = async () => {
    const saved = await settings.reset();
    setNotice(saved ? t("settings.resetDone") : (settings.saveError ?? t("settings.resetFailed")));
    if (saved) setDraft({});
  };

  const chooseLanguage = async (value: LanguageChoice) => {
    if (language.status !== "ready" || language.saving || value === currentLanguage) return;
    const saved = await language.save({ language: value }, language.revision);
    if (saved) {
      setPickedLanguage(value);
      setLanguageOverride(value);
      setNotice(null);
    } else {
      setNotice(language.saveError ?? t("settings.saveFailed"));
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{t("settings.title")}</Text>
      <Text style={styles.intro}>{t("settings.intro")}</Text>
      <View style={styles.field}>
        <Text style={styles.label}>{t("settings.language.label")}</Text>
        <View style={styles.languageRow}>
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = currentLanguage === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={t(option.label)}
                disabled={language.status !== "ready" || language.saving}
                onPress={() => guardAsync("language save", () => chooseLanguage(option.value))}
                style={[styles.languageButton, selected ? styles.languageButtonSelected : null]}
              >
                <Text style={[styles.languageLabel, selected ? styles.languageLabelSelected : null]}>
                  {t(option.label)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{t("settings.language.hint")}</Text>
      </View>
      {FIELDS.map((field) => (
        <View key={field.key} style={styles.field}>
          <Text style={styles.label}>{t(field.label)}</Text>
          <TextInput
            value={textOf(field.key)}
            onChangeText={(value: string) => edit(field.key, value)}
            keyboardType={field.key === "rowMarginY" ? (Platform.OS === "web" ? "default" : "numbers-and-punctuation") : "numeric"}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t(field.label)}
            style={styles.input}
          />
          <Text style={styles.hint}>{t(field.hint)}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.save")}
          disabled={settings.status !== "ready" || settings.saving}
          onPress={() => guardAsync("settings save", save)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{settings.saving ? t("settings.saving") : t("settings.save")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.reset")}
          disabled={settings.status !== "ready" || settings.saving}
          onPress={() => guardAsync("settings reset", reset)}
          style={[styles.button, styles.secondary]}
        >
          <Text style={styles.secondaryText}>{t("settings.reset")}</Text>
        </Pressable>
      </View>
      {settings.status === "error" ? <Text style={styles.notice}>{settings.error}</Text> : null}
      {settings.status === "invalid" ? <Text style={styles.notice}>{settings.error}</Text> : null}
      {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}
    </ScrollView>
  );
}

/** The display settings screen, for anything that links to it. */
export const DISPLAY_SETTINGS_ID = "timeline-style";

export function contributeTimelineSettings(client: PluginClientContext): () => void {
  return client.addSettingsScreen({
    id: DISPLAY_SETTINGS_ID,
    title: persistentLabel("settings.title"),
    icon: SlidersIcon,
    Component: withPluginBoundary<PluginSurfaceProps>(
      "timeline settings",
      TimelineSettingsScreen,
      (props) => <FailedRow theme={props.theme} message={translateForLabel("settings.renderFailed")} />,
    ),
  });
}

/**
 * Reach the display settings from the Command Center, without going through
 * Settings, Plugins and the plugin's settings page.
 */
export function contributeDisplaySettingsCommand(client: PluginClientContext): () => void {
  return client.addCommandCenterItem({
    id: "dsh-display-settings",
    title: persistentLabel("settings.command"),
    icon: SlidersIcon,
    keywords: ["DSH", "display", "timeline", "spacing", "language", "显示", "时间线", "行间距", "语言"],
    context: "global",
    onSelect: (command) => command.openSettings(DISPLAY_SETTINGS_ID),
  });
}
