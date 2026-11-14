import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import {
  RUN_CODE_KIND, REASONING_KIND, runCodeSchema, reasoningSchema, reasoningPreview,
  type ActivityStatus, type RunCodeData, type ReasoningData,
} from "../shared/work-display";

const STATUS_LABELS: Record<ActivityStatus, string> = {
  running: "Running", completed: "Completed", failed: "Failed", canceled: "Canceled",
};

function Disclosure({ title, preview, status, theme, children }: {
  title: string; preview: string; status: ActivityStatus;
  theme: PluginTimelineItemProps["theme"]; children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const muted = theme.colors.foregroundMuted;
  const color = status === "failed" ? theme.colors.statusDanger : muted;
  return (
    <View style={{ paddingVertical: 4, gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${preview || STATUS_LABELS[status]}. ${open ? "Collapse" : "Expand"}`}
        accessibilityState={{ expanded: open, busy: status === "running" }}
        onPress={() => setOpen(value => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 7, minHeight: 24 }}
      >
        <Text style={{ color: muted, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
        <Text numberOfLines={1} style={{ color, fontSize: 13, lineHeight: 20, flexShrink: 0 }}>{title}</Text>
        {preview !== "" ? (
          <Text numberOfLines={1} style={{ color: muted, fontSize: 13, lineHeight: 20, flex: 1 }}>{preview}</Text>
        ) : <View style={{ flex: 1 }} />}
        <Text style={{ color, fontSize: 11, flexShrink: 0 }}>{STATUS_LABELS[status]}</Text>
      </Pressable>
      {open ? (
        <ScrollView nestedScrollEnabled style={{ maxHeight: 360, backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6 }}
          contentContainerStyle={{ padding: 12 }}>
          {children()}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Mount large text only after opening its disclosure. The underlying record stays intact. */
function Detail({ label, text, theme }: { label?: string; text: string; theme: PluginTimelineItemProps["theme"] }) {
  const [full, setFull] = useState(false);
  const limit = 50000;
  const shortened = !full && text.length > limit;
  return (
    <View style={{ gap: 5, marginBottom: 10 }}>
      {label ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text> : null}
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }}>
        {shortened ? text.slice(0, limit) : text}
      </Text>
      {shortened ? <Pressable accessibilityRole="button" onPress={() => setFull(true)}>
        <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Show full text ({text.length.toLocaleString()} characters)</Text>
      </Pressable> : null}
    </View>
  );
}

function RunCodeRow({ item, theme }: PluginTimelineItemProps<RunCodeData>) {
  const data = item.data;
  return <Disclosure title="Code" preview={data.description.split(/\r?\n/, 1)[0]}
    status={data.status} theme={theme}>
    {() => <>
      <Detail label="Code" text={data.code} theme={theme} />
      {data.output === undefined ? null : <Detail label="Output" text={data.output} theme={theme} />}
    </>}
  </Disclosure>;
}

function ReasoningRow({ item, theme }: PluginTimelineItemProps<ReasoningData>) {
  const data = item.data;
  return <Disclosure title="Thinking" preview={reasoningPreview(data.text, data.status)} status={data.status} theme={theme}>
    {() => <Detail text={data.text} theme={theme} />}
  </Disclosure>;
}

export function contributeWorkDisplay(client: PluginClientContext) {
  const removeCode = client.addTimelineRenderer({ kind: RUN_CODE_KIND, version: 1, schema: runCodeSchema, Component: RunCodeRow });
  const removeReasoning = client.addTimelineRenderer({ kind: REASONING_KIND, version: 1, schema: reasoningSchema, Component: ReasoningRow });
  return () => { removeReasoning(); removeCode(); };
}
