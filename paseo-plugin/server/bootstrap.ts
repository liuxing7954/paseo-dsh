/**
 * Idempotent provisioning of the DSH `paseo` profile the plugin drives.
 *
 * Paseo installs plugins from npm or git and runs no install scripts, so a
 * plugin cannot rely on the repo's `install.sh`. Instead the plugin carries the
 * DSH bridge bundle (embedded by `scripts/generate-bridge-assets.mjs`) and
 * writes the whole profile on load: the profile files, the bridge itself under
 * `node_modules/`, and a starter model-route patch when the user has none.
 *
 * Re-running on every load is deliberate — updating the installed plugin is the
 * only step needed to update the bridge, because this rewrites it from the
 * plugin's own embedded copy.
 *
 * @module dsh-paseo/server/bootstrap
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_FILES, BRIDGE_PACKAGE_NAME, PROFILE_PATCH_TEMPLATE_BASE64 } from "./bridge-assets";

const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** The DSH profile name the bridge runs under. */
export function profileName(): string {
  return process.env.DSH_PASEO_PROFILE ?? "paseo";
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function profilePackageJson(profile: string): string {
  return `${JSON.stringify(
    {
      name: `dsh-profile-${profile}`,
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
    },
    null,
    2,
  )}\n`;
}

/** Write only when the bytes differ, so a load never churns file mtimes. */
function writeIfChanged(path: string, content: string | Uint8Array): boolean {
  try {
    if (existsSync(path) && readFileSync(path).equals(Buffer.from(content as never))) return false;
  } catch {
    /* unreadable or absent: fall through to write */
  }
  writeFileSync(path, content);
  return true;
}

export interface ProvisionResult {
  profile: string;
  dir: string;
  bridgeFiles: number;
  patchCreated: boolean;
}

/**
 * Ensure `$DSH_HOME/profiles/<profile>` exists and carries the bridge.
 *
 * Throws only on a real filesystem failure; callers treat provisioning as a
 * convenience and must not fail plugin load over it.
 */
export function ensurePaseoProfile(): ProvisionResult {
  const profile = profileName();
  const dir = join(dshHome(), "profiles", profile);
  mkdirSync(join(dir, "node_modules"), { recursive: true });

  writeIfChanged(join(dir, "package.json"), profilePackageJson(profile));
  writeIfChanged(join(dir, "cordis.yml"), CORDIS_YML);
  writeIfChanged(join(dir, "pnpm-workspace.yaml"), PNPM_WORKSPACE);

  // Replace whatever bridge is present — an older copy, or the symlink the
  // repo's install.sh creates — so the profile always matches this plugin build.
  const bridgeDir = join(dir, "node_modules", BRIDGE_PACKAGE_NAME);
  if (existsSync(bridgeDir)) rmSync(bridgeDir, { recursive: true, force: true });
  mkdirSync(bridgeDir, { recursive: true });
  for (const [relativePath, encoded] of Object.entries(BRIDGE_FILES)) {
    const target = join(bridgeDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(encoded, "base64"));
  }

  // The one file the user owns: never overwrite an existing model route.
  const patch = join(dir, "cordis.patch.yml");
  const patchCreated = !existsSync(patch);
  if (patchCreated) {
    writeFileSync(patch, Buffer.from(PROFILE_PATCH_TEMPLATE_BASE64, "base64"));
  }

  return { profile, dir, bridgeFiles: Object.keys(BRIDGE_FILES).length, patchCreated };
}
