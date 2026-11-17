import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { imagePreviewRpc } from "./shared/image-preview";
import { languageSettings, timelineStyleSettings } from "./shared/settings";
import { ensurePaseoProfile } from "./server/bootstrap";
import { DshPlugins } from "./server/dsh-plugins";
import { registerDshPluginsRpc } from "./server/dsh-plugins-rpc";
import { createDshProvider } from "./server/provider";

/**
 * Register the DeepSeek Harness provider, provisioning the DSH profile it needs.
 *
 * Paseo's plugin installer runs no install scripts, so this plugin is
 * self-sufficient: on load it writes `$DSH_HOME/profiles/<name>` and the bridge
 * bundle it carries (see server/bootstrap.ts). Provisioning is best-effort —
 * a filesystem failure is logged and the provider still registers, so the
 * failure surfaces as an honest error when a session tries to start `dsh`.
 *
 * The DSH Plugins page is registered even when provisioning fails: it opens on
 * the profile path and shows the real error, instead of disappearing.
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const HARD_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

export default function contribute(server: PluginServerContext) {
  try {
    const provisioned = ensurePaseoProfile();
    process.stderr.write(
      `[dsh-paseo] DSH profile "${provisioned.profile}" ready at ${provisioned.dir}`
        + ` (${provisioned.bridgeFiles} bridge files${provisioned.patchCreated ? ", starter patch written" : ""})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[dsh-paseo] could not provision the DSH profile: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  server.registerSettings(timelineStyleSettings);
  server.registerSettings(languageSettings);
  server.handle(imagePreviewRpc, async (input) => {
    // The daemon answers with a code, never a sentence: the app picks the
    // language, and `errorDetail` carries the raw reason the operating system
    // gave so a real failure is still readable.
    const empty = {
      dataUri: null,
      mime: null,
      errorCode: null,
      errorDetail: null,
      bytes: null,
      limit: MAX_IMAGE_BYTES,
      tooLarge: false,
    } as const;
    const absolute = isAbsolute(input.path) ? input.path : resolve(input.cwd || process.cwd(), input.path);
    const mime = IMAGE_MIME[extname(absolute).toLowerCase()];
    if (mime === undefined) {
      return { ...empty, errorCode: "unsupported-format" as const };
    }
    try {
      const entry = await stat(absolute);
      if (!entry.isFile()) return { ...empty, mime, errorCode: "not-file" as const };
      if (entry.size > HARD_MAX_IMAGE_BYTES) {
        return { ...empty, mime, bytes: entry.size, errorCode: "too-large-hard" as const };
      }
      if (entry.size > MAX_IMAGE_BYTES && input.allowLarge !== true) {
        return {
          ...empty,
          mime,
          bytes: entry.size,
          tooLarge: true,
          errorCode: "too-large" as const,
        };
      }
      const bytes = await readFile(absolute);
      return {
        ...empty,
        dataUri: `data:${mime};base64,${bytes.toString("base64")}`,
        mime,
        bytes: bytes.byteLength,
      };
    } catch (error) {
      return {
        ...empty,
        mime,
        errorCode: "unreadable" as const,
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const manager = new DshPlugins();
  const disposePlugins = registerDshPluginsRpc(server, manager);
  server.registerProvider(createDshProvider());

  return () => {
    disposePlugins();
  };
}
