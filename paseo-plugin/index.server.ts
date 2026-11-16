import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { imagePreviewRpc } from "./shared/image-preview";
import { timelineStyleSettings } from "./shared/settings";
import { ensurePaseoProfile } from "./server/bootstrap";
import { createDshProvider } from "./server/provider";

/**
 * Register the DeepSeek Harness provider, provisioning the DSH profile it needs.
 *
 * Paseo's plugin installer runs no install scripts, so this plugin is
 * self-sufficient: on load it writes `$DSH_HOME/profiles/<name>` and the bridge
 * bundle it carries (see server/bootstrap.ts). Provisioning is best-effort —
 * a filesystem failure is logged and the provider still registers, so the
 * failure surfaces as an honest error when a session tries to start `dsh`.
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
  server.handle(imagePreviewRpc, async (input) => {
    const empty = { dataUri: null, mime: null, error: null, bytes: null, limit: MAX_IMAGE_BYTES, tooLarge: false };
    const absolute = isAbsolute(input.path) ? input.path : resolve(input.cwd || process.cwd(), input.path);
    const mime = IMAGE_MIME[extname(absolute).toLowerCase()];
    if (mime === undefined) {
      return { ...empty, error: "不支持的图片格式" };
    }
    try {
      const entry = await stat(absolute);
      if (!entry.isFile()) return { ...empty, mime, error: "不是文件" };
      if (entry.size > HARD_MAX_IMAGE_BYTES) {
        return { ...empty, mime, bytes: entry.size, error: "图片超过 64MB 硬上限，无法预览" };
      }
      if (entry.size > MAX_IMAGE_BYTES && input.allowLarge !== true) {
        return {
          ...empty,
          mime,
          bytes: entry.size,
          tooLarge: true,
          error: `图片较大（${(entry.size / 1024 / 1024).toFixed(1)}MB，超过 12MB 预览上限）`,
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
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  server.registerProvider(createDshProvider());
  return () => {};
}
