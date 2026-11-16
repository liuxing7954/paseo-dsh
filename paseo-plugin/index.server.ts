import { readFile } from "node:fs/promises";
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
    const absolute = isAbsolute(input.path) ? input.path : resolve(input.cwd || process.cwd(), input.path);
    const mime = IMAGE_MIME[extname(absolute).toLowerCase()];
    if (mime === undefined) {
      return { dataUri: null, mime: null, error: "不支持的图片格式" };
    }
    try {
      const bytes = await readFile(absolute);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return { dataUri: null, mime, error: "图片过大（超过 12MB）" };
      }
      return { dataUri: `data:${mime};base64,${bytes.toString("base64")}`, mime, error: null };
    } catch (error) {
      return {
        dataUri: null,
        mime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  server.registerProvider(createDshProvider());
  return () => {};
}
