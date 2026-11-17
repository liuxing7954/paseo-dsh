import { Component, type ComponentType, type ReactNode } from "react";
import { Text, View } from "react-native";

export type Cleanup = () => void;

/** Never let a diagnostic path throw the app over. */
export function report(label: string, error: unknown): void {
  try {
    console.error(`[dsh-paseo] ${label}`, error);
  } catch {
    // A host without a working console still has to keep running.
  }
}

/** Run a host-facing call; a throw becomes a logged no-op, not an app abort. */
export function guard<T>(label: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    report(label, error);
    return fallback;
  }
}

/** Start an async task and absorb both sync throws and rejections. */
export function guardAsync(label: string, run: () => Promise<unknown>): void {
  try {
    void run().catch((error: unknown) => {
      report(label, error);
    });
  } catch (error) {
    report(label, error);
  }
}

/**
 * Catches render failures in one plugin contribution.
 *
 * The host has no boundary around what a plugin draws: an uncaught render error
 * goes through RN's fatal handler, and a release build aborts — the whole app
 * disappears because one tool row could not render. Everything this plugin
 * hands to the host is wrapped here instead.
 */
class PluginBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    report("render", error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function withPluginBoundary<P extends object>(
  name: string,
  Inner: ComponentType<P>,
  fallback: (props: P) => ReactNode,
): ComponentType<P> {
  function Guarded(props: P) {
    return (
      <PluginBoundary fallback={fallback(props)}>
        <Inner {...props} />
      </PluginBoundary>
    );
  }
  Guarded.displayName = `Guarded(${name})`;
  return Guarded;
}

/** A one-line failure card, used where the contribution has no room for more. */
export function FailedRow({
  theme,
  message,
}: {
  theme: { colors: { statusDanger: string } };
  message: string;
}) {
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 }}>
        {message}
      </Text>
    </View>
  );
}

/**
 * Register one contribution. A host that refuses it (unknown icon, unresolvable
 * label, missing surface) loses that entry only; the rest of the plugin and the
 * app keep running. The returned cleanup is safe to call twice.
 */
export function guardCleanup(label: string, run: () => Cleanup): Cleanup {
  try {
    const cleanup = run();
    return () => {
      try {
        cleanup();
      } catch (error) {
        report(`${label} cleanup`, error);
      }
    };
  } catch (error) {
    report(label, error);
    return () => {};
  }
}
