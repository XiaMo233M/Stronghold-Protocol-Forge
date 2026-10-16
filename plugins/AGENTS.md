# plugins/AGENTS.md — making a plugin with an AI agent

For AI coding assistants asked to make or fix a plugin of 卫戍协议：盟约. Do not learn the rules from long prose: let the
schema and the checker tell you, and loop until they are quiet.

The reference is [docs/PLUGINS.md](../docs/PLUGINS.md) — §3 manifest, §4 permissions, §5 files, §9 cosmetic plugins,
§15 studio and tools. People read [docs/PLUGIN-GUIDE.md](../docs/PLUGIN-GUIDE.md).

## The loop

1. **Start from a template** — never from a blank file:

   ```bash
   node tools/plugin.mjs new <art|spine|voice|audio|numbers|operator|dsl|meta|mode|ui|script> <id> --target <official name or id> --name "<name>"
   ```

   `node tools/plugin.mjs new` lists the templates. The default `dsl` template contains one compact caster and one prep
   income file; `/studio/` edits its DSL through structured controls. The id is the folder name:
   `^[a-z0-9][a-z0-9-]{1,31}$`.
2. **Write against the schema.** `plugins/<id>/plugin.json` starts with `"$schema": "../../schemas/plugin.schema.json"`.
   The asset overlay (`"assets"`) is `schemas/overlay.schema.json`. A manifest the schema accepts is one the checker
   finds clean, except for three things only the checker can see: what needs the folder (files that exist, and their
   types), the running game's version, and a few cross-field rules.
3. **Check, read the codes, fix, repeat.** Run `node tools/plugin.mjs check <id> --json`. It answers:

   ```jsonc
   { "folders": [{ "issues": [{ "level": 1, "code": "…", "at": "…", "file": "…", "params": {}, "message": "…", "fix": "…", "doc": "…", "autofix": "…" }] }], "problems": 0, "warnings": 0 }
   ```

   `code` is stable (the catalogue is `shared/plugins/errors.js`). `at` is the path in plugin.json. `fix` says what to
   do. `autofix` names the studio's one-click fix. Stop when `problems` and `warnings` are 0 (`--strict` makes warnings
   fail too).
4. **Pack.** `node tools/plugin.mjs pack <id> --zip` writes `plugin.lock.json` (file hashes, plus each Spine model's
   clips parsed from the skeleton) and `plugins/_dist/<id>-<version>.zip`. Pack again after any change to a skeleton.

## Rules the checker enforces (so you can plan, not guess)

- A cosmetic plugin carries `assets` (and `theme`, not applied yet). Permissions: `assets.override` to change an entry
  the installation has, `assets.add` for a new one. Every part needs its permission, and every declared permission must
  be used.
- Values are paths **inside the folder** — `art/a.png`. No `..`, no leading `/`, no URL, no hidden part. A value must
  match the field's kind:
  - images: `.png .jpg .webp` (no SVG)
  - audio: `.mp3 .ogg`
  - Spine: `{ "skel": "m/t.skel" }`, with `m/t.atlas` beside it and its pages in `m/`
  - or a reference `{ "ref": "<key>" }` to the installation's own entry of the same container.
- Never write a Spine model's `animations`, `events`, `hits`, `bounds` or `anims` by hand (`"anims": "auto"` at most):
  `pack` reads them. Never hand-edit `plugin.lock.json`.
- Never put files of the official game into a plugin. The tools do not screen for them; it is the author's
  responsibility. Use references to borrow the installation's art.
- Keys you do not know are found by name: `GET /studio/api/targets?q=德克萨斯` on a running server (local network only;
  a read needs no key), or the template's `--target`.

## The studio's API (when a server runs)

The browser studio at `/studio/` uses an HTTP API you can use too. It works on this machine and the local network only.
Every change needs the header `X-SP-Studio: <key>`, where the key is the content of `plugins/.studio-key`; a wrong or
missing key answers 403 `PLUGIN_STUDIO_KEY`.

Through it you can: create a plugin, put files on a slot (base64), set references, apply one-click fixes, pack, download
the zip, and read the preview composition. The table is in docs/PLUGINS.md §15. Every answer of a change is the plugin's
state with `check.issues` — the same coded issues as `check --json`.

## Do not

- Do not invent fields or permissions. Unknown fields are warnings; unknown permissions are problems.
- Do not copy plugin folders across with links. A link inside a plugin folder keeps it out, and a plugin folder that is
  itself a link is never opened by the studio.
- Do not commit a server's plugins to this repository. `plugins/*` is git-ignored, except this file, the readme and the
  templates.

## Script plugins

Start from `plugins/_template/script/`, copied to `plugins/script-demo/`. Rename every script_demo record namespace with
the folder id.

Entry modules export a synchronous `setup(sp)` and may import only `sp:sdk@1`. The SDK is experimental. Use the
documented helpers, listed in [docs/PLUGINS.md §13](../docs/PLUGINS.md#13-scripts-p3), plus SIM §5–7 for hooks and kits
and META §2 for prep handlers. Declare `sim.code` / `meta.code` for the APIs used, and `overrides` for any official kit
replaced.

Keep state per battle. Use the seeded `battle.rng`, deterministic `sp.math` and battle timers. Do not claim portability
scanning is a sandbox.

Run `check <id> --strict`, `pack <id>` and `test <id>`. The last command executes the author's tests locally, with the
plugin's composed data. Never hand-edit the lock.

Native production execution additionally needs the owner mode, an exact lock pin and all players' consent; public
listeners refuse it by default. Sandbox mode uses verified locks and SES, without native fallback (docs/PLUGINS.md §13).
Callback budgets cannot interrupt an infinite loop; the browser Worker and the server child watchdogs terminate stalled
gameplay simulations. Native trusted page code can still block its page. No official game art belongs in the template.

## Gameplay authoring self-check

Use `new numbers`, `new operator --target <official name>`, `new dsl`, `new meta` or `new mode`. These are the same
modules as the browser wizard. `new ui` wraps the UI template; `new script` wraps the SDK template including its harness
test. `--options <json-file>` supplies wizard options.

Do not copy official game art. Operator `art.ref` borrows an installed entry, and compact operator expansion creates
both the normal and the elite ID in the plugin namespace.

The loop is **schema → check --strict → trial / `tools/plugin.mjs test` → pack**. Validate the manifest and records with
`schemas/plugin.schema.json` and `records.schema.json`; validate DSL with `dsl.schema.json` plus the actual
`validateDsl`.

The studio's `POST /studio/api/trial` (key required) returns `{ok, vanilla, plugin, comparison}` or
`{ok:false, issues}`. Its checker and content builder are the real ones: never suppress a `PLUGIN_*` error to make a
preview work. Compare identical seeds twice. Inspect actual damage, events and content errors. Test prep effects in a
room as well — the battle bench does not dispatch match prep hooks. Script tests run local author code; production trust
gates still apply.

DSL records use `kit: { dsl: … }` and permission `dsl`. Prep specs are files in the manifest's `dsl`. Both compose
through C1; a rejected spec must not be replaced with a generic kit.

The studio refuses a save over an external edit (`PLUGIN_STUDIO_CHANGED`); reload instead of overwriting the editor's
work.

DSL and prep templates must pass the entire strict-check → pack → content-set path. A trial is a single battle, so
verify prep effects through a match round. Invalid generated DSL is refused before files are written. Numeric patches are
checked against the shared official bounds. Script source reads need the studio key. Trial execution follows the owner's
sandbox or trusted mode, on locked bytes, without elevation.

## Import, install and API reference

Use `import-forge <dir|zip> --dry-run --json` to inspect a Forge conversion before writing it. The importer never runs
pack scripts. Kits whose imports map to `sp:sdk@1` are carried into one script plugin `kits-<id>` (`--no-scripts` leaves
it out). That plugin runs only with `SP_PLUGIN_SCRIPTS` and a room that selects it. A record whose skill is one official
operator's name takes that operator's kit. Inspect `IMPORT-REPORT.md`, and implement unsupported effects with the
documented DSL/SDK.

`install <zip|https URL>` checks an archive before installing; HTTPS needs `--sha256`. `--force` moves the old plugin to
`_replaced/`. `catalog <file|https URL> --json` inspects a community list; the studio has the same catalogue install.
Neither importing nor installing authorizes script execution.

Use [docs/PLUGIN-API.md](../docs/PLUGIN-API.md) for stable and experimental names, and `surface` to inspect the generated
table. Use `errors` for the coded explanations. Release bundles include the CLI, the schemas and
`test/helpers/battleHarness.js`; the full development test suite stays in source.

Production sandbox mode (`SP_PLUGIN_SCRIPTS=sandbox`) requires valid locked bytes, and accepts no trusted pin or
per-player consent; it allows public listeners. Native trusted modes require review, pinning and consent. Public or
wildcard listeners, and public reverse proxies, require `trusted-force`.
