# Windows process compatibility

The provider and doctor support the official global npm installation of
`@deepseek-ai/dsh` on Windows. They find the npm launcher on the launch
environment's PATH (or the `DSH_BINARY` override), read that installation's
`package.json` bin entry, and invoke it with Node. Arguments remain an argv
array; no command shell is added. npm's adjacent `node.exe` takes precedence,
otherwise `node.exe` must be on PATH.

This keeps the DSH process itself attached to the existing stdin/stdout/stderr
pipes and termination logic. The session launch environment supplies PATH,
`DSH_BINARY`, and `DSH_PASEO_PROFILE`. macOS/Linux and native executable overrides
keep their existing command path. Custom Windows command wrappers that are not
the official npm installation are not interpreted as npm launchers.

## Why direct Node execution

Raw Node `spawn("dsh", ...)` cannot execute npm's Windows launchers.
`execFileSync("dsh.cmd", ...)` also fails with `EINVAL`.
See [Node's Windows launcher documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).

Paseo documents [spawnProcess and execCommand](https://paseo.sh/docs/plugins/providers#launch-the-provider-cli).
Their implementations and exports are present in the installed Paseo 0.15.4 SDK,
but absent from the project's locked `@getpaseo/plugin@0.9.2` server entry and
types. Direct Node execution avoids raising the SDK requirement, adding a
runtime dependency to the standalone doctor, or introducing a shell process
whose descendants need different termination handling.

On Windows, an unavailable Paseo CLI produces a doctor warning because the
desktop app can host this provider independently. This warning does not verify
the desktop version; check the app's version separately. Missing DSH still
fails. Unconfigured routing and credentials remain warnings; a successful
process launch does not establish that a model can answer.

## Maintain a fork without losing the fix

Paseo supports directory, Git, and npm plugin sources. A directory source points
at your checkout and reloads its files; it does not update from the original npm
package or registry listing. This is suitable for a maintained local fork.

Back up the daemon config and existing DSH profile first. If the same plugin ID
is already installed, remove that installation through Paseo before registering
the checkout under the same ID. Removing a directory source leaves its files.

```powershell
# Use the bundled CLI when it is available through PASEO_CLI.
& $env:PASEO_CLI plugin remove dsh-paseo
& $env:PASEO_CLI plugin install '<checkout>\paseo-plugin' --id dsh-paseo
& $env:PASEO_CLI plugin ls dsh-paseo --json
```

Keep the checkout on your fix branch. To update it:

```powershell
Set-Location '<checkout>'
git pull --ff-only origin fix/windows-launcher-doctor
npm --prefix paseo-plugin ci --ignore-scripts --no-audit --no-fund --replace-registry-host=always --registry=https://registry.npmjs.org/
npm --prefix paseo-plugin run typecheck
npm --prefix paseo-plugin run test:process
& $env:PASEO_CLI plugin reload dsh-paseo --json
```

The desktop Plugins screen also accepts the absolute plugin directory and
provides Reload. Keep this installation as a directory source.

A direct Git source can point at your fork and select a branch with `--ref`,
but that initial selector does not pin future default updates: Paseo offers the
remote's default HEAD. Use an explicit update ref or maintain the fix on that
default branch. A separate npm package requires publishing and another update
channel; neither is needed for a local checkout.

See the official [source and update documentation](https://paseo.sh/docs/plugins).

## Regression checks

Run `npm run test:process` inside `paseo-plugin` with Node 24 or newer (the tests
load the TypeScript process class using Node's built-in type stripping).
The tests use isolated npm fixtures and require no credentials or model calls.
They cover argv, cwd, session env, JSON-RPC and stderr streaming, cancellation,
forced stop and restart, nonzero exit codes, missing executables, doctor, and
the unchanged POSIX resolution path. CI runs them on Windows, Linux and macOS.

`npm run typecheck` checks the normal project configuration. The existing
`harness/plugin-check.cjs` additionally requires a working model route and
credentials for its response, token usage and streamed-answer assertions.
