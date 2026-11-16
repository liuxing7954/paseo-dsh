import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Reads an image file so the timeline can draw it. The bytes never travel
 * through the provider timeline, so the daemon side loads the file and returns
 * a data URI (or the reason it cannot be shown).
 *
 * Files above the soft limit are reported as `tooLarge` so the client can ask
 * the reader before paying the base64/WebSocket cost; `allowLarge` bypasses it
 * up to the daemon's hard ceiling.
 */
export const imagePreviewRpc = defineRpc({
  name: "file.image",
  input: z.object({
    cwd: z.string(),
    path: z.string(),
    allowLarge: z.boolean().optional(),
  }),
  output: z.object({
    dataUri: z.string().nullable(),
    mime: z.string().nullable(),
    error: z.string().nullable(),
    bytes: z.number().nullable(),
    limit: z.number().nullable(),
    tooLarge: z.boolean(),
  }),
});
