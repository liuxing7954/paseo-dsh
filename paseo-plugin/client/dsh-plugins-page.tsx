import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";
import {
  inspectSpecRpc,
  jobStatusRpc,
  listRpc,
  setEnabledRpc,
  startJobRpc,
  type BundleInfo,
  type FailureCode,
  type InspectSpecOutput,
  type JobStatus,
  type PluginsSnapshot,
  type StartJobInput,
} from "../shared/dsh-plugins-api";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type Styles = ReturnType<typeof createStyles>;

// The catalog is known at build time; helpers only pass keys from it.
type Translate = (key: string, args?: Record<string, unknown>) => string;

interface UiFailure {
  code: FailureCode;
  detail?: string;
}

const FAILURE_CODES = new Set<string>([
  "profile-unreadable",
  "profile-invalid",
  "invalid-platform",
  "lock-timeout",
  "invalid-name",
  "protected",
  "not-installed",
  "not-a-bundle",
  "invalid-spec",
  "registry-unreadable",
  "registry-invalid",
  "already-installed",
  "not-removable",
  "not-in-dependencies",
  "invalid-version",
  "check-failed",
  "disposed",
  "busy",
  "job-missing",
  "spawn-failed",
  "command-failed",
  "request-failed",
]);

function failureOf(error: unknown): UiFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: FAILURE_CODES.has(message) ? message as FailureCode : "request-failed",
    ...(message === "" ? {} : { detail: message }),
  };
}

const FAILURE_KEYS: Record<FailureCode, string> = {
  "profile-unreadable": "plugins.errors.profile-unreadable",
  "profile-invalid": "plugins.errors.profile-invalid",
  "invalid-platform": "plugins.errors.invalid-platform",
  "lock-timeout": "plugins.errors.lock-timeout",
  "invalid-name": "plugins.errors.invalid-name",
  "protected": "plugins.errors.protected",
  "not-installed": "plugins.errors.not-installed",
  "not-a-bundle": "plugins.errors.not-a-bundle",
  "invalid-spec": "plugins.errors.invalid-spec",
  "registry-unreadable": "plugins.errors.registry-unreadable",
  "registry-invalid": "plugins.errors.registry-invalid",
  "already-installed": "plugins.errors.already-installed",
  "not-removable": "plugins.errors.not-removable",
  "not-in-dependencies": "plugins.errors.not-in-dependencies",
  "invalid-version": "plugins.errors.invalid-version",
  "check-failed": "plugins.errors.check-failed",
  "disposed": "plugins.errors.disposed",
  "busy": "plugins.errors.busy",
  "job-missing": "plugins.errors.job-missing",
  "spawn-failed": "plugins.errors.spawn-failed",
  "command-failed": "plugins.errors.command-failed",
  "request-failed": "plugins.errors.request-failed",
};

function failureText(t: Translate, failure: UiFailure): string {
  const base = t(FAILURE_KEYS[failure.code]);
  if (
    failure.detail !== undefined
    && (failure.code === "command-failed"
      || failure.code === "check-failed"
      || failure.code === "invalid-platform"
      || failure.code === "request-failed")
  ) {
    return `${base}\n${failure.detail}`;
  }
  return base;
}

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function jobTitle(job: JobStatus, t: Translate): string {
  const action = job.kind === "install"
    ? t("plugins.job.installAction")
    : job.kind === "remove"
      ? t("plugins.job.removeAction")
      : job.kind === "update"
        ? t("plugins.job.updateAction")
        : t("plugins.job.checkAction");
  if (job.state === "running") return t("plugins.job.running", { action });
  if (job.state === "failed") return t("plugins.job.failed", { action });
  return t("plugins.job.succeeded", { action });
}

function createStyles(colors: ThemeColors, compact: boolean) {
  return {
    content: {
      padding: compact ? 16 : 24,
      paddingBottom: 40,
      gap: 16,
      width: "100%" as const,
      maxWidth: 880,
      alignSelf: "center" as const,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 12,
      flexWrap: "wrap" as const,
    },
    headerText: { flex: 1, minWidth: 180, gap: 4 },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    path: { color: colors.foregroundMuted, fontSize: 12 },
    notice: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    headerActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    section: { gap: 10 },
    groupTitle: {
      color: colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
    },
    card: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: compact ? 12 : 14,
      gap: 8,
    },
    rowTop: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    name: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
    version: { color: colors.foregroundMuted, fontSize: 12 },
    description: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    badgeRow: {
      flexDirection: "row" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    badge: {
      backgroundColor: colors.surface2,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeText: { color: colors.foregroundMuted, fontSize: 11 },
    badgeWarn: {
      backgroundColor: colors.surface2,
      borderColor: colors.statusWarning,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeWarnText: { color: colors.statusWarning, fontSize: 11 },
    badgeDanger: {
      backgroundColor: colors.surface2,
      borderColor: colors.statusDanger,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeDangerText: { color: colors.statusDanger, fontSize: 11 },
    badgeSuccess: {
      backgroundColor: colors.surface2,
      borderColor: colors.statusSuccess,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeSuccessText: { color: colors.statusSuccess, fontSize: 11 },
    rowActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    button: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.surface2,
    },
    buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: colors.foreground, fontSize: 12, fontWeight: "500" as const },
    buttonPrimaryText: {
      color: colors.accentForeground,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    input: {
      color: colors.foreground,
      backgroundColor: colors.surface2,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    },
    statusCard: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      gap: 8,
    },
    errorCard: {
      backgroundColor: colors.surface1,
      borderColor: colors.statusDanger,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      gap: 8,
    },
    errorText: { color: colors.statusDanger, fontSize: 13, lineHeight: 19 },
    output: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
    rowTags: {
      flexDirection: "row" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    tag: {
      backgroundColor: colors.surface2,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    tagText: { color: colors.foregroundMuted, fontSize: 10 },
    infoBox: {
      backgroundColor: colors.surface2,
      borderRadius: 8,
      padding: 10,
      gap: 6,
    },
  };
}

function ActionButton({
  label,
  onPress,
  disabled,
  primary,
  styles,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary === true ? styles.buttonPrimary : null,
        disabled === true ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, primary === true ? styles.buttonPrimaryText : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Badge({
  label,
  tone = "muted",
  styles,
}: {
  label: string;
  tone?: "muted" | "warn" | "danger" | "success";
  styles: Styles;
}) {
  const badgeStyle = tone === "warn"
    ? styles.badgeWarn
    : tone === "danger"
      ? styles.badgeDanger
      : tone === "success"
        ? styles.badgeSuccess
        : styles.badge;
  const textStyle = tone === "warn"
    ? styles.badgeWarnText
    : tone === "danger"
      ? styles.badgeDangerText
      : tone === "success"
        ? styles.badgeSuccessText
        : styles.badgeText;
  return (
    <View style={badgeStyle}>
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

function BundleRow({
  bundle,
  t,
  styles,
  busy,
  toggleBusy,
  confirmRemove,
  confirmUpdate,
  onToggle,
  onRemove,
  onUpdate,
}: {
  bundle: BundleInfo;
  t: Translate;
  styles: Styles;
  busy: boolean;
  toggleBusy: string | null;
  confirmRemove: string | null;
  confirmUpdate: { name: string; version: string } | null;
  onToggle: (bundle: BundleInfo) => void;
  onRemove: (name: string) => void;
  onUpdate: (name: string, version: string) => void;
}) {
  const isDependency = bundle.kind === "dependency";
  const canToggle = bundle.kind !== "dependency" && !bundle.protected;
  const removePending = confirmRemove === bundle.name;
  const updatePending = confirmUpdate?.name === bundle.name;
  const rowBusy = busy || toggleBusy === bundle.name;

  return (
    <View style={styles.card}>
      <View style={styles.rowTop}>
        <Text style={styles.name}>{bundle.name}</Text>
        {bundle.version === undefined ? null : <Text style={styles.version}>{bundle.version}</Text>}
        {bundle.official ? <Badge label={t("plugins.badges.official")} styles={styles} /> : null}
        {bundle.protected ? <Badge label={t("plugins.badges.protected")} styles={styles} /> : null}
        {bundle.client ? <Badge label={t("plugins.badges.client")} tone="warn" styles={styles} /> : null}
        {bundle.platformSupported ? null : <Badge label={t("plugins.badges.platformUnsupported")} tone="danger" styles={styles} />}
        {bundle.installed ? null : <Badge label={t("plugins.badges.missing")} tone="danger" styles={styles} />}
        {bundle.update === undefined
          ? null
          : <Badge label={t("plugins.badges.updateAvailable", { version: bundle.update })} tone="warn" styles={styles} />}
      </View>

      {bundle.description === undefined || bundle.description === ""
        ? null
        : <Text style={styles.description}>{bundle.description}</Text>}

      {isDependency
        ? <Text style={styles.muted}>{t("plugins.bundle.dependencyNote")}</Text>
        : null}
      {bundle.client
        ? <Text style={styles.muted}>{t("plugins.bundle.clientNote")}</Text>
        : null}
      {bundle.platformSupported || bundle.platformReason === undefined || bundle.platformReason === ""
        ? null
        : <Text style={styles.muted}>{t("plugins.bundle.platforms", { platforms: bundle.platformReason })}</Text>}

      {bundle.rows.length === 0 ? null : (
        <View style={styles.rowTags}>
          {bundle.rows.map((row) => (
            <View key={row.id} style={styles.tag}>
              <Text style={styles.tagText}>{row.id}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.rowActions}>
        {canToggle ? (
          <Switch
            value={bundle.enabled}
            disabled={rowBusy || (!bundle.enabled && (bundle.installed === false || !bundle.platformSupported))}
            onValueChange={() => onToggle(bundle)}
            trackColor={{ false: styles.button.backgroundColor, true: styles.buttonPrimary.backgroundColor }}
            thumbColor={styles.name.color}
          />
        ) : null}

        {bundle.removable ? (
          removePending ? (
            <>
              <ActionButton
                label={t("plugins.bundle.confirmRemove")}
                disabled={rowBusy}
                onPress={() => onRemove(bundle.name)}
                styles={styles}
              />
              <ActionButton label={t("plugins.bundle.cancel")} disabled={rowBusy} onPress={() => onRemove("")} styles={styles} />
            </>
          ) : (
            <ActionButton
              label={t("plugins.bundle.remove")}
              disabled={rowBusy}
              onPress={() => onRemove(bundle.name)}
              styles={styles}
            />
          )
        ) : null}

        {bundle.update === undefined ? null : updatePending ? (
          <>
            <ActionButton
              label={t("plugins.bundle.confirmUpdate", { version: bundle.update })}
              disabled={rowBusy}
              primary
              onPress={() => onUpdate(bundle.name, bundle.update as string)}
              styles={styles}
            />
            <ActionButton label={t("plugins.bundle.cancel")} disabled={rowBusy} onPress={() => onUpdate("", "")} styles={styles} />
          </>
        ) : (
          <ActionButton
            label={t("plugins.bundle.update", { version: bundle.update })}
            disabled={rowBusy}
            onPress={() => onUpdate(bundle.name, bundle.update as string)}
            styles={styles}
          />
        )}
      </View>
    </View>
  );
}

export function DshPluginsPage({ theme, host, layout }: PluginSurfaceProps) {
  const compact = layout.compact || layout.platform === "ios" || layout.platform === "android";
  const { t } = useTranslation(messages);
  const translate = t as unknown as Translate;
  const styles = useMemo(() => createStyles(theme.colors, compact), [theme.colors, compact]);

  const list = useRpc(listRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const inspectSpec = useRpc(inspectSpecRpc);
  const startJob = useRpc(startJobRpc);
  const jobStatus = useRpc(jobStatusRpc);

  const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<UiFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [actionError, setActionError] = useState<UiFailure | null>(null);
  const [spec, setSpec] = useState("");
  const [inspection, setInspection] = useState<InspectSpecOutput | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [toggleBusy, setToggleBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<{ name: string; version: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const next = await list({});
      setSnapshot(next);
      setLoadError(next.errorCode === undefined
        ? null
        : {
          code: next.errorCode,
          ...(next.errorDetail === undefined ? {} : { detail: next.errorDetail }),
        });
      setJob((current) => {
        if (next.activeJobId === undefined) return current;
        if (current !== null && current.id === next.activeJobId) return current;
        return {
          id: next.activeJobId,
          kind: next.activeJobKind ?? "install",
          state: "running",
          output: "",
          startedAt: Date.now(),
        };
      });
    } catch (error) {
      setLoadError(failureOf(error));
    } finally {
      setRefreshing(false);
    }
  }, [list]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (job === null || job.state !== "running") return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const next = await jobStatus({ id: job.id });
        if (cancelled) return;
        setJob(next);
        if (next.state !== "running") await refresh();
      } catch (error) {
        if (cancelled) return;
        const failure = failureOf(error);
        setActionError(failure);
        setJob((current) => current === null
          ? current
          : {
            ...current,
            state: "failed",
            errorCode: failure.code,
            errorDetail: failure.detail,
            finishedAt: Date.now(),
          });
      }
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, 1000);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [job?.id, job?.state, jobStatus, refresh]);

  useEffect(() => {
    if (job?.state === "succeeded" && job.kind === "install") {
      setSpec("");
      setInspection(null);
    }
  }, [job?.kind, job?.state]);

  const busy = job?.state === "running" || snapshot?.busy === true;

  const beginJob = useCallback(async (input: StartJobInput): Promise<boolean> => {
    setActionError(null);
    try {
      const started = await startJob(input);
      if (!started.ok || started.id === undefined) {
        setActionError({
          code: started.errorCode ?? "command-failed",
          ...(started.errorDetail === undefined ? {} : { detail: started.errorDetail }),
        });
        return false;
      }
      setJob({
        id: started.id,
        kind: input.kind,
        state: "running",
        output: "",
        startedAt: Date.now(),
      });
      setSnapshot((current) => current === null
        ? current
        : {
          ...current,
          busy: true,
          activeJobId: started.id,
          activeJobKind: input.kind,
        });
      return true;
    } catch (error) {
      setActionError(failureOf(error));
      return false;
    }
  }, [startJob]);

  const inspect = async (): Promise<void> => {
    const value = spec.trim();
    if (value === "") return;
    setInspecting(true);
    setActionError(null);
    setInspection(null);
    try {
      setInspection(await inspectSpec({ spec: value }));
    } catch (error) {
      setActionError(failureOf(error));
    } finally {
      setInspecting(false);
    }
  };

  const install = async (): Promise<void> => {
    if (inspection === null || !inspection.ok) return;
    const started = await beginJob({ kind: "install", spec: spec.trim() });
    if (started) setInspection(null);
  };

  const toggle = async (bundle: BundleInfo): Promise<void> => {
    setToggleBusy(bundle.name);
    setActionError(null);
    try {
      const result = await setEnabled({ name: bundle.name, enabled: !bundle.enabled });
      if (!result.ok) {
        setActionError({
          code: result.errorCode ?? "command-failed",
          ...(result.errorDetail === undefined ? {} : { detail: result.errorDetail }),
        });
        return;
      }
      await refresh();
    } catch (error) {
      setActionError(failureOf(error));
    } finally {
      setToggleBusy(null);
    }
  };

  const remove = async (name: string): Promise<void> => {
    if (name === "") {
      setConfirmRemove(null);
      return;
    }
    if (confirmRemove !== name) {
      setConfirmRemove(name);
      return;
    }
    setConfirmRemove(null);
    await beginJob({ kind: "remove", name });
  };

  const update = async (name: string, version: string): Promise<void> => {
    if (name === "" || version === "") {
      setConfirmUpdate(null);
      return;
    }
    if (confirmUpdate?.name !== name || confirmUpdate.version !== version) {
      setConfirmUpdate({ name, version });
      return;
    }
    setConfirmUpdate(null);
    await beginJob({ kind: "update", name, version });
  };

  const bundles = snapshot?.bundles ?? [];
  const groups = ([
    { title: "plugins.groups.enabled", items: bundles.filter((bundle) => bundle.enabled && bundle.kind !== "dependency") },
    { title: "plugins.groups.disabled", items: bundles.filter((bundle) => !bundle.enabled && bundle.kind !== "dependency") },
    { title: "plugins.groups.dependencies", items: bundles.filter((bundle) => bundle.kind === "dependency") },
  ] as Array<{
    title: "plugins.groups.enabled" | "plugins.groups.disabled" | "plugins.groups.dependencies";
    items: BundleInfo[];
  }>).filter((group) => group.items.length > 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.muted}>
            {snapshot === null
              ? host.label
              : t("plugins.header.profile", { profile: snapshot.profile, host: host.label })}
          </Text>
          {snapshot === null ? null : <Text style={styles.path}>{snapshot.displayDir}</Text>}
          <Text style={styles.notice}>{t("plugins.header.notice")}</Text>
        </View>
        <View style={styles.headerActions}>
          <ActionButton
            label={refreshing ? t("plugins.header.refreshing") : t("plugins.header.refresh")}
            disabled={refreshing}
            onPress={() => {
              void refresh();
            }}
            styles={styles}
          />
          <ActionButton
            label={job?.kind === "check" && job.state === "running"
              ? t("plugins.header.checkingUpdates")
              : t("plugins.header.checkUpdates")}
            disabled={busy}
            onPress={() => {
              void beginJob({ kind: "check" });
            }}
            styles={styles}
          />
        </View>
      </View>

      {loadError === null ? null : (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{failureText(translate, loadError)}</Text>
          <ActionButton
            label={t("plugins.header.retry")}
            onPress={() => {
              void refresh();
            }}
            styles={styles}
          />
        </View>
      )}

      {actionError === null ? null : (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{failureText(translate, actionError)}</Text>
        </View>
      )}

      {job === null ? null : (
        <View style={styles.statusCard}>
          <View style={styles.rowTop}>
            {job.state === "running" ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : null}
            <Text style={styles.name}>{jobTitle(job, translate)}</Text>
            {job.state === "failed" ? <Badge label={t("plugins.job.failedBadge")} tone="danger" styles={styles} /> : null}
            {job.state === "succeeded" ? <Badge label={t("plugins.job.doneBadge")} tone="success" styles={styles} /> : null}
          </View>
          {job.errorCode === undefined
            ? null
            : (
              <Text style={styles.errorText}>
                {failureText(translate, {
                  code: job.errorCode,
                  ...(job.errorDetail === undefined ? {} : { detail: job.errorDetail }),
                })}
              </Text>
            )}
          {job.kind === "check" && job.updates !== undefined && Object.keys(job.updates).length > 0 ? (
            <Text style={styles.muted}>
              {t("plugins.job.updatesFound", { count: Object.keys(job.updates).length })}
            </Text>
          ) : null}
          {job.output === "" ? null : (
            <Text style={styles.output}>{tailLines(job.output, 12)}</Text>
          )}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.groupTitle}>{t("plugins.install.title")}</Text>
        <Text style={styles.muted}>{t("plugins.install.hint")}</Text>
        <TextInput
          value={spec}
          onChangeText={(value: string) => {
            setSpec(value);
            setInspection(null);
          }}
          placeholder={t("plugins.install.placeholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={!busy && !inspecting && !(inspection?.ok === true)}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <View style={styles.rowActions}>
          <ActionButton
            label={inspecting ? t("plugins.install.checking") : t("plugins.install.check")}
            disabled={busy || inspecting || spec.trim() === ""}
            onPress={() => {
              void inspect();
            }}
            styles={styles}
          />
          {inspection === null ? null : (
            <ActionButton
              label={t("plugins.bundle.cancel")}
              disabled={busy || inspecting}
              onPress={() => {
                setInspection(null);
              }}
              styles={styles}
            />
          )}
        </View>

        {inspection === null ? null : inspection.ok ? (
          <View style={styles.infoBox}>
            <Text style={styles.name}>
              {inspection.name ?? t("plugins.install.unknown")}
              {inspection.version === undefined ? "" : ` ${inspection.version}`}
            </Text>
            {inspection.description === undefined || inspection.description === ""
              ? null
              : <Text style={styles.description}>{inspection.description}</Text>}
            {inspection.client
              ? <Text style={styles.muted}>{t("plugins.bundle.clientNote")}</Text>
              : null}
            <Text style={styles.muted}>{t("plugins.install.trust")}</Text>
            <View style={styles.rowActions}>
              <ActionButton
                label={t("plugins.install.confirm")}
                primary
                disabled={busy}
                onPress={() => {
                  void install();
                }}
                styles={styles}
              />
              <ActionButton
                label={t("plugins.bundle.cancel")}
                disabled={busy}
                onPress={() => {
                  setInspection(null);
                }}
                styles={styles}
              />
            </View>
          </View>
        ) : (
          <View style={styles.infoBox}>
            <Text style={styles.errorText}>
              {inspection.errorCode === "not-a-bundle"
                ? t("plugins.install.notBundle")
                : failureText(translate, {
                  code: inspection.errorCode ?? "command-failed",
                  ...(inspection.errorDetail === undefined ? {} : { detail: inspection.errorDetail }),
                })}
            </Text>
          </View>
        )}
      </View>

      {snapshot === null && loadError === null ? (
        <View style={styles.statusCard}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.muted}>{t("plugins.status.loadingProfile")}</Text>
        </View>
      ) : null}

      {groups.map((group) => (
        <View key={group.title} style={styles.section}>
          <Text style={styles.groupTitle}>
            {t(group.title as "plugins.groups.enabled")} · {group.items.length}
          </Text>
          {group.items.map((bundle) => (
            <BundleRow
              key={bundle.name}
              bundle={bundle}
              t={translate}
              styles={styles}
              busy={busy}
              toggleBusy={toggleBusy}
              confirmRemove={confirmRemove}
              confirmUpdate={confirmUpdate}
              onToggle={(item) => {
                void toggle(item);
              }}
              onRemove={(name) => {
                void remove(name);
              }}
              onUpdate={(name, version) => {
                void update(name, version);
              }}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
