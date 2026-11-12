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
import { useRpc } from "@getpaseo/plugin/client";
import {
  inspectSpecRpc,
  jobStatusRpc,
  listRpc,
  setEnabledRpc,
  startJobRpc,
  type BundleInfo,
  type InspectSpecOutput,
  type JobStatus,
  type PluginsSnapshot,
  type StartJobInput,
} from "../shared/dsh-plugins-api";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type Styles = ReturnType<typeof createStyles>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function jobTitle(job: JobStatus): string {
  const action = job.kind === "install"
    ? "安装"
    : job.kind === "remove"
      ? "卸载"
      : job.kind === "update"
        ? "更新"
        : "检查更新";
  if (job.state === "running") return `正在${action}…`;
  if (job.state === "failed") return `${action}失败`;
  return `${action}完成`;
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
        {bundle.official ? <Badge label="内置" styles={styles} /> : null}
        {bundle.protected ? <Badge label="受保护" styles={styles} /> : null}
        {bundle.client ? <Badge label="客户端界面" tone="warn" styles={styles} /> : null}
        {bundle.platformSupported ? null : <Badge label="当前平台不支持" tone="danger" styles={styles} />}
        {bundle.installed ? null : <Badge label="缺失" tone="danger" styles={styles} />}
        {bundle.update === undefined
          ? null
          : <Badge label={`可更新到 ${bundle.update}`} tone="warn" styles={styles} />}
      </View>

      {bundle.description === undefined || bundle.description === ""
        ? null
        : <Text style={styles.description}>{bundle.description}</Text>}

      {isDependency
        ? <Text style={styles.muted}>普通依赖，不是 DSH bundle，不会成为 profile 层。</Text>
        : null}
      {bundle.client
        ? <Text style={styles.muted}>界面只在 DSH Web/Desktop 显示。</Text>
        : null}
      {bundle.platformSupported || bundle.platformReason === undefined
        ? null
        : <Text style={styles.muted}>{bundle.platformReason}</Text>}

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
                label="确认卸载"
                disabled={rowBusy}
                onPress={() => onRemove(bundle.name)}
                styles={styles}
              />
              <ActionButton label="取消" disabled={rowBusy} onPress={() => onRemove("")} styles={styles} />
            </>
          ) : (
            <ActionButton
              label="卸载"
              disabled={rowBusy}
              onPress={() => onRemove(bundle.name)}
              styles={styles}
            />
          )
        ) : null}

        {bundle.update === undefined ? null : updatePending ? (
          <>
            <ActionButton
              label={`确认更新到 ${bundle.update}`}
              disabled={rowBusy}
              primary
              onPress={() => onUpdate(bundle.name, bundle.update as string)}
              styles={styles}
            />
            <ActionButton label="取消" disabled={rowBusy} onPress={() => onUpdate("", "")} styles={styles} />
          </>
        ) : (
          <ActionButton
            label={`更新到 ${bundle.update}`}
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
  const styles = useMemo(() => createStyles(theme.colors, compact), [theme.colors, compact]);

  const list = useRpc(listRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const inspectSpec = useRpc(inspectSpecRpc);
  const startJob = useRpc(startJobRpc);
  const jobStatus = useRpc(jobStatusRpc);

  const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
      setLoadError(null);
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
      setLoadError(messageOf(error));
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
        const message = messageOf(error);
        setActionError(message);
        setJob((current) => current === null
          ? current
          : { ...current, state: "failed", error: message, finishedAt: Date.now() });
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
      setActionError(messageOf(error));
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
      setActionError(messageOf(error));
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
      await setEnabled({ name: bundle.name, enabled: !bundle.enabled });
      await refresh();
    } catch (error) {
      setActionError(messageOf(error));
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
  const groups = [
    { title: "已启用", items: bundles.filter((bundle) => bundle.enabled && bundle.kind !== "dependency") },
    { title: "未启用", items: bundles.filter((bundle) => !bundle.enabled && bundle.kind !== "dependency") },
    { title: "普通依赖", items: bundles.filter((bundle) => bundle.kind === "dependency") },
  ].filter((group) => group.items.length > 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.muted}>
            {snapshot === null ? host.label : `${snapshot.profile} · ${host.label}`}
          </Text>
          {snapshot === null ? null : <Text style={styles.path}>{snapshot.displayDir}</Text>}
          <Text style={styles.notice}>改动只影响新建会话；正在运行的会话保持原样。</Text>
        </View>
        <View style={styles.headerActions}>
          <ActionButton
            label={refreshing ? "刷新中…" : "刷新"}
            disabled={refreshing}
            onPress={() => {
              void refresh();
            }}
            styles={styles}
          />
          <ActionButton
            label={job?.kind === "check" && job.state === "running" ? "检查中…" : "检查更新"}
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
          <Text style={styles.errorText}>{loadError}</Text>
          <ActionButton
            label="重试"
            onPress={() => {
              void refresh();
            }}
            styles={styles}
          />
        </View>
      )}

      {actionError === null ? null : (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{actionError}</Text>
        </View>
      )}

      {job === null ? null : (
        <View style={styles.statusCard}>
          <View style={styles.rowTop}>
            {job.state === "running" ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : null}
            <Text style={styles.name}>{jobTitle(job)}</Text>
            {job.state === "failed" ? <Badge label="失败" tone="danger" styles={styles} /> : null}
            {job.state === "succeeded" ? <Badge label="完成" tone="success" styles={styles} /> : null}
          </View>
          {job.error === undefined ? null : <Text style={styles.errorText}>{job.error}</Text>}
          {job.kind === "check" && job.updates !== undefined && Object.keys(job.updates).length > 0 ? (
            <Text style={styles.muted}>发现 {Object.keys(job.updates).length} 个可更新项。</Text>
          ) : null}
          {job.output === "" ? null : (
            <Text style={styles.output}>{tailLines(job.output, 12)}</Text>
          )}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.groupTitle}>安装 DSH 插件</Text>
        <Text style={styles.muted}>
          只接受 npm registry 包名。安装前会检查它是否声明 dsh.bundle。
        </Text>
        <TextInput
          value={spec}
          onChangeText={(value: string) => {
            setSpec(value);
            setInspection(null);
          }}
          placeholder="包名或包名@版本"
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={!busy && !inspecting && !(inspection?.ok === true)}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <View style={styles.rowActions}>
          <ActionButton
            label={inspecting ? "检查中…" : "检查"}
            disabled={busy || inspecting || spec.trim() === ""}
            onPress={() => {
              void inspect();
            }}
            styles={styles}
          />
          {inspection === null ? null : (
            <ActionButton
              label="取消"
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
              {inspection.name ?? "未知包"}
              {inspection.version === undefined ? "" : ` ${inspection.version}`}
            </Text>
            {inspection.description === undefined || inspection.description === ""
              ? null
              : <Text style={styles.description}>{inspection.description}</Text>}
            {inspection.client
              ? <Text style={styles.muted}>界面只在 DSH Web/Desktop 显示。</Text>
              : null}
            <Text style={styles.muted}>
              这是第三方代码，会在每个新会话的 DSH 进程里运行。只安装你信任的包。
            </Text>
            <View style={styles.rowActions}>
              <ActionButton
                label="确认安装"
                primary
                disabled={busy}
                onPress={() => {
                  void install();
                }}
                styles={styles}
              />
              <ActionButton
                label="取消"
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
            <Text style={styles.errorText}>{inspection.error ?? "无法安装这个包。"}</Text>
          </View>
        )}
      </View>

      {snapshot === null && loadError === null ? (
        <View style={styles.statusCard}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.muted}>正在读取 profile…</Text>
        </View>
      ) : null}

      {groups.map((group) => (
        <View key={group.title} style={styles.section}>
          <Text style={styles.groupTitle}>{group.title} · {group.items.length}</Text>
          {group.items.map((bundle) => (
            <BundleRow
              key={bundle.name}
              bundle={bundle}
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
