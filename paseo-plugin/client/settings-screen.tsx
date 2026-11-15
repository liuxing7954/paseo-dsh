import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  TIMELINE_STYLE_DEFAULTS,
  TIMELINE_STYLE_FIELDS,
  timelineStyleSettings,
  type TimelineStyleKey,
  type TimelineStyleValues,
} from "../shared/settings";

/** Numeric editor for the timeline row spacing and command drawer height. */
export function TimelineSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(timelineStyleSettings);
  const [draft, setDraft] = useState<Partial<Record<TimelineStyleKey, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const current: TimelineStyleValues = settings.status === "ready" ? settings.values : TIMELINE_STYLE_DEFAULTS;
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
    for (const field of TIMELINE_STYLE_FIELDS) {
      const value = Number.parseFloat(textOf(field.key));
      if (!Number.isFinite(value)) {
        setNotice(`「${field.label}」不是有效数字`);
        return;
      }
      next[field.key] = value;
    }
    const saved = await settings.save(next, settings.revision);
    setNotice(saved ? "已保存" : (settings.saveError ?? "保存失败"));
    if (saved) setDraft({});
  };

  const reset = async () => {
    const saved = await settings.reset();
    setNotice(saved ? "已恢复默认值" : (settings.saveError ?? "重置失败"));
    if (saved) setDraft({});
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>时间线样式</Text>
      <Text style={styles.intro}>
        工具行间距、行高和命令抽屉高度。保存后立即生效，不需要重启 Paseo。
      </Text>
      {TIMELINE_STYLE_FIELDS.map((field) => (
        <View key={field.key} style={styles.field}>
          <Text style={styles.label}>{field.label}</Text>
          <TextInput
            value={textOf(field.key)}
            onChangeText={(value: string) => edit(field.key, value)}
            keyboardType={field.key === "toolRowMarginY" ? (Platform.OS === "web" ? "default" : "numbers-and-punctuation") : "numeric"}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={field.label}
            style={styles.input}
          />
          <Text style={styles.hint}>{field.hint}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="保存"
          disabled={settings.status !== "ready" || settings.saving}
          onPress={() => void save()}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{settings.saving ? "保存中…" : "保存"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="恢复默认"
          disabled={settings.status !== "ready" || settings.saving}
          onPress={() => void reset()}
          style={[styles.button, styles.secondary]}
        >
          <Text style={styles.secondaryText}>恢复默认</Text>
        </Pressable>
      </View>
      {settings.status === "error" ? <Text style={styles.notice}>{settings.error}</Text> : null}
      {settings.status === "invalid" ? <Text style={styles.notice}>{settings.error}</Text> : null}
      {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}
    </ScrollView>
  );
}

export function contributeTimelineSettings(client: PluginClientContext): () => void {
  return client.addSettingsScreen({
    id: "timeline-style",
    title: "时间线样式",
    icon: "SlidersHorizontal",
    Component: TimelineSettingsScreen,
  });
}
