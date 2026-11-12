import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Wire contract between the DSH Plugins page and the plugin server.
 *
 * Kept in one file so the client and server cannot drift: both import these
 * schemas, and Paseo parses every input/output at the RPC boundary.
 */

export const jobKindSchema = z.enum(["install", "remove", "update", "check"]);
export const jobStateSchema = z.enum(["running", "succeeded", "failed"]);

export const bundleRowSchema = z.object({
  id: z.string(),
  module: z.string().optional(),
});

export const bundleInfoSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  kind: z.enum(["bundle", "dependency", "missing"]),
  protected: z.boolean(),
  official: z.boolean(),
  client: z.boolean(),
  platformSupported: z.boolean(),
  platformReason: z.string().optional(),
  removable: z.boolean(),
  updatable: z.boolean(),
  update: z.string().optional(),
  rows: z.array(bundleRowSchema),
});

export const pluginsSnapshotSchema = z.object({
  profile: z.string(),
  dir: z.string(),
  displayDir: z.string(),
  bundles: z.array(bundleInfoSchema),
  busy: z.boolean(),
  activeJobId: z.string().optional(),
  activeJobKind: jobKindSchema.optional(),
});

export const jobStatusSchema = z.object({
  id: z.string(),
  kind: jobKindSchema,
  state: jobStateSchema,
  output: z.string(),
  error: z.string().optional(),
  updates: z.record(z.string(), z.string()).optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
});

export const setEnabledInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

export const setEnabledOutputSchema = z.object({
  changed: z.boolean(),
  enabled: z.boolean(),
});

export const inspectSpecInputSchema = z.object({
  spec: z.string().min(1),
});

export const inspectSpecOutputSchema = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  client: z.boolean(),
  error: z.string().optional(),
});

export const startJobInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("install"), spec: z.string().min(1) }),
  z.object({ kind: z.literal("remove"), name: z.string().min(1) }),
  z.object({ kind: z.literal("update"), name: z.string().min(1), version: z.string().min(1) }),
  z.object({ kind: z.literal("check") }),
]);

export const startJobOutputSchema = z.object({
  id: z.string(),
});

export const jobIdInputSchema = z.object({
  id: z.string().min(1),
});

export type JobKind = z.infer<typeof jobKindSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type BundleRow = z.infer<typeof bundleRowSchema>;
export type BundleInfo = z.infer<typeof bundleInfoSchema>;
export type PluginsSnapshot = z.infer<typeof pluginsSnapshotSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type SetEnabledInput = z.infer<typeof setEnabledInputSchema>;
export type SetEnabledOutput = z.infer<typeof setEnabledOutputSchema>;
export type InspectSpecOutput = z.infer<typeof inspectSpecOutputSchema>;
export type StartJobInput = z.infer<typeof startJobInputSchema>;

export const listRpc = defineRpc({
  name: "dsh-plugins.list",
  input: z.object({}),
  output: pluginsSnapshotSchema,
});

export const setEnabledRpc = defineRpc({
  name: "dsh-plugins.set-enabled",
  input: setEnabledInputSchema,
  output: setEnabledOutputSchema,
});

export const inspectSpecRpc = defineRpc({
  name: "dsh-plugins.inspect",
  input: inspectSpecInputSchema,
  output: inspectSpecOutputSchema,
});

export const startJobRpc = defineRpc({
  name: "dsh-plugins.start-job",
  input: startJobInputSchema,
  output: startJobOutputSchema,
});

export const jobStatusRpc = defineRpc({
  name: "dsh-plugins.job",
  input: jobIdInputSchema,
  output: jobStatusSchema,
});
