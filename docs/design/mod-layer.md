# DESIGN §27 — The mod layer: identity, loading, isolation, versioning, distribution

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

This section is the design for the middle layer between "content a pack can add" and "code a pack can run". It is the
first part of DESIGN that describes something the repository does **not** implement yet: the behaviour layer exists and
works (§27.1), but identity, load-order arbitration, verification, versioning and the client surface do not. Nothing
here is implemented by the commit that adds this file; §27.10 lists what is deliberately left out.

Every `file:line` below was read at the revision this section was written against (`main` `1283050`, `APP_VERSION`
`0.9.4`, `shared/constants.js:9`). A line number is a **snapshot, not a contract** — where a sentence is load-bearing it
also names the symbol, because §27.5 is precisely about what happens when a line number rots (it has happened three
times in this repository already, once in the header of the module that teaches authors to write hooks).

## 27. Mod layer: A content, B server logic, C client UI

### 27.1 The ruling, and what is already there

The owner's ruling of 2026-10-09 fixes three layers:

| layer | what it is | who executes it | when it may change a battle result |
|---|---|---|---|
| **A** content | declarative data, no code: the workshop pack of today (`shared/workshop.js:609` `applyWorkshop`) | nobody — it is merged into the data every consumer reads (`server/data.js:92`) | always, and never detectably by the golden corpus (the corpus is generated from the official `data/*.json`, `test/golden/README.md:8-10`) |
| **B** server logic | hooks and kits: the code of `workshop/<pack>/kits/<chessId>.js` (`server/workshop.js:148` `loadWorkshopKits`) | **the server only** — this is new | only through the hooks it registers, and only after a declared intent passes deterministic verification |
| **C** client UI | rendering, themes, panels | the player's tab | never |

Two sentences in the repository already fix the constraints this design must satisfy at once, and they are currently
written as if they conflicted:

- `docs/PACKS.md:131-139` — "the maintainers' study of mods, 2026-10-07": server-side only for gameplay; a content hash
  in the handshake (`welcome`, `/healthz`, the BattleSpec) before data packs ship; **no third-party code** ("a pack type
  that runs code is a separate decision of the owner's"); golden stays on the original content.
- `docs/WORKSHOP.md:371` — the behaviour layer **is** an owner decision, taken later: "scripts run in the client
  (default `SP_COMBAT=client`), and `SP_VERIFY` can only recompute the result, not stop the script".

The ruling resolves them: **B runs on the server, so the `docs/PACKS.md:137-138` objection no longer applies** (the
owner has now taken that separate decision), and the `docs/WORKSHOP.md:371` warning stops being a permanent hazard
because a room containing a B pack is no longer simulated in the player's tab (§27.4). The three-channel distribution
(`docs/WORKSHOP.md:371`) stays.

What already exists, and must not be rebuilt: the two event buses (`server/sim/battle/hooks.js:17` `on`, `:57` `emit`;
`server/match/effectsMeta.js:48-52` the 19 meta hooks), the kit injection point `Battle opts.kits`
(`server/sim/content/index.js:112-114`), the pack loader and its file-system discipline
(`server/workshop.js:26-96`), the static kit checks (`shared/kitAuthoring.js:182` `validateKit`), and the 8-layer
author-side validator (`tools/workshop-validate.mjs:11-14`). The middle layer is the **seam** between them: who a pack
is, who wins when two of them want the same id, and what has to be true before its code is allowed to run.

### 27.2 Identity (gap 1)

Today a pack has an `id` (the directory name, `shared/workshop.js:193-195`) and free-text metadata
(`shared/workshop.js:392-398`), and the BattleSpec carries only `SPEC_VERSION = 1` (`server/sim/spec.js:33`, written at
`:55`) plus a list of kit **URLs** (`server/sim/spec.js:79-81`; produced by `server/workshop.js:201`). There is nowhere
in the wire, in the data or in the match for "which content is this room running".

**The tuple.** One record, one shape, one place:

```js
{ id: 'abyss', hash: '<64 lowercase hex>', api: '>=1 <2', layer: 'B', combat: true }
```

`hash` is the sha256 of the pack's **content manifest**, `api` is the declared API range (§27.5), `layer` is the
artifact kind, `combat` is the declared intent ("this pack can change a battle result"). A room's identity is the
**digest** of its sorted list: `sha256` of the canonical JSON of `[{id, hash}, …]` sorted by `id`. That single string is
what `welcome`, `/healthz`, the BattleSpec and a bug report all quote, so four different places cannot disagree.

**What participates in the hash.** Not "the directory": a manifest of `(relative path, byte length, sha256)` pairs,
sorted by path, over exactly the bytes the loader reads and the browser will be served:

1. `pack.json` — hashed **after** `normalizePackManifest` (`shared/workshop.js:190`), so the hash covers the pack's
   effective declaration (normalized `overrides`, `content`, icon tables, `art`, `support`, `voices`), not its
   whitespace. Two spellings of the same pack then hash the same, and a declaration the loader silently dropped
   (`shared/workshop.js:202-204` filters a malformed `overrides` entry in silence today) cannot hide behind the hash.
2. every declared content file, after `normalizeContentFile` — the same normalized records the loader merges.
3. every `kits/*.js` **source text, byte for byte** (the module the server imports and the browser fetches by URL,
   `server/workshop.js:182`, `public/js/battle/runner.js:136`).
4. every file under `<pack>/assets/**` — the media the `/workshop-assets` route serves
   (`server/http/workshop.js:75-105`).

What deliberately does **not** participate: the mtime "version" that currently versions kit URLs
(`server/workshop.js:192` — a version credential that is not a content hash, and the reason `docs/WORKSHOP.md:369`
records content addressing as unimplemented), the pack directory's absolute path, and any engine code. The last one
matters and is the answer for the third file the ruling names:

- **`shared/loadoutRecord.js` gets no new field, and that is a ruling, not an omission.** That module derives the
  record a unit actually fights with from `data/chess.json` plus the player's picks — `resolveRecordLoadout` (`:18`),
  `composeStats` (`:37`), `composeTalents` (`:48`), `loadoutRecord` (`:79`). If the pack hash covered *derived* records,
  every engine change would change every pack's hash and no pack could prove it was the same pack as yesterday. So: the
  hash covers a pack's own bytes; the **engine** half of the identity is `api` (§27.5). One consequence has to be
  designed for rather than discovered later: a loadout pick is validated against the **merged** data
  (`shared/protocol.js:133` `checkLoadout`, `:164` `resolveLoadout`), and an id that exists on the server can be an
  unknown id in a client that has a different pack set — where `lookup` returns `null` (`server/data.js:144-147`) and
  nothing throws. **Identity must therefore be established at the handshake, before any loadout is exchanged**, and the
  client must refuse to resolve a loadout at all until it has the server's digest.

**Where each piece goes.**

- `shared/protocol.js` — the *shape* and the validators, next to the other record shapes it already owns
  (`LOADOUT_LIMITS` `:73`, `isLoadoutEntries` `:79`, `OWNERSHIP_LIMITS` `:186`, `DIY_LIMITS` `:220`): a `MOD_LIMITS`
  constant, `isModEntry` / `isModList` (id charset, 64 hex digits, a range string this build can read, `layer ∈ A|B|C`,
  a boolean `combat`), and `modDigest(list)` (pure, no `node:crypto`: it hashes a JSON string, so the browser can
  recompute the *digest of a list* even though it cannot recompute a pack's sha256). The file is excluded from the
  typecheck slice (`jsconfig.json:26`) and is the normative wire contract (`docs/design/network.md:5`), which is where a
  wire shape belongs.
- `shared/protocol.js` `C2S` (`:320`) — `room.join` (`:325`) gains an optional `mods: <digest>`; `room.create`
  (`:324`) gains nothing. Optional on purpose: the 0.2.2 port shows that a **required** new field on an existing message
  is a hard break (`b.progress.resolved`), while optional fields are compatible (`room.loadout.ops`). Here the optional
  field does the work the version gate cannot: an old client simply does not send `mods`, and the server answers a
  modded room with a **clear refusal** instead of letting it in silently. `PROTOCOL_VERSION` (`shared/constants.js:5`,
  pinned to `1` by `test/version.test.js:24`) does not move.
- `shared/protocol.js` `S2C` (`:402-414`) — the list the client displays as the "modded" mark. It is delivered through
  `welcome`, which the lobby already extends per-server without touching the protocol module
  (`server/net.js:666-667` builds it from `handler.welcomeInfo()`), so the client knows the server's mod set the moment
  it connects, not when it joins a room. `/healthz` (`server/http/routes.js:24`) carries the same digest, which is what
  `docs/PACKS.md:135-136` asks for and what a bug report needs.
- `server/sim/spec.js` — the per-battle identity, because the spec is the only object both execution paths already
  share (the server-run field and the client authority both go through `buildBattleSpec`, `server/sim/spec.js:51`):
  `workshopKits` (`:79-81`) gains `hash` per module, and the spec gains a top-level `mods: { digest, packs: [...] }`.
  This is not bookkeeping: `validateClientResult` (`server/match/fields.js:748`) derives every bound it enforces from
  the spec (`specBounds` `:630`), so a result produced under a different mod set is today checked against the wrong
  bounds — the first thing a mod breaks, and the reason the spec must carry the identity.
- `server/workshop.js` — the *computation*: sha256 lives here (or in a small helper next to it) because it needs
  `node:crypto`, which the shared layer may not import; the runtime already hashes file bytes with it
  (`server/update.js:64`, `server/http/static.js:104`). It is computed **once at load**, from the files really on disk,
  in the same pass that reads them (`server/index.js:88-90` loads once per process; `docs/PACKS.md:125-126` fixes the
  reason: a battle must run the same data in the server and every browser). Computing it from the files rather than
  from the manifest is also the answer to `tools/package.mjs:13-14`: an untracked file is not shipped, and a hash taken
  from the manifest would happily describe a file that no player has.

### 27.3 Loading (gap 2): one rule for "who wins", and attribution that names the pack

**Decided by the owner on 2026-10-09, and implemented** (the four points below are the ruling verbatim in substance; the
first step of the slice carries them, `docs/WORKSHOP.md` §1.2 states them for authors):

| collision | the rule | where it is enforced |
|---|---|---|
| a new id claimed by two packs — a data record | **refused, and the report names the pack that holds it** | `shared/workshop.js:636-645` (`PACK_ID_COLLISION`, `definedBy`) |
| a new kit id claimed by two packs | **refused, and the report names the pack that holds it** | `server/workshop.js:169-174` (`KIT_ID_COLLISION`, `definedBy`) |
| an icon / item icon / art entry claimed by two packs | **the smaller pack id wins**; the loser is reported and named | `shared/workshop.js:855`, `:926`, `:1055` |
| `overrides` declares the replacement of an OFFICIAL id | **allowed, and the declaration is what makes it allowed** | `shared/workshop.js:14-16`, `:636-645` |
| anything, between two packs | **the smaller pack id wins — on every face** | one comparator: `shared/workshop.js:508` `byPackId` |

Two rules, not three, and they are the only two:

1. **An official record is never replaced without a declaration.** Not negotiable: silently redefining a shipped
   operator would corrupt every match on the server (`shared/workshop.js:14-16`).
2. **Between two packs, the smaller pack id wins, for every kind of contribution** — data, kit, icon, item icon, art.
   Equal ids cannot occur: the manifest must equal the directory name (`shared/workshop.js:195` `PACK_ID_MISMATCH`).
   A collision the loser cannot win is *reported and attributed* rather than silently resolved, which is why the data
   and kit faces "refuse" while the icon faces "keep the first": both are the same rule, seen from the side that lost.

Rule 2 needed one comparator, not five implementations. It used to be five: `applyWorkshop` trusted the **array order**
it was handed, the icon and art paths each re-sorted with their own inline compare, and the kit loader used yet another
one — they agreed only because the production loader sorts directory names (`server/workshop.js:33-36`) and the manifest
rule forces `id === directory`. `byPackId` (`shared/workshop.js:508`) is now exported and used by every face, including
the kit loader (`server/workshop.js:159`), so the winner is a property of the pack ids and not of who called the merge.
The two in-memory callers that can pass any order — the tests, and the editor — no longer decide anything by accident.

**Attribution.** Every collision error carries `{ pack, code, file, id, definedBy, reason }`, where `definedBy` is the
pack id that holds the record, or the string `official`. The text says the same thing:

- official: `"<id>" already exists in the official data — add "<file>:<id>" to pack.json overrides to replace it` (`OFFICIAL_ID_COLLISION`)
- against another pack: `"<id>" is already contributed by pack "<X>" — two packs must not ship the same <file>.json id;
  rename this record, or add "<file>:<id>" to pack.json overrides to replace that pack's record on purpose` (`PACK_ID_COLLISION`)
- kit: `kit "<id>" is already defined by pack "<X>"` (`KIT_ID_COLLISION`, `server/workshop.js:169-174`)
- icon / art: `another pack (<X>) already ships …` (`ASSET_COLLISION`, with `definedBy` as well)

Why it matters enough to be a section: the data path used to say "**official** data" for both cases, because the
variable holding "official + every pack merged so far" was called `official` (it is `prior` at
`shared/workshop.js:630` now). The author's next move was to open `data/chess.json` and look for a record that is not
there. Both defects — the wrong attribution and the unnamed kit holder — are fixed in the first step of the slice.

**Cross-pack conflicts are reported once, at load, in one shape.** The report used to be split across three carriers
with three shapes: the overlay's `report.errors` (logged by `server/data.js:95`), the icon and art collisions on that
same array, and `loadWorkshopKits`' own `errors` (`server/workshop.js:207`) — no single line an author could grep. Every
one of them now carries a `code`, and the four `MANIFEST_MISSING` cases (`data/assets.json` or `data/support.json` not
produced by the asset pipeline) are distinguishable from a collision without reading prose. The ordering contract is
documented for authors in `docs/WORKSHOP.md` §1.2 and summarized in the §1.7 status table, because a rule an author
cannot read is a rule an author cannot follow.


### 27.4 Isolation (gap 3)

**Server authority.** The behaviour layer runs in the player's browser by default today (`server/match/Match.js:107`, `:202-203`),
and `docs/WORKSHOP.md:371` records the consequence honestly. Under the ruling, a room whose mod set contains any
`layer: B` pack runs with `clientCombat = false` for **that room**: the decision moves from the process-level
`SP_COMBAT` environment variable to the room's mod set (`server/match/Match.js:262` is where the flag is resolved). Player tabs then
never execute pack code, and the `docs/PACKS.md:137-138` objection is answered rather than waived. Layer A keeps
client-side combat: its data is merged on both sides by construction (`server/http/static.js:100-110` serves the merged
JSON the client reads), so it is deterministic for the same reason the official content is.

**`SP_VERIFY` defaulting to `off` is handled, not ignored.** `server/match/Match.js:204-208` parses `SP_VERIFY`, `:263` resolves it,
and the default is `off`; the input inventory is right that this makes a client/server disagreement invisible by
default. The design answers with two changes that do not require the operator to remember an environment variable:
(a) a room whose mod set declares `combat: true` runs server-authoritative **and** with `verify = 'all'` for that room
(the path already exists: `server/match/match/reports.js:113` `_verifyResult` re-runs the field, `:120` compares
`resultDigest`); (b) a room with no mod set is untouched. The cost is real and is stated rather than hidden: the server
now runs those fields itself, sliced by the existing wall-clock budget (`server/match/Match.js:265`, default 8 ms per callback).
That is the price of the guarantee, and it is why `combat: false` packs matter: they keep the cheap path.

**No file system, no network.** `KIT_IMPORT` is already an error (`shared/kitAuthoring.js:216-218`) and the environment
globals are already scanned for (`shared/kitAuthoring.js:61-74`, checked at `:220-224`) — but as **warnings**
(`:223` `KIT_NONDETERMINISTIC`). Under server-only execution a `Date.now()` is no longer excusable as "both sides ran
it"; it is a direct threat to the recomputation the match depends on. Design: **`KIT_NONDETERMINISTIC` becomes an
error for a `layer: B` pack**, and the refusal names the construct and the source line it was found on (the static scan
already knows both, `shared/kitAuthoring.js:182` `validateKit`).

**Depth, and the guard that currently hides a broken battle.** `MAX_HOOK_DEPTH = 32`
(`server/sim/constants.js:215`); at the limit the bus skips **every** nested handler including the engine's own
`kill` / `death` bookkeeping (`server/sim/battle/hooks.js:62-64`), so the battle keeps running with state that is wrong
while the result is still accepted. Two decisions:

- **The guard itself does not change.** It sits on the deterministic path and its skip semantics are what the golden
  corpus was built against; changing it would move digests for reasons that have nothing to do with mods.
- **The consequence changes.** `_handlerError` already receives the owning unit or handle (`server/sim/battle/hooks.js:167`) and records
  `who` (`:169`), so the information needed to tell "a pack's handler nested too deep" from "the engine did" is already
  in hand and is currently thrown away into a deduplicated string. A depth trip attributable to a pack must mark that
  field's result untrusted and hand it to the server's own run (`server/match/match/reports.js:113-127`) instead of
  accepting it. That is the same shape as the existing suspicion path for engine errors
  (`server/sim/battle/hooks.js:176-184`), applied per owner.

**`battle.errors` is full at 100 and the rest is lost.** `server/sim/battle/hooks.js:170-172` deduplicates by `label|who|message` and
`:173` stops at 100 entries; a battle spammed by a mod therefore silently loses every error after the first hundred,
and they are only reachable through `m.simErrorLog` (`server/match/Match.js:127-129`) or `tools/matchrun.mjs --errors`. The cap is
right (it is a memory and wire budget) so the design keeps it and adds what the cap omits: **per-owner counters** —
`battle.errorCounts` keyed by owner label, unbounded in keys but bounded in memory, so the *summary* is complete even
when the detail log is truncated. The counters are what reaches the author (§27.7).

**Time budget.** There is no timeout that can interrupt a handler: a tick is one synchronous call
(`server/sim/battle/lifecycle.js:61`), so a loop in a pack hangs a battle in the browser and, for a server-run field,
a scheduler callback. The design does not pretend to add preemption (that is a runtime change, not a middle-layer one).
What it does is make the budget visible and enforceable at load: a pack's verification run (§27.6) measures the wall
clock of the fixed scenario list with and without the pack, and a `combat: false` pack whose cost exceeds a declared
budget is refused. On the client side, layer C is the only place a mod touches rendering, and B never reaches a tab
(§27.4 first paragraph) — so the "no budget in the browser" hole is closed by removing browser execution rather than by
inventing a timer.

### 27.5 Versioning (gap 4)

`gameVersion` is metadata and nothing reads it (`docs/WORKSHOP.md:369` records version alignment, dependency
declaration and content addressing as unimplemented), while the editor writes the string `'0.2.1'` in ten places
(`editor/server.mjs:1759` and nine siblings, `tools/workshop-scaffold.mjs:82`, `editor/ui/pack.js:90`). Two problems,
one shape.

**Declare two ranges, and reuse the machinery that already exists.** `shared/packs.js` already implements exactly what
this needs for its own pack type: `isVersionRange` (`:111`) reads `>=0.2.0`, `0.2.x`, `^0.2.0`, `~0.2.1`, `*` and
`||`; `appVersionMatches` (`:123`) evaluates a range against an app version; and the header (`:20-21`) already states
the intended policy — *outside the range the pack still loads, what it lacks falls back, and it is flagged
`compatible: false`*. The mod layer declares:

- `api` — the **mod-layer API** range, compared against a new constant in `shared/constants.js` next to `APP_VERSION`
  (`:9`): the version of the hook bus and the kit contract. This is the half that covers engine code, and it is the
  reason a pack's hash does not have to (§27.2).
- `game` — the **upstream game version** range, compared against the value `pack.json.gameVersion` means today. The port
  already needs that number to exist as a constant (today the upstream half "lives only in release tags, docs and
  `pack.json`"), so this is a field the middle layer spends rather than invents.
- `gameVersion` stays readable for one release, mapping to `game` when `game` is absent, so no existing pack breaks and
  the ten editor call sites can migrate one at a time.

**Three tiers, decided by what the difference can do.** This is the part the owner asked to have spelled out:

| verdict | when | what happens |
|---|---|---|
| **refuse** | a `layer: B` pack whose `api` range excludes this build | not loaded at all; the reason names the declared range and the installed API. A hook written against a different bus cannot be shown to be safe, and running it is exactly "a declaration without verification". |
| **degrade** | a `layer: A` pack whose `game` range excludes the installed game version | load only the records that still pass the existing per-record validators — the same functions `tools/workshop-validate.mjs` already runs as layers 2–8 (`:482`, `:511`, `:551`, `:578`, `:592`, `:609`) — report every dropped record by id, and mark the pack `compatible: false` in the sense `shared/packs.js:167-168` already uses. |
| **warn** | anything else: no declared range, or a range that includes this build | load normally; flag the absence of a declaration in the boot report. |

**Citations that rot, and the guard that checks the claim.** This is not hypothetical: three instances of it turned up
while writing this section.

1. `shared/kitAuthoring.js`'s header taught authors where the hook bus lives by citing two line numbers of
   `server/sim/Battle.js` (583 and 623), long after `on`/`emit` had moved into `server/sim/battle/hooks.js` (`:17`,
   `:57`) — the cited file no longer declares either method, and the second number is past its end. **Fixed**, with the
   pattern `HOOK_EVENTS` already uses: a symbol (`HOOK_BUS`, `shared/kitAuthoring.js:46`) plus a drift guard that reads
   the source and requires the symbols to still be declared there (`test/kitAuthoring.test.js`).
2. `docs/WORKSHOP.md` §4.3 carried the same stale citation. **Fixed**, and the guard above now covers that file too.
3. `docs/prompts/kit.md` cites `server/sim/Battle.js:113` for "`battle.flags` is a construction-time input" in three
   places, while `this.flags` is assigned at `server/sim/Battle.js:124` and line 113 is a statement about `this.rect`.
   The citation guard (`test/promptCitations.test.js`) could not see it: it verified only that the cited line exists and
   is not blank. **Deliberately not fixed here**: the drift is a consequence of the in-flight 0.2.2 port moving every
   server-side line number, so the fix belongs to that port rather than to a second branch editing the same file (owner's
   coordination of 2026-10-09). The upgraded guard below therefore **reports these three today**, each with the line the
   member really lives on, and turns green by itself when the port changes `:113` to `:124` — no test has to be touched
   for that. A fourth instance of the same defect, `docs/prompts/kit.md:460`, has no dotted member next to it and is not
   judged by the narrow rule below; it needs the same one-line fix and is recorded here so it is not lost.

**The rule now enforced, and its deliberate narrowness.** A `path:line` citation in `docs/prompts/*.md` is judged when
the sentence next to it names a **member of an engine-context object** — a dotted reference whose root is one of
`battle` / `this` / `flags` / `bb` / `ctx`, close enough to the citation to belong to the same claim (45 characters, 90
for `flags`, cut at a table cell / sentence / line boundary). At least one such member must occur on the cited line (or
anywhere in a cited range). Measured on the current tree: 10 of 181 citations in `docs/prompts/kit.md` are judged, and
the rule flags exactly the three stale ones — nothing else, on any of the three prompts. Bare identifiers are **not**
judged — a citation next to `inRect` or `hit` is usually naming a call site or a concept, not a declaration, and a
single false positive is what gets such a guard switched off. The coverage limit is the price of the zero-false-positive
requirement, and it is the right trade while the 0.2.2 port is about to move every server-side line number at once:
this class of citation fails in bulk, silently, and only the reader who clicks finds out.

Two things this section records about the guard's own blast radius, because both happened while writing it: the 0.2.2
port is not the only thing that moves line numbers — **any** edit to a cited file does, and the citations into
`shared/workshop.js` and `docs/WORKSHOP.md` that the first slice's edits broke were caught by the *existing* "line
exists and is not blank" guard (`docs/prompts/README.md:252` was the one that fired). The cheap discipline that
follows: after touching a file that any document cites, run the citation sweep, and prefer naming a symbol over a line
number whenever the sentence can carry the symbol.

### 27.6 Deterministic verification (the enforcement mechanism)

The golden corpus cannot be the check, and saying why is the design: it is generated from the official `data/*.json`
(`test/golden/README.md:8-10`), it deliberately ignores exactly the things a pack adds, and "a new engine hook, event or
chess record does not change the digests of the existing scenarios by itself" (`test/golden/README.md:58`). Running the
official corpus with a pack loaded and comparing against the stored digests would fail for every content pack, by
design.

So verification is a **differential run over the corpus's own scenario generators**:

| the pack declares | the check | it fails when |
|---|---|---|
| `combat: false` (a performance / refactor mod) | run the fixed scenario list twice in one process — once with the pack's kit map injected (`Battle opts.kits`, `server/sim/content/index.js:112-114`), once without — and require `resultDigest` (`server/sim/spec.js:308-328`) equality per scenario | the pack changes any observable outcome. **This is the enforcement of "a performance mod must be semantically preserving".** |
| `combat: true` | run the fixed scenario list twice with the pack loaded and require digest equality (the `--twice` idea, `test/golden/README.md:44`), plus the two execution paths the ruling keeps (server headless vs. the browser's module list, `public/js/battle/runner.js:127-145`) | the pack is non-deterministic, or the two paths disagree. |

Both forms reuse what exists: `tools/golden.mjs` builds the scenarios in a fixed order from `data/*.json` and reduces
each to a digest, and the per-game-second chained snapshot hash inside a digest already says **when** two runs parted
("the first differing value says when two runs parted", `test/golden/README.md:49-50`). To answer the owner's "say
which battle and which tick", the harness records the first differing **tick** as well — the corpus computes per-tick
state; it simply does not store it today. The refusal reads:

```
pack "abyss": roster/chess_char_3_18_a diverged from vanilla at game s 42.3 (tick 1269): perPlayer.P2.coins 12 → 13
```

**Who runs it — one code path, three callers.**

1. **The author**, through `tools/workshop-validate.mjs` as a ninth layer beside the eight documented at `:11-14`
   (`kits` is layer 4, `:511-524`), returning the same `{ field, code, severity, message, hint }` shape the editor and
   an AI self-correction loop already consume.
2. **The server at load** (`server/index.js:88-90`), which must **refuse** a pack whose verification fails *before*
   `applyWorkshop` merges anything (`server/data.js:92`). "Verification fails → the pack is not loaded" is the owner's
   wording, and load time is the only moment where refusing is still cheap.
3. **CI**, over the repository's own fixtures (`docs/examples/kit-demo`, `docs/examples/demo-workshop`) — CI has no
   third-party packs, so this is a regression check on the harness, not a review of anyone's mod.

**Cost is a decision, not an accident.** The full corpus is 151 battles / ≈20 s with four threads
(`test/golden/README.md:40`); a per-pack check runs a fixed list of about six scenarios (two roster, two fields, one
bond, one match), prints the list it used, and runs both arms in one process. A pack that is expensive to verify is a
pack whose author will run the verifier less often, which is the failure mode to design against, not the cost.

### 27.7 Author debugging (gap 5)

The inventory's conclusion is that failure is silent by default, and the middle layer multiplies it. One design response
per row:

| silent failure today | the design's answer |
|---|---|
| a hook name nothing emits never fires and nothing reports it (`server/sim/battle/hooks.js:17-25`, `:57-59`) | the static check already suggests a near miss (`HOOK_UNKNOWN_EVENT`, `shared/kitAuthoring.js:235-237`), but it is text analysis. Add a **runtime** report: `on` keeps the registration in `this._hooks[name]` (`server/sim/battle/hooks.js:20`), so at `battleEnd` the bus can name every pack-owned hook that was registered and never emitted. A typo then costs one battle instead of one bug report. |
| non-determinism is a warning (`shared/kitAuthoring.js:220-224`) | an error for layer B (§27.4), and the refusal quotes the construct *and* its source line, so it stops being "a reason that looks nothing like 'you used Math.random'" (`shared/kitAuthoring.js:13-17`). |
| a kit that returns no `skill` leaves the operator with no skill (`docs/WORKSHOP.md:528`) | the loader knows both facts — a kit was injected *and* `skillSource` says where the skill came from (`server/sim/content/index.js:214`, `:219`). A pack kit with no skill becomes a validation error the editor shows before saving, not a live surprise. |
| a `chess.assets.spine` that points at an uninstalled model draws a flat portrait and logs nothing (`shared/workshop.js:689-705`) | already solved by `report.looks` (logged at `server/data.js:97`) — generalise it: every field that degrades silently gets a `looks`-style check, and the editor surface must show it, not only the server log. |
| the editor deliberately does not import author files (`editor/server.mjs:2827-2855`) | **do not change this.** An HTTP endpoint that executes author code is a code-execution surface. Instead expose the verifier of §27.6 as an explicit action that runs in the **playtest subprocess** (`server/index.js:71-75` `SP_WORKSHOP`), which is already a separate process. |
| runtime errors land in a 100-entry array reachable only through `m.simErrorLog` (`server/match/Match.js:127-129`, `server/sim/battle/hooks.js:167-185`) | per-owner counters (§27.4), plus the room's mod digest on every error line, so a player's bug report carries the identity of the content it came from. |

### 27.8 Layer C and the client: a minimal registration point

The client has no plugin surface: `public/js/main.js:74` is a frozen `SCREENS` object, `:311` resolves a route as
`SCREENS[route] || LobbyScreen`, and the routes themselves come from `selectRoute` (`public/js/store.js:99-106`). What
it does have is the pattern this design copies: **hosts mounted once at the root** — `UiHosts` (`public/js/main.js:317`,
`public/js/ui/components.js:866`), `GuideHost` (`:318`, `public/js/ui/guide.js:106`), `LoadoutHost`, `SupportHost`.

The minimal registration point (design only, not implemented):

- one module, `public/js/ui/extensions.js`, exporting `registerPanel({ id, pack, slot, order, mount })` where `slot` is
  a **closed enum** of mount points that already exist as hosts (`root.overlays`, `root.guide`, `screen.game.aside`,
  `screen.result.footer`), and `registerTheme({ id, pack, vars })` writing CSS custom properties.
- the registry is filled **only** from the server's data — the same way kit modules are (`spec.workshopKits` →
  `public/js/battle/runner.js:127-145`): a same-origin, root-relative module URL, never a directory scan
  (`server/http/workshop.js:49-64` already refuses to serve anything the loader did not register, and `.js`/`.html` are
  excluded from the asset route, `server/http/workshop.js:71-81`).
- **the boundary is enforced by what is not passed in.** A C extension gets no store handle, no match state, no battle
  object; it cannot send a `b.*` message (those are sent by the field authority, `server/match/match/reports.js:18`,
  `:46`, and validated by `validateClientResult`, `server/match/fields.js:748`). A C module can therefore be wrong in
  the rendering sense and cannot be wrong in the result sense — which is the whole content of "does not change battle
  results".
- a C module is part of its pack's hash like any other file, and the pack is marked in the UI like any other (§27.9).

### 27.9 Distribution (the 5th gap)

Two channels, already decided (`docs/WORKSHOP.md:371`): the official bundle stays clean (`docs/PACKS.md:133-134`,
`:139`), workshop content ships separately through the existing zip path (`shared/zip.js`,
`tools/workshop-pack.mjs`). What is missing is the player-visible half of `docs/PACKS.md:135-136`, and it is four
surfaces quoting one string:

1. `welcome` (from the lobby's `welcomeInfo()`, `server/net.js:666-667`) — what the server is running;
2. `/healthz` (`server/http/routes.js:24`) — the same digest for a bug report and for the client's build guard;
3. the BattleSpec (`server/sim/spec.js:79-81`) — what *this field* ran with;
4. the room/lobby UI — the "modded" mark, and the refusal when a client cannot confirm the digest (`room.join.mods`,
   §27.2).

Two vocabulary decisions belong here because they are cheap now and expensive later:

- A **workshop pack** (`workshop/<id>/`, `shared/workshop.js`) and a **content pack** (`packs/<id>/`,
  `shared/packs.js:55-62` `PACK_TYPES`) are different things that currently share the word "pack" in two documents that
  read as if they disagree. The mod layer calls its own artifact a **mod** in player-facing text, and leaves "content
  pack" to the `packs/` registry.
- A pack set is fixed for the process (`server/index.js:88-90`, `docs/PACKS.md:125-126`), so the digest can only change
  at a restart. That makes the room list the right place to show it, and makes "the server told me X and then ran Y"
  impossible.

Finally, `tools/package.mjs:13-14` and `:156-157` (the `git ls-files` allowlist) mean a mod-layer file that is not
committed does not ship. A hash computed from the manifest could describe content no player has; a hash computed from
the files really on disk (or, in a release, from the files really in the archive) cannot. That is the reason §27.2
computes from bytes.

### 27.10 What this section does not decide

- **No sandbox for layer B.** The ruling is "the server executes it", not "untrusted code executes safely". A pack with
  a `while(true)` is refused by the load-time budget check (§27.4), not contained.
- **No hot reload.** The pack set is fixed for the process; a digest that can change mid-match is worse than a restart.
- **No code signing, no author identity.** `pack.json`'s `author` stays metadata (`shared/workshop.js:392-398`); the
  hash proves *which* bytes, not *whose*.
- **No WASM kernel decision.** That is the performance benchmark's call, and it is a different layer: a faster kernel is
  a `combat: false` change and would be verified by §27.6 like any other.
- **The section number is contended.** `test/docs-paths.test.js:96-113` requires every `## N.` block to live exactly
  once and to run without gaps (no duplicate, no hole). The in-flight upstream 0.2.2 port claims §27 for its own
  revision section, and it also rewrites the same index table row area in `docs/DESIGN.md`. Whichever lands second
  renumbers; if the port lands first, this section becomes §28 and its subsections renumber with it. Its index row is
  appended at the bottom of that table for exactly this reason.
- **Nothing here is implemented yet.** The first slice, its files, its verification and its failure modes are in the
  proposal that accompanies this section; the two attribution/rot defects it fixes are the only code that changed.
