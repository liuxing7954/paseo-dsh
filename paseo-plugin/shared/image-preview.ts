import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Reads an image file so the timeline can draw it. The bytes never travel
 * through the provider timeline, so the daemon side loads the file and returns
 * a data URI (or the reason it cannot be shown).
 */
export const imagePreviewRpc = defineRpc({
  name: "file.image",
  input: z.object({
    cwd: z.string(),
    path: z.string(),
  }),
  output: z.object({
    dataUri: z.string().nullable(),
    mime: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
