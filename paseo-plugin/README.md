# paseo-dsh

DeepSeek Harness (`dsh`) as a **native** Paseo provider — not ACP.

This npm package is the Paseo-side provider plugin. Install it through Paseo's
own plugin installer:

```bash
paseo plugin add npm:paseo-dsh
# or from a checkout:
paseo plugin add liuxing7954/paseo-dsh --path paseo-plugin
```

On load it provisions `$DSH_HOME/profiles/paseo` (the DSH profile it drives),
including the stdio bridge bundle it carries — no shell script, no manual
profile setup. The only thing left is your model route in
`~/.dsh/profiles/paseo/cordis.patch.yml`.

This package also ships a small CLI for that setup:

```bash
npx paseo-dsh doctor   # check CLIs, profile, bridge, model route and credentials
npx paseo-dsh probe --base-url https://your-gateway/v1 \
  --api-key-env YOUR_KEY_ENV --model your-model-id   # discover reasoning levels etc.
```

What you get that the ACP boundary can't carry:

- `ask_user_question` → real Paseo question cards
- Build / Plan mode, with the plan shown before approval
- Thinking effort rendered from each model's actually-declared levels
- Steer into the running turn
- Images admitted into DSH's attachment store, delivered per the route's modality
- A `/` menu with DSH's registered commands **and** user-invocable skills
- A **Permissions** select in the composer that switches DSH's sandbox preset
  (read-only / workspace-write / danger-full-access)
- A **Preset** select when the profile declares agent presets — DSH's
  persona+capability bundles, chosen at session start and locked once it begins

Full documentation, the adoption guide, and 18 real defects with their fixes
live in the main repository: **https://github.com/liuxing7954/paseo-dsh**

Requires Paseo ≥ 0.9.2 and the official `dsh` on the daemon's `PATH`.

## Versioning

`major.minor` tracks the DSH line this plugin targets — `0.2.x` of this plugin is
built against DSH `0.2.x`. The patch number is this plugin's own release count and
does not follow DSH. Install the line matching the `dsh` on your daemon.

MIT.
