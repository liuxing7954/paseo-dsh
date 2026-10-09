#!/usr/bin/env bash
#
# Install the DSH <-> Paseo bridge on this machine.
#
# What it does:
#   1. creates a DSH profile that serves the stdio bridge
#   2. links this checkout's bridge bundle into that profile
#   3. installs the Paseo provider plugin
#   4. enables plugins in Paseo's config and registers the plugin
#
# It never overwrites an existing model configuration: an existing
# `cordis.patch.yml` is left exactly as it is, and every config file it does
# touch is backed up first. Re-running it is safe.
#
# Usage:
#   ./install.sh [--profile NAME] [--repo PATH] [--check] [--yes]
#
#   --profile NAME   DSH profile to create (default: paseo)
#   --repo PATH      checkout to link from (default: this script's directory)
#   --check          verify prerequisites and report, change nothing
#   --yes, -y        skip the confirmation prompt (the security notice is still
#                    printed, so an AI agent can relay it and get consent first)
#
set -euo pipefail

PROFILE="paseo"
REPO=""
CHECK_ONLY=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --repo)    REPO="${2:?--repo needs a value}"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$REPO" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

say()  { printf '  %s\n' "$*"; }
head() { printf '\n== %s\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# Paseo ships its own CLI inside the app bundle, and a `paseo` on PATH is often a
# stale npm install. Prefer the bundled one.
find_paseo() {
  if [ -x /Applications/Paseo.app/Contents/Resources/bin/paseo ]; then
    echo /Applications/Paseo.app/Contents/Resources/bin/paseo
  elif command -v paseo >/dev/null 2>&1; then
    command -v paseo
  fi
}

head "checking prerequisites"
command -v dsh >/dev/null 2>&1 || die "the 'dsh' command was not found on PATH"
say "dsh         $(command -v dsh)"
command -v node >/dev/null 2>&1 || die "node was not found on PATH"
say "node        $(node --version)"
PASEO_BIN="$(find_paseo || true)"
[ -n "$PASEO_BIN" ] || die "the Paseo CLI was not found (looked in the app bundle and on PATH)"
say "paseo       $PASEO_BIN"
[ -d "$REPO/dsh-bridge" ] || die "$REPO/dsh-bridge is missing; pass --repo with the checkout path"
[ -d "$REPO/paseo-plugin" ] || die "$REPO/paseo-plugin is missing; pass --repo with the checkout path"
say "checkout    $REPO"

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '\nall prerequisites present (--check: nothing was changed)\n'
  exit 0
fi

cat <<'WARNING'

  ┌──────────────────────────────────────────────────────────────────────┐
  │  Plugins are trusted, unsandboxed code. Backend plugin code can      │
  │  access this machine, including files, processes, credentials, and   │
  │  network services. Only continue if you trust this checkout.         │
  └──────────────────────────────────────────────────────────────────────┘

WARNING
if [ "$ASSUME_YES" -eq 1 ]; then
  # An agent passed --yes, which means it should have shown the notice above
  # and obtained consent before invoking this script.
  printf 'Continuing (--yes).\n'
else
  printf 'Continue? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

head "creating the DSH profile at $PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
if [ -f "$PROFILE_DIR/package.json" ]; then
  say "package.json exists, leaving it alone"
else
  cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-paseo-bridge"
      ]
    }
  }
}
EOF
  say "wrote package.json"
fi

if [ -f "$PROFILE_DIR/cordis.yml" ]; then
  say "cordis.yml exists, leaving it alone"
else
  cat > "$PROFILE_DIR/cordis.yml" <<'EOF'
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
EOF
  say "wrote cordis.yml"
fi

if [ -f "$PROFILE_DIR/pnpm-workspace.yaml" ]; then
  say "pnpm-workspace.yaml exists, leaving it alone"
else
  cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF
  say "wrote pnpm-workspace.yaml"
fi

mkdir -p "$PROFILE_DIR/node_modules"
LINK="$PROFILE_DIR/node_modules/dsh-paseo-bridge"
ln -sfn "$REPO/dsh-bridge" "$LINK"
say "linked node_modules/dsh-paseo-bridge -> $REPO/dsh-bridge"

# The model route is the one part that differs per person, so an existing file
# is never touched. A fresh one gets a template with nothing configured.
if [ -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  say "cordis.patch.yml exists, leaving your model configuration alone"
else
  cp "$REPO/templates/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  say "wrote a cordis.patch.yml template — YOU MUST fill in your provider"
fi

head "installing the Paseo plugin"
"$PASEO_BIN" plugin install "$REPO/paseo-plugin" || die "plugin install failed (is the daemon running, and did it ask for a password?)"

head "updating $PASEO_HOME/config.json"
CONFIG="$PASEO_HOME/config.json"
[ -f "$CONFIG" ] || die "$CONFIG not found; start Paseo once so it writes a config, then re-run"
BACKUP="$CONFIG.bak-dsh-$(date +%Y%m%d%H%M%S)"
cp "$CONFIG" "$BACKUP"
say "backed up to $(basename "$BACKUP")"

node - "$CONFIG" "$REPO/paseo-plugin" <<'EOF'
const fs = require('fs');
const [configPath, pluginPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.pluginsEnabled = true;
config.plugins ??= {};
config.plugins['dsh-paseo'] = { source: 'directory', path: pluginPath };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log('  pluginsEnabled = true');
console.log('  plugins["dsh-paseo"] registered');
EOF

head "done"
cat <<EOF
  Next steps:

    1. Fill in your model route in:
         $PROFILE_DIR/cordis.patch.yml

       Not sure what your endpoint supports? Probe it first:
         node $REPO/tools/probe-provider.mjs \\
           --base-url <your endpoint>/v1 \\
           --api-key-env <YOUR_KEY_ENV_VAR> \\
           --model <your-model-id>

    2. Self-check the install:
         npx paseo-dsh doctor

    3. Restart the Paseo daemon so it loads the plugin and the new config.

    4. In Paseo, pick the "DeepSeek Harness (native)" provider.

  See docs/ADOPTION.md for the full walkthrough and the pitfalls to avoid.
EOF
