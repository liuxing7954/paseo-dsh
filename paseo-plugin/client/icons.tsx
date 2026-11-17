import type { PluginIconProps } from "@getpaseo/plugin/client";
import { View } from "react-native";

/**
 * Icons drawn with plain React Native views.
 *
 * A Lucide name has to exist in the host's pruned icon table, and an inline SVG
 * assumes the native app links `react-native-svg`. Either failure happens while
 * the host draws the sidebar row — outside every boundary this plugin can put
 * around its own components — and a release build aborts. Views cannot fail
 * that way.
 */
export function PluginsIcon({ size, color }: PluginIconProps) {
  const stroke = Math.max(1, size / 16);
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: size * 0.55,
          height: size * 0.55,
          borderWidth: stroke,
          borderColor: color,
          borderRadius: stroke * 1.5,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: size * 0.5,
          height: size * 0.5,
          borderWidth: stroke,
          borderColor: color,
          borderRadius: stroke * 1.5,
        }}
      />
    </View>
  );
}

/** Three sliders, for the timeline-style settings row. */
export function SlidersIcon({ size, color }: PluginIconProps) {
  const stroke = Math.max(1, size / 16);
  return (
    <View
      style={{
        width: size,
        height: size,
        justifyContent: "center",
        gap: Math.max(2, size * 0.16),
      }}
    >
      <View style={{ height: stroke, backgroundColor: color, width: "100%" }} />
      <View style={{ height: stroke, backgroundColor: color, width: "65%" }} />
      <View style={{ height: stroke, backgroundColor: color, width: "85%" }} />
    </View>
  );
}
