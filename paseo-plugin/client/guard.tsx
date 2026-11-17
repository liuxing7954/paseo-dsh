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

/** Stack/module markers that identify a failure as coming from this plugin. */
const PLUGIN_MARKERS = /(dsh-paseo|paseo-dsh|dsh-plugins|guard\.tsx|i18n\.ts|icons\.tsx|timeline\.tsx)/i;

function isPluginError(error: unknown): boolean {
  try {
    const text = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    return PLUGIN_MARKERS.test(text);
  } catch {
    return false;
  }
}

/**
 * Last line of defence for failures the host raises while drawing a plugin
 * contribution — a sidebar row, a settings icon — which no boundary of ours can
 * catch. Those arrive here as fatal JS errors and abort the release app.
 *
 * Only errors whose message or stack names this plugin are swallowed; every
 * other fatal error still reaches the host's previous handler unchanged.
 */
export function installFatalGuard(): void {
  const errorUtils = (globalThis as {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  }).ErrorUtils;
  if (errorUtils === undefined) return;
  if (typeof errorUtils.getGlobalHandler !== "function"
    || typeof errorUtils.setGlobalHandler !== "function") {
    return;
  }
  const marker = "__dshPaseoFatalGuard";
  if ((globalThis as Record<string, unknown>)[marker] === true) return;
  (globalThis as Record<string, unknown>)[marker] = true;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal === true && isPluginError(error)) {
      report("fatal error swallowed", error);
      return;
    }
    previous(error, isFatal);
  });
}
