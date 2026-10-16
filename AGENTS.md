# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch:
   - [docs/SIM.md](docs/SIM.md) — battle engine API, hooks, test harness.
   - [docs/META.md](docs/META.md) — match flow, shop, protocol.
   - [docs/DATA.md](docs/DATA.md) — generated data.
   - [docs/I18N.md](docs/I18N.md) — interface strings.
   - [docs/PLUGINS.md](docs/PLUGINS.md) — the plugin system (manifest, permissions, script sandbox, studio).
   - [server/sim/content/kits/README.md](server/sim/content/kits/README.md) — operator kits.
4. [docs/README.md](docs/README.md) — the index of everything under `docs/` (which file answers which question).
   [docs/SYNC-POINTS.md](docs/SYNC-POINTS.md) — **read this before adding anything**: a `C2S` intent, a `behaviour`
   switch, a `pack.json` field, a `client.panels` slot, an i18n entry. It lists every place that has to change together,
   what fails **silently** if you miss one, and the test that catches it.
5. [docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md) — running the server-only distribution.
   [docs/UPSTREAM-PR-LEDGER.md](docs/UPSTREAM-PR-LEDGER.md) — what we sent upstream, and what came back.
   [docs/ENGINE-COMPAT-STARDUST-AUDIT.md](docs/ENGINE-COMPAT-STARDUST-AUDIT.md) — the Forge / Stardust compatibility
   audit.

## Hard rules

- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Section numbers.** `docs/DESIGN.md` is the index, and it is the only map from a section to its file. Our numbering
  runs two ahead of upstream from the inserted §28 / §29 on, so upstream `§N` is our `§(N+2)` — upstream §32 (the
  plugin system) is our §34, upstream §33 (official effects) is our §35. Cite a section by **our** number.
  `node --test test/docs-paths.test.js` guards this: every `DESIGN §N` cited anywhere must be a heading, and no
  heading number (`N` / `N.M` / `N.M.K`) may appear twice.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Plugins

A plugin (a self-contained feature pack, not a fork of this repository) has its own entry point:
[plugins/AGENTS.md](plugins/AGENTS.md). Read it before touching `plugins/`, `schemas/` or `tools/plugin.mjs` — it is
written around the working loop *schema → `check` → `pack`*. The reference behind it is
[docs/PLUGINS.md](docs/PLUGINS.md); people read [docs/PLUGIN-GUIDE.md](docs/PLUGIN-GUIDE.md).

A server's own plugins are not committed to this repository: `plugins/*` is git-ignored except this file, the readme and
the templates.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs)
npm run golden                              # golden results
```

`npm run ci` runs the steps of `.github/workflows/ci.yml` in order — `setup`, `test`, `smoke`, `lint`, `imports`,
`typecheck` — and stops at the first failure. `--keep-going` continues past a failure, `--only lint,test` runs the named
steps only, `--list` prints them. It does not run `npm ci`.

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.

Two scripts run outside `npm run ci`, because they need the network or produce an artifact:

- `node .github/pack-compat.mjs` — takes the packs **live on the workshop site** and feeds them to this repository's own
  validator. It answers one question: after the engine moves, do the packs players already have still install? The
  workflow `.github/workflows/pack-compat.yml` runs it when the tool itself changes, or on a manual dispatch. Exit code
  0 = no new incompatibility in our own packs, 1 = there is one, 2 = the catalogue could not be fetched (never green).
- `node tools/package-server.mjs` — builds the server-only distribution: the game runtime and the Mod API, without local
  game art and without bundled content packs. `--dry-run`, `--list`, `--out <directory>`; the guide is
  [docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md).

## Upstream baseline

`shared/constants.js` carries both halves, and a release tag spells them out as `v<APP_VERSION>-<UPSTREAM_VERSION>`:
`APP_VERSION` is this fork's release number, `UPSTREAM_VERSION` is the upstream game this checkout bundles. A release
that only follows upstream keeps `APP_VERSION` and moves `UPSTREAM_VERSION`. Read the two constants rather than a number
written in prose: `test/promptBaseline.test.js` checks the "current baseline" statements in `docs/prompts/*.md` and
`README.md` against them.
