# DESIGN §28 — The mod layer: identity, loading, isolation, versioning, distribution

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

This section is the design for the middle layer between "content a pack can add" and "code a pack can run". It began as
a proposal and is now partly implemented: identity and its wire-level verification
(§28.2, §28.6), load-order arbitration with attribution (§28.3), the override surface (§28.5), operator packs
(§28.10), the kit import whitelist (§28.12) and the four capability declarations of §28.13 (A 段: the schema, its
refusals and its hash participation — the behaviour is B 段) all carry code and tests behind them. Sections that are
still design say so in their own text (§28.8 says it outright) — read a section's status from the section, not from
this header. §28.11 collects what is deliberately left out.

Every `file:line` below was read at the revision this section was written against (`main` `1283050`, `APP_VERSION`
`0.9.4`, `shared/constants.js:9`). A line number is a **snapshot, not a contract** — where a sentence is load-bearing it
also names the symbol, because §28.5 is precisely about what happens when a line number rots (it has happened three
times in this repository already, once in the header of the module that teaches authors to write hooks).

## 28. Mod layer: A content, B server logic, C client UI

### 28.1 The ruling, and what is already there

The owner's ruling of 2026-10-09 fixes three layers:

| layer | what it is | who executes it | when it may change a battle result |
|---|---|---|---|
| **A** content | declarative data, no code: the workshop pack of today (`shared/workshop.js:972` `applyWorkshop`) | nobody — it is merged into the data every consumer reads (`server/data.js:92`) | always, and never detectably by the golden corpus (the corpus is generated from the official `data/*.json`, `test/golden/README.md:8-10`) |
| **B** server logic | hooks and kits: the code of `workshop/<pack>/kits/<id>.js` (`server/workshop.js:350` `loadWorkshopKits`) — one file-name rule over **two key spaces**, operator and summon (§28.12.1) | **the server only** — this is new | only through the hooks it registers, and only after a declared intent passes deterministic verification |
| **C** client UI | rendering, themes, panels | the player's tab | never |

Two sentences in the repository already fix the constraints this design must satisfy at once, and they are currently
written as if they conflicted:

- `docs/PACKS.md:131-139` — "the maintainers' study of mods, 2026-10-07": server-side only for gameplay; a content hash
  in the handshake (`welcome`, `/healthz`, the BattleSpec) before data packs ship; **no third-party code** ("a pack type
  that runs code is a separate decision of the owner's"); golden stays on the original content.
- `docs/WORKSHOP.md:449` — the behaviour layer **is** an owner decision, taken later: "scripts run in the client
  (default `SP_COMBAT=client`), and `SP_VERIFY` can only recompute the result, not stop the script".

The ruling resolves them: **B runs on the server, so the `docs/PACKS.md:137-138` objection no longer applies** (the
owner has now taken that separate decision), and the `docs/WORKSHOP.md:449` warning stops being a permanent hazard
because a room containing a B pack is no longer simulated in the player's tab (§28.4). The three-channel distribution
(`docs/WORKSHOP.md:449`) stays.

What already exists, and must not be rebuilt: the two event buses (`server/sim/battle/hooks.js:17` `on`, `:57` `emit`;
`server/match/effectsMeta.js:48-52` the 19 meta hooks), the kit injection point `Battle opts.kits`
(`server/sim/content/index.js:112-114`), the pack loader and its file-system discipline
(`server/workshop.js:27-97`), the static kit checks (`shared/kitAuthoring.js:182` `validateKit`), and the 8-layer
author-side validator (`tools/workshop-validate.mjs:11-14`). The middle layer is the **seam** between them: who a pack
is, who wins when two of them want the same id, and what has to be true before its code is allowed to run.

### 28.2 Identity (gap 1)

Today a pack has an `id` (the directory name, `shared/workshop.js:302-304`) and free-text metadata
(`shared/workshop.js:540-546`), and the BattleSpec carries only `SPEC_VERSION = 1` (`server/sim/spec.js:39`, written at
`:61`) plus a list of kit **URLs** (`server/sim/spec.js:79-81`; produced by `server/workshop.js:405`). There is nowhere
in the wire, in the data or in the match for "which content is this room running".

**The tuple.** One record, one shape, one place:

```js
{ id: 'abyss', hash: '<64 lowercase hex>', api: '>=1 <2', layer: 'B', combat: true }
```

`hash` is the sha256 of the pack's **content manifest**, `api` is the declared API range (§28.5), `layer` is the
artifact kind, `combat` is the declared intent ("this pack can change a battle result"). A room's identity is the
**digest** of its sorted list: `sha256` of the canonical JSON of `[{id, hash}, …]` sorted by `id`. That single string is
what `welcome`, `/healthz`, the BattleSpec and a bug report all quote, so four different places cannot disagree.

**What participates in the hash.** Not "the directory": a manifest of `(relative path, sha256)` pairs, sorted by path,
over exactly the bytes the loader reads and the browser will be served:

1. `pack.json` — hashed **after** `normalizePackManifest` (`shared/workshop.js:303`), so the hash covers the pack's
   effective declaration (normalized `overrides`, `content`, icon tables, `art`, `support`, `voices`), not its
   whitespace. Two spellings of the same pack then hash the same, and a declaration the loader silently dropped
   (`shared/workshop.js:1573-1575` filters a malformed `overrides` entry in silence today) cannot hide behind the hash.
2. every declared content file, after `normalizeContentFile` — the same normalized records the loader merges.
3. **every other regular file under the pack directory** — its bytes, byte for byte. That is `kits/**`, `assets/**`, the
   declared panel modules and stylesheets, the `server.meta` / `battle` / `room` / `modules[*].entry` modules, the i18n
   and notice files and the root-level files — and, the reason this rule exists at all, the files **nothing declares**
   that one of those declared modules `import`s or reads at runtime (`server/rules.mjs`, `data/rules.mjs`,
   `client/helper.js`, `kits/lib/util.js`).

**The one enumerator, and why there is exactly one** (业主裁决 B, 2026-10-11). "Which files does this pack have" is one
function, `server/packFiles.js listPackFiles` (`:42`): recursive, sorted by path, symlinks neither followed nor listed,
`[]` when the directory is not there. `identifyPack` (`server/workshop.js:825`) builds the manifest from it, and
`server/modCatalog.js catalogFiles` (`:174`) refuses to publish a row the same call does not return. **The list the pack
hash is taken over IS the client's download list** (`GET /mods/catalog.json`, §28.9): one list, two consumers, so the two
cannot drift. The failure B was decided to remove is not "the digest is a little off": a file that a declared module
imports and that neither list names is a file a clean client never downloads — the pack runs on the server and cannot
even resolve its imports in the browser.

**Exclusions: none, and that is deliberate.** No name, no extension and no directory is exempted — not `README.md`, not
`test/**`, not `*.bak`, not a dotfile. A declared module may `import` a sibling, read a data file or load a template at
runtime, and Node resolves those paths natively, so "which files will this pack execute or read" has no decidable answer
short of the whole directory; any exemption re-opens exactly the hole above. Two consequences the author owns: a stray
file in the pack folder **is** part of the pack (it moves the hash and it is offered for download), and a pack folder
should not carry editor backups, build output or version-control metadata. What stays out is only what is not in the pack
directory: the workshop root's own files, and anything a `..` would reach (the route's two refusals,
`server/http/mods.js`). **Symlinks are neither followed nor listed**, i.e. a link inside the pack is not part of it: a
link may point outside the pack directory, and this route resolves a path by string (`modFileAbs`), so following one would
turn the download list into a reader for the game's own tree. The loader itself *does* follow a symlinked declared module
(`fs.statSync`), so a pack must not ship one — that mismatch is deliberate and errs toward not serving bytes from outside
the pack.

**The one row that is not a file.** A pack that declares `assets` (§28.13.5) contributes the container's sha256 under the
reserved path `assets.container.sha256` (`server/packFiles.js ASSETS_DIGEST_PATH` `:28`). It has no bytes on disk, so
`listPackFiles` cannot return it and `catalogFiles` derives it from the container's own row instead of copying it — and
publishes it, with the digest text (64 bytes, `server/packFiles.js containerDigestBytes` `:77`) served by
`GET /mods/file/<pack>/assets.container.sha256` (`server/http/mods.js:116`). So a client can rebuild an asset pack's
hash too. Before this, `catalogFiles` dropped that row (its file read failed), so `catalogPackHash(files)` never equalled
`hash` for an asset pack and such a pack could never be proven held: the row is the difference between "the download list
is complete" and "the download list looks complete".

What deliberately does **not** participate: the mtime "version" that currently versions kit URLs
(`server/workshop.js:394` — a version credential that is not a content hash, and the reason `docs/WORKSHOP.md:447`
records content addressing as unimplemented), the pack directory's absolute path, and any engine code. The last one
matters and is the answer for the third file the ruling names:

- **`shared/loadoutRecord.js` gets no new field, and that is a ruling, not an omission.** That module derives the
  record a unit actually fights with from `data/chess.json` plus the player's picks — `resolveRecordLoadout` (`:18`),
  `composeStats` (`:37`), `composeTalents` (`:48`), `loadoutRecord` (`:79`). If the pack hash covered *derived* records,
  every engine change would change every pack's hash and no pack could prove it was the same pack as yesterday. So: the
  hash covers a pack's own bytes; the **engine** half of the identity is `api` (§28.5). One consequence has to be
  designed for rather than discovered later: a loadout pick is validated against the **merged** data
  (`shared/protocol.js:149` `checkLoadout`, `:180` `resolveLoadout`), and an id that exists on the server can be an
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
  share (the server-run field and the client authority both go through `buildBattleSpec`, `server/sim/spec.js:57`):
  `workshopKits` (`:79-81`) gains `hash` per module, and the spec gains a top-level `mods: { digest, packs: [...] }`.
  This is not bookkeeping: `validateClientResult` (`server/match/fields.js:748`) derives every bound it enforces from
  the spec (`specBounds` `:630`), so a result produced under a different mod set is today checked against the wrong
  bounds — the first thing a mod breaks, and the reason the spec must carry the identity.
- `server/workshop.js` — the *computation*: sha256 lives here (or in a small helper next to it) because it needs
  `node:crypto`, which the shared layer may not import; the runtime already hashes file bytes with it
  (`server/update.js:64`, `server/http/static.js:113`). It is computed **once at load**, from the files really on disk,
  in the same pass that reads them (`server/index.js:88-90` loads once per process; `docs/PACKS.md:125-126` fixes the
  reason: a battle must run the same data in the server and every browser). Computing it from the files rather than
  from the manifest is also the answer to `tools/package.mjs:13-14`: an untracked file is not shipped, and a hash taken
  from the manifest would happily describe a file that no player has.
- **Where the code lives, and the typecheck decision (item 8 of the inventory).** The shape and the hashing helpers are
  `shared/modIdentity.js` — a NEW file inside the typecheck slice (`jsconfig.json:18-24` includes `shared/**/*.js`) —
  and `shared/protocol.js` re-exports them (`MOD_LIMITS`, `isModEntry`, `isModList`, `isModDigest`, `modDigest`,
  `modSetOf`) so the wire contract is still declared in the protocol file. The reason is that `jsconfig.json:26`
  **excludes `shared/protocol.js` from `tsc`**: a validator written there is never machine-checked, and this is a shape
  where a single wrong predicate is a security-relevant hole rather than a cosmetic bug. The alternative — widening the
  slice to include `shared/protocol.js` — was rejected for this step because that file is one of the 76 files the 0.2.2
  port rewrites, and dragging it into `tsc` would add a second, unrelated reason for it to change.
  The pure 256-bit hash is in the same file (the browser recomputes the digest of a list, and the client must not need
  `node:crypto` for that); `server/workshop.js` `identifyPack` builds a pack's manifest list and hashes it with the same
  function, so there is one implementation of the digest everywhere.
- **Enforcement today.** `server/lobby.js` `checkModSet` is the gate: on a server that runs packs, `room.create` and
  `room.join` must echo the digest from `welcome` (`ERR.BAD_MSG` with a `detail` that names the packs otherwise), and
  the plain-install path is untouched. `lobby.stats()` carries the digest into `/healthz`; `Match.mods` carries it into
  every spec.

### 28.3 Loading (gap 2): one rule for "who wins", and attribution that names the pack

**Decided by the owner on 2026-10-09 and refined the same day, and implemented** (the points below are the ruling in
substance; the first step of the slice carries them, `docs/WORKSHOP.md` §1.2 states them for authors):

| collision | the rule | where it is enforced |
|---|---|---|
| a **new** id claimed by two packs — a data record | **refused, and the report names the pack that holds it** (neither author's claim can be preferred) | `shared/workshop.js:1002-1006` (`PACK_ID_COLLISION`, `definedBy`) |
| a new kit id claimed by two packs | **refused, and the report names the pack that holds it** | `server/workshop.js:372-376` (`KIT_ID_COLLISION`, `definedBy`) |
| two packs **overriding the same existing record** (an official id, or a record another pack contributed) | **the smaller pack id wins + the conflict is reported** (`definedBy` names the pack that was passed over) | `shared/workshop.js:1002-1006` and `:986-990` |
| an icon / item icon / art entry claimed by two packs | **the smaller pack id wins**; the loser is reported and named | `shared/workshop.js:1377-1381`, `:1429-1433`, `:1578-1582` |
| `overrides` declares the replacement of an **OFFICIAL** id | **allowed, and the declaration is what makes it allowed** | `shared/workshop.js:14-16`, `:986-990` |
| anything, between two packs | **the smaller pack id wins — on every face** | one comparator: `shared/workshop.js:685` `byPackId` |

Two rules, not three, and they are the only two:

1. **An official record is never replaced without a declaration.** Not negotiable: silently redefining a shipped
   operator would corrupt every match on the server (`shared/workshop.js:14-16`).
2. **Between two packs, the smaller pack id wins, for every kind of contribution** — data, kit, icon, item icon, art.
   Equal ids cannot occur: the manifest must equal the directory name (`shared/workshop.js:308` `PACK_ID_MISMATCH`).
   A collision the loser cannot win is *reported and attributed* rather than silently resolved, which is why the data
   and kit faces "refuse" while the icon faces "keep the first": both are the same rule, seen from the side that lost.

The refinement the owner added is the interaction of the two, and it is the subtle one: **`overrides` is the licence to
replace OFFICIAL data, not a licence to overwrite another pack.** A pack that declares `"chess:X"` and finds that another
pack already contributed `X` loses on id order like everyone else, and the report says so
(`an "overrides" entry does not win against another pack`). Without that sentence the rule would have had a quiet
back door: the bigger-id pack could take the record by adding one line to `pack.json`, which is exactly the
"silently redefines someone else's content" failure the whole section exists to prevent.

Rule 2 needed one comparator, not five implementations. It used to be five: `applyWorkshop` trusted the **array order**
it was handed, the icon and art paths each re-sorted with their own inline compare, and the kit loader used yet another
one — they agreed only because the production loader sorts directory names (`server/workshop.js:34-37`) and the manifest
rule forces `id === directory`. `byPackId` (`shared/workshop.js:685`) is now exported and used by every face, including
the kit loader (`server/workshop.js:361`), so the winner is a property of the pack ids and not of who called the merge.
The two in-memory callers that can pass any order — the tests, and the editor — no longer decide anything by accident.

**Attribution.** Every collision error carries `{ pack, code, file, id, definedBy, reason }`, where `definedBy` is the
pack id that holds the record, or the string `official`. The text says the same thing:

- official: `"<id>" already exists in the official data — add "<file>:<id>" to pack.json overrides to replace it` (`OFFICIAL_ID_COLLISION`)
- against another pack: `"<id>" is already contributed by pack "<X>" — the pack with the smaller id keeps it (DESIGN
  §28.3). Rename this record, or let "<X>" drop it; an "overrides" entry does not win against another pack` (`PACK_ID_COLLISION`)
- kit: `kit "<id>" is already defined by pack "<X>"` (`KIT_ID_COLLISION`, `server/workshop.js:372-376`)
- icon / art: `another pack (<X>) already ships …` (`ASSET_COLLISION`, with `definedBy` as well)

Why it matters enough to be a section: the data path used to say "**official** data" for both cases, because the
variable holding "official + every pack merged so far" was called `official` (it is `prior` at
`shared/workshop.js:932` now). The author's next move was to open `data/chess.json` and look for a record that is not
there. Both defects — the wrong attribution and the unnamed kit holder — are fixed in the first step of the slice.

**Cross-pack conflicts are reported once, at load, in one shape.** The report used to be split across three carriers
with three shapes: the overlay's `report.errors` (logged by `server/data.js:95`), the icon and art collisions on that
same array, and `loadWorkshopKits`' own `errors` (`server/workshop.js:412`) — no single line an author could grep. Every
one of them now carries a `code`, and the four `MANIFEST_MISSING` cases (`data/assets.json` or `data/support.json` not
produced by the asset pipeline) are distinguishable from a collision without reading prose. The ordering contract is
documented for authors in `docs/WORKSHOP.md` §1.2 and summarized in the §1.7 status table, because a rule an author
cannot read is a rule an author cannot follow.

#### What "replacing" an official record actually means (A2: a field-wise patch)

A declaration buys the right to replace an official record; it does not say *how*. The first cut of the implementation
said "wholesale": `merged[id] = rec`. An author who wanted to change one number therefore had to ship the other
forty-three fields too — and a record that named only `stats.maxHp` silently became a two-field operator (tier 1,
`atk` 0, `skill` null) that the engine drew as a one-tile placeholder, with `applyWorkshop` reporting **zero** errors.
The rule now is `shared/workshop.js`'s `mergeRecord`: numbers, strings, booleans and the plain objects holding them merge
field by field, recursively, so the forty-three fields the author never mentioned come from the official record. Two
exceptions, each with its own failure mode:

- **`OVERRIDE_REPLACE_KEYS`** (`skill`, `skills`, `trait`, `traitBase`, `traitOverride`, `modules`, `rangeGrid`,
  `attackRangeGrid`, `assets`, `diy`, `bonds`) are taken wholesale, and so is every array. These are read as whole units
  by the sim and the loadout layer; a half-merged `skill` is a record nobody wrote and no validator describes.
- **`OVERRIDE_KEYED_LISTS`** (`talents`/`talentsBase` on `index`, `talentChanges` on `talentIndex`) merge entry by entry
  **on their identity key** instead. Why this is not the same as a bare list: a 0.2.2 record carries the potential chain
  (`potDown` on the record, `potMin` + `potBelow` on a talent — `shared/potential.js`), while a record the editor derives
  deliberately carries none of it (`stripPotential` is "what a record built at one rank looks like"). Replacing `talents`
  wholesale therefore erased the official's whole chain the moment an author touched one talent, and `potDown`'s leaves
  then pointed at nothing. `talentChanges` is the same shape one level deeper — it lives **inside** an entry of `modules`,
  which is itself replaced wholesale; the key list still applies, because `mergeRecord` recurses into the entries it pairs
  up.

**A key that repeats is not an identity.** `talentIndex: -1` means "a hidden module talent", and an official module may
carry several. When either side of the merge has a duplicate key, that list falls back to wholesale replacement: pairing
two of them would drop an entry, and appending the ambiguous ones would reorder a list the loadout screen reads
positionally. Merging is for a list that really is keyed; when the data says otherwise, honesty beats cleverness.

**The third leg: the record a patch is built from must round-trip.** Field-wise merging protects only what the patch
never mentions. Anything the editor's own derive step drops is gone before the merge runs — which is how the same silent
loss appeared a third time, via `regeneratePack` re-deriving every spec on disk on every save. So the derive path carries
the annotations through: `specFromChessRecord` moves `potMin`/`potBelow` into the spec, and `deriveChessRecord`'s
`talentList` writes them back out. The engine-side convention is unchanged — `stripPotential` / `atRank` still decide what
a record built at one rank looks like.

#### Override mode, end to end (B: the author-facing path)

The last piece is the one an author actually touches. `spec.override === true` is set by the two read-only endpoints
(`GET /api/official/chess/<id>`, `/api/official/enemies/<key>`, `editor/server.mjs`), which return the official record
read as an editable spec plus `ids` and the original record. On save, **that one branch** swaps the id function:
`overrideChessIds` / `overrideEnemyKey` keep the official id instead of adding `chess_ws_` / `enemy_ws_`. The default path
is untouched, and `test/overrideMode.test.js` pins the literal output of `chessIds` / `enemyKey` as its amulet.

Two design points are worth naming, because both were found by writing the end-to-end test rather than by reading the
code:

- **The verdict sees the declaration the save is about to add.** `overrideBlockers` first looked only at the `pack.json`
  on disk, so the very first override of an official record refused itself: nothing had declared `"chess:<id>"` yet, and
  adding that declaration was the thing being refused. The save, the preview and the regeneration now all judge against
  `declarationsFor(...)` — the set the manifest will have after this save. This does not weaken the A3 rule: an id enters
  that set only when `spec.override` is true **and** `spec.id` addresses a real official record, in which case the derived
  record's id is that same id by construction. Hand-writing an official id into an ordinary spec is still refused.
- **The editor's own two keys are not the author's content — and a behaviour switch is not content at all.**
  `deriveChessRecord` stamps `workshop: {schema, id}` and `directToHand` onto every record it builds. Neither exists in
  official data, so writing them back turned a 44-field official record into 46 fields. `stripEditorOnlyKeys` removes
  both before an override record is written; the closed world of A2 is untouched, because that check is about keys an
  AUTHOR writes, and these two are the deriver's own. A hand-written `chess.json` override passes through unmodified and
  the closed world still judges it.
  That much was right for `workshop`, but stripping `directToHand` also **silently killed the switch**: the pack stores
  records, nothing else remembered it, and an author who overrode an official operator ticked the box and got no
  hand-out at all — the editor said 200, the game said nothing. The fix keeps the record shape and gives the switch its
  own home in the **behaviour layer**: `pack.json.playtest.directToHand` (docs/WORKSHOP.md §1.2). The split follows from
  what the two things ARE. "Same shape as the official record" is the override contract — an override says *this
  operator's data is patched*, so the patched record must be the official record with fields changed, and a key official
  data never had is not a patch. "Hand this operator to the player in playtest" says nothing about the operator: it is a
  decision about what the *session* does, which is what the manifest is for — the same reason `support` and `overrides`
  live there. So a pack that ADDS its own operator keeps the record marker (unchanged behaviour), a pack that OVERRIDES
  an official one declares it in `pack.json`, and the engine reads the union of the two (`directToHandIds`). The
  production invariant is untouched and now has its own test: with `SP_PLAYTEST` not exactly `1`, `directToHandIds`
  returns empty, so a stock server hands out nothing even with a pack that declares the switch installed.

The entry points are the official-record lists the operator and monster pages already render; the diff preview reads the
`official` field of the same read-only response and compares it against the record the preview endpoint already returns.
`test/overrideMode.test.js` carries the three end-to-end proofs: with no pack loaded the whole record equals the one in
`data/chess.json` field for field, with a pack loaded the author's number wins and the key count is unchanged, and the
0.2.2 potential chain survives an editor save for both the normal and the elite record.

### 28.4 Isolation (gap 3)

**Server authority.** The behaviour layer runs in the player's browser by default today (`server/match/Match.js:107`, `:202-203`),
and `docs/WORKSHOP.md:449` records the consequence honestly. Under the ruling, a room whose mod set contains any
`layer: B` pack runs with `clientCombat = false` for **that room**: the decision moves from the process-level
`SP_COMBAT` environment variable to the room's mod set (`server/match/Match.js:262` is where the flag is resolved). Player tabs then
never execute pack code, and the `docs/PACKS.md:137-138` objection is answered rather than waived. Layer A keeps
client-side combat: its data is merged on both sides by construction (`server/http/static.js:109-119` serves the merged
JSON the client reads), so it is deterministic for the same reason the official content is.

**`SP_VERIFY` defaulting to `off` is handled, not ignored.** `server/match/Match.js:204-208` parses `SP_VERIFY`, `:263` resolves it,
and the default is `off`; the input inventory is right that this makes a client/server disagreement invisible by
default. The design answers with two changes that do not require the operator to remember an environment variable:
(a) a room whose mod set declares `combat: true` runs server-authoritative **and** with `verify = 'all'` for that room
(the path already exists: `server/match/match/reports.js:113` `_verifyResult` re-runs the field, `:120` compares
`resultDigest`); (b) a room with no mod set is untouched. The cost is real and is stated rather than hidden: the server
now runs those fields itself, sliced by the existing wall-clock budget (`server/match/Match.js:265`, default 8 ms per callback).
That is the price of the guarantee, and it is why `combat: false` packs matter: they keep the cheap path.

**No file system, no network.** `KIT_IMPORT` is an error for anything outside the kit import whitelist
(`shared/kitImports.js`, §28.12) and the environment globals are already scanned for (`shared/kitAuthoring.js`
`KIT_FORBIDDEN_GLOBALS`, checked inside `validateKit`) — but as **warnings**
(`KIT_NONDETERMINISTIC`). Under server-only execution a `Date.now()` is no longer excusable as "both sides ran
it"; it is a direct threat to the recomputation the match depends on. Design: **`KIT_NONDETERMINISTIC` becomes an
error for a `layer: B` pack**, and the refusal names the construct and the source line it was found on (the static scan
already knows both — `validateKit` reports `{ field, code, message, hint }` per issue).

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
when the detail log is truncated. The counters are what reaches the author (§28.7).

**Time budget.** There is no timeout that can interrupt a handler: a tick is one synchronous call
(`server/sim/battle/lifecycle.js:61`), so a loop in a pack hangs a battle in the browser and, for a server-run field,
a scheduler callback. The design does not pretend to add preemption (that is a runtime change, not a middle-layer one).
What it does is make the budget visible and enforceable at load: a pack's verification run (§28.6) measures the wall
clock of the fixed scenario list with and without the pack, and a `combat: false` pack whose cost exceeds a declared
budget is refused. On the client side, layer C is the only place a mod touches rendering, and B never reaches a tab
(§28.4 first paragraph) — so the "no budget in the browser" hole is closed by removing browser execution rather than by
inventing a timer.

### 28.5 Versioning (gap 4)

`gameVersion` is metadata and nothing reads it (`docs/WORKSHOP.md:447` records version alignment, dependency
declaration and content addressing as unimplemented), while the editor writes the string `'0.2.1'` in ten places
(`editor/server.mjs:1928` and nine siblings, `tools/workshop-scaffold.mjs:82`, `editor/ui/pack.js:94`). Two problems,
one shape.

**Declare two ranges, and reuse the machinery that already exists.** `shared/packs.js` already implements exactly what
this needs for its own pack type: `isVersionRange` (`:111`) reads `>=0.2.0`, `0.2.x`, `^0.2.0`, `~0.2.1`, `*` and
`||`; `appVersionMatches` (`:123`) evaluates a range against an app version; and the header (`:20-21`) already states
the intended policy — *outside the range the pack still loads, what it lacks falls back, and it is flagged
`compatible: false`*. The mod layer declares:

- `api` — the **mod-layer API** range, compared against a new constant in `shared/constants.js` next to `APP_VERSION`
  (`:9`): the version of the hook bus and the kit contract. This is the half that covers engine code, and it is the
  reason a pack's hash does not have to (§28.2).
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

### 28.6 Deterministic verification (the enforcement mechanism)

The golden corpus cannot be the check, and saying why is the design: it is generated from the official `data/*.json`
(`test/golden/README.md:8-10`), it deliberately ignores exactly the things a pack adds, and "a new engine hook, event or
chess record does not change the digests of the existing scenarios by itself" (`test/golden/README.md:58`). Running the
official corpus with a pack loaded and comparing against the stored digests would fail for every content pack, by
design.

So verification is a **differential run over the corpus's own scenario generators**:

| the pack declares | the check | it fails when |
|---|---|---|
| `combat: false` (a performance / refactor mod) | run the fixed scenario list twice in one process — once with the pack's kit map injected (`Battle opts.kits`, `server/sim/content/index.js:112-114`), once without — and require `resultDigest` (`server/sim/spec.js:319-339`) equality per scenario | the pack changes any observable outcome. **This is the enforcement of "a performance mod must be semantically preserving".** |
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

### 28.7 Author debugging (gap 5)

The inventory's conclusion is that failure is silent by default, and the middle layer multiplies it. One design response
per row:

| silent failure today | the design's answer |
|---|---|
| a hook name nothing emits never fires and nothing reports it (`server/sim/battle/hooks.js:17-25`, `:57-59`) | the static check already suggests a near miss (`HOOK_UNKNOWN_EVENT`, `shared/kitAuthoring.js:235-237`), but it is text analysis. Add a **runtime** report: `on` keeps the registration in `this._hooks[name]` (`server/sim/battle/hooks.js:20`), so at `battleEnd` the bus can name every pack-owned hook that was registered and never emitted. A typo then costs one battle instead of one bug report. |
| non-determinism is a warning (`shared/kitAuthoring.js:222-227`) | an error for layer B (§28.4), and the refusal quotes the construct *and* its source line, so it stops being "a reason that looks nothing like 'you used Math.random'" (`shared/kitAuthoring.js:13-17`). |
| a kit that returns no `skill` leaves the operator with no skill (`docs/WORKSHOP.md:611`) | the loader knows both facts — a kit was injected *and* `skillSource` says where the skill came from (`server/sim/content/index.js:214`, `:219`). A pack kit with no skill becomes a validation error the editor shows before saving, not a live surprise. |
| a `chess.assets.spine` that points at an uninstalled model draws a flat portrait and logs nothing (`shared/workshop.js:1076-1092`) | already solved by `report.looks` (logged at `server/data.js:97`) — generalise it: every field that degrades silently gets a `looks`-style check, and the editor surface must show it, not only the server log. |
| the editor deliberately does not import author files (`editor/server.mjs:428-431`) | **do not change this.** An HTTP endpoint that executes author code is a code-execution surface. Instead expose the verifier of §28.6 as an explicit action that runs in the **playtest subprocess** (`server/index.js:71-75` `SP_WORKSHOP`), which is already a separate process. |
| runtime errors land in a 100-entry array reachable only through `m.simErrorLog` (`server/match/Match.js:127-129`, `server/sim/battle/hooks.js:167-185`) | per-owner counters (§28.4), plus the room's mod digest on every error line, so a player's bug report carries the identity of the content it came from. |

### 28.8 Layer C and the client: a minimal registration point

The client has no plugin surface: `public/js/main.js:75` is a frozen `SCREENS` object, `:311` resolves a route as
`SCREENS[route] || LobbyScreen`, and the routes themselves come from `selectRoute` (`public/js/store.js:118-128`). What
it does have is the pattern this design copies: **hosts mounted once at the root** — `UiHosts` (`public/js/main.js:345`,
`public/js/ui/components.js:866`), `GuideHost` (`:318`, `public/js/ui/guide.js:106`), `LoadoutHost`, `SupportHost`.

**Implemented (B2 段).** The registration point is `public/js/ui/extensions.js` (`createPanelRegistry`), the declaration
is `pack.json.client.panels[]`, and the module travels over the HTTP route `/workshop-panels/<pack>/<module>`
(`server/http/workshop.js workshopPanelFilesFor`, served by `server/http/static.js`). **The browser learns the list in a
frame the server already sends**: `welcome.modPanels` (`server/lobby.js welcomeInfo`), so a server whose packs declare
no `client` produces no new request, no new DOM and no new global — the same "a JSON-safe module list, built by the
server" shape `spec.workshopKits` has for kits (§28.13), and the reason the list is not fetched.

- **Nine slots, in two kinds, and no container exists until something needs one.** The first four are 0.11.0's fixed
  overlays: the registry creates the `[data-mod-slot]` container on demand (`browserSlotHost`, styled by
  `public/css/components.css`) and appends a `<div>` of its own inside it — not a Preact child, because Preact owns
  everything under `#app` and a raw child a re-render does not know about is how a pack's UI disappears on the next
  frame. The other five (owner's ruling 2026-10-10) live **inside components the engine already renders** — a shop card,
  the bond strip, the HUD layer, a full-screen layer over the game screen, 干员详情 — and there the component renders the
  `[data-mod-slot]` element itself; the registry only **looks it up** (absent means "not yet", never "failed", and never
  a container invented at a position nobody recognises). `screen.game.shopCard` is **repeatable**: one container per
  card, the panel mounts into every one of them and learns which through `ctx.hostKey`. A page whose packs declare no
  `client` still adds **no DOM at all** (`display: contents` on a host that mounts nothing, `pointer-events: none` on an
  idle panel), so an installed pack cannot eat a click on a shop card.
- **`order`, then pack id, then panel id.** `order` (default 0) decides the mount sequence, ties break on the smaller
  pack id — DESIGN §28.3's rule, applied to a list, so the order never depends on the discovery order or the wire order.
- **`gate` is a dotted path into the client store**, read-only (`session.preloadRequired`, `session.entered`). A panel
  mounts the first time its gate is truthy and is never unmounted; a gate naming a path the store does not have is
  **refused by name** instead of never appearing (the discipline §28.13.3 states for the pack side, applied to the one
  judgement only the client can make — the store is the client's truth, and copying a path list into `shared/` would be
  a second truth that drifts).
- **`client.requires` is a capability check, not a promise.** `serviceWorker` / `cacheStorage` / `webCrypto`; a missing
  one refuses that pack's panels **and says so** (a named console error and a toast), because "installed but silently
  doing nothing" is the failure mode §28.13 named.
- **The registry is filled only from the server's data** — the list arrives in `welcome`, a module URL is a same-origin
  `/workshop-panels/…` path or it is refused, and a URL no loader registered answers 404 (the same stance
  `workshopKitFilesFor` takes, `server/http/workshop.js:49-64` used to state it for kits).
- **A C module is part of its pack's hash** (`server/workshop.js identifyPack` hashes the declared `module` bytes), and
  the pack is marked in the UI like any other (§28.9) — a pack that only mounts a panel derives as layer **C**.
- **The boundary is enforced by what is not passed in.** A panel's factory receives a frozen
  `{ id, pack, slot, order, gate, log, host, session, net }`: `host` is a plain element the registry owns,
  `session.setPreload({ required, ready })` is the only store write, and `net.{ on, sendResourceMessage }` is the only
  network access. There is no store handle, no `net` object, no match state and no battle. A C module can therefore be
  wrong in the rendering sense and cannot be wrong in the result sense — which is the whole content of "does not change
  battle results".
- **A declaration that cannot be used refuses the whole pack** (`CLIENT_BAD_PANEL_MODULE`): the module must exist in the
  pack, be a `.js`, and resolve inside it. See §28.13.3.

Two client prerequisites landed with it, both named by the community resource-pack mod's reconnaissance and both
previously missing: `net.sendResourceMessage` (`public/js/net.js`) sends `resource.proof` /
`resource.challenge.request` / `resource.reset` through `_sendRaw`, because the server's challenge arrives before
`hello` and `send()` drops anything while `status !== 'online'`; and `session.preloadRequired` / `session.preloadReady`
(`public/js/store.js`, both `false`) plus `selectRoute`'s second condition and `main.js`'s boot (which now spreads the
existing `session` instead of replacing it) give a pack an entry gate that the localStorage "already entered" flag
cannot bypass.

### 28.9 Distribution (the 5th gap)

Two channels, already decided (`docs/WORKSHOP.md:449`): the official bundle stays clean (`docs/PACKS.md:133-134`,
`:139`), workshop content ships separately through the existing zip path (`shared/zip.js`,
`tools/workshop-pack.mjs`). What is missing is the player-visible half of `docs/PACKS.md:135-136`, and it is four
surfaces quoting one string:

1. `welcome` (from the lobby's `welcomeInfo()`, `server/net.js:666-667`) — what the server is running;
2. `/healthz` (`server/http/routes.js:24`) — the same digest for a bug report and for the client's build guard;
3. the BattleSpec (`server/sim/spec.js:79-81`) — what *this field* ran with;
4. the room/lobby UI — the "modded" mark, and the refusal when a client cannot confirm the digest (`room.join.mods`,
   §28.2).

Two vocabulary decisions belong here because they are cheap now and expensive later:

- A **workshop pack** (`workshop/<id>/`, `shared/workshop.js`) and a **content pack** (`packs/<id>/`,
  `shared/packs.js:55-62` `PACK_TYPES`) are different things that currently share the word "pack" in two documents that
  read as if they disagree. The mod layer calls its own artifact a **mod** in player-facing text, and leaves "content
  pack" to the `packs/` registry.
- A pack set is fixed for the process (`server/index.js:88-90`, `docs/PACKS.md:125-126`), so the digest can only change
  at a restart. That makes the room list the right place to show it, and makes "the server told me X and then ran Y"
  impossible.

**A room may narrow that set, and the narrowing is declared rather than inferred (W-A).** The process set is what the
server *can* run; it is not a promise about what a particular room *does* run. `room.create` therefore accepts an
optional `modIds` — pack ids from the catalogue `welcome.mods.packs` already handed the client — and the server resolves
them through the same `modSetOf` that produces the process digest (`shared/modIdentity.js`), so a room's `{ digest,
packs }` is the same kind of value as `welcome.mods` and not a second opinion about the same list. Three rules make it
safe to add without a flag day:

- **Absent means absent.** No `modIds` (or `[]`) leaves `Room.modSet` null and `room.state` without a `mods` key, so a
  vanilla install's frames stay byte-identical. Only the packs this process loaded may be named; an unknown id is refused
  by name (`ERR.MOD_UNKNOWN`) rather than silently dropped, because a client that asked for content the server cannot
  run must be told, not humoured.
- **`room.join` takes no `modIds`.** The set is the host's to declare, and every member is *told* it — `room.state.mods`
  reaches members and spectators alike. A joiner's own `mods` stays what it always was: the digest of the process set,
  which is what the entry gate judges (below).
- **W-A declares; W-B decides.** This cut stores the room's set and ships it to the clients. It deliberately does NOT
  change what the simulation runs: the entry gate still judges the process digest, and `Match` still receives the process
  set. Until the room's merged data reaches `Match` and the two bypass singletons (`server/sim/content/support/index.js`
  `gameData()`, `server/data.js` `getData()`), a room that declares a subset is running the whole process set, and the
  honest thing is to say so rather than to refuse the room or to pretend the declaration took effect.

Finally, `tools/package.mjs:13-14` and `:156-157` (the `git ls-files` allowlist) mean a mod-layer file that is not
committed does not ship. A hash computed from the manifest could describe content no player has; a hash computed from
the files really on disk (or, in a release, from the files really in the archive) cannot. That is the reason §28.2
computes from bytes.

### 28.10 Operator packs: `units`, `operators`, and the two flat icon tables

The B-段 channel for "a pack adds ONE operator" (`docs/WORKSHOP.md` §1.2). Before it, a community mod could ship an
operator's RECORD, media and voice lines as a pack but the operator still did not exist where a player meets one: the
自选编队 roster is generated into `data/backups.json` (`diy.ownedPool`, `diy.operators`), and a pack cannot contribute
to a generated file. The community mod "克莱门莎" was therefore an **in-place patch** whose only options were to edit
that file (and lose the edit at the next `npm run build-data`) or to not exist.

**Three pieces, one goal.** `content: ["units"]` lands a `units.json` record in `data.backups.units[charId]`;
`pack.json.operators` lands the same operator in the 自选 pool; `art.skills` / `art.profSub` land the two icon tables
whose values are bare path strings (`assets.skills`, `assets.prof.sub`). `units` is the one content file whose on-disk
name and destination differ — `data/` has no top-level `units.json` (`OVERLAY_TARGET_BY_FILE` in `shared/workshop.js`,
and `workshopTouchedFiles` maps it to `backups` for the HTTP half), because `server/sim/simdata.js`,
`shared/standIn.js` and the client all read `backups.units` and nothing else.

#### 28.10.1 Why a pack operator does NOT join the generator's `diy.ownedPool`

The generator contract (`docs/WORKSHOP.md` §1.3, `test/backups.test.js`) says: `data/backups.json` is a GENERATED file,
its `ownedPool` has exactly the 71 operators the generator decided on, and `workshop/` content is an overlay applied
**before `deepFreeze`**. Both halves are satisfied by publishing the pack's operator into the in-memory object only:

- the author can add an operator (the overlay is additive, and a pack is the supported channel);
- the generator stays the single source of the FILE (a pack that is removed takes its operator with it, and
  `npm run build-data` cannot erase an operator the pack owns).

What this deliberately does NOT give the author is a way to change which OFFICIAL operators are in the pool, or to edit
`diy.slots` — the same boundary `support` draws for the 助战 pool ("the pool belongs to the install").

**One community behaviour is declined by this paragraph, on purpose.** A real mod (`fanpack`) ships a
`stripPackOperators` step: when a pack turns an OFFICIAL operator into a chess piece, remove him from `diy.ownedPool`,
so the same operator cannot be fielded twice (once through the 自选 slot, which would also bypass the chess record's
own bonds). The observation is right; the remedy crosses the line above. The loader therefore **records** every
overlap and removes nobody — `applyWorkshop`'s `report.overlaps` names the pack, the operator, the chess record and
whether he was already in the pool, and `docs/WORKSHOP.md` §1.2 tells authors what that report means. Measured on the
real pack: **8** operators overlap, and removing them would take `ownedPool` from 71 to 63. Duplication itself never
happens — `mergeWorkshopOperators`' "an id enters the pool once" invariant predates this section and is untouched by
it. A maintainer who wants the mod's behaviour gets it as an engine rule with the golden corpus moved deliberately;
a pack does not get to decide which official operators a player owns.

#### 28.10.2 The refusal set is the interesting half

Each of the four refusals exists because the corresponding mistake is SILENT otherwise (`shared/workshop.js`
`workshopOperatorEntries`, one function used by the loader):

| code | the silent failure it replaces |
|---|---|
| `OPERATOR_NO_UNIT` | an operator with no record is an empty slot: no name, no profession, no def |
| `OPERATOR_NOT_SIX` | the 自选 pool IS the 6★ path; a 5★ declaration would be stored and never offered (the workshop chess registry is the 5★ route) |
| `OPERATOR_BOND_UNKNOWN` | a mistyped bond id means that bond strip never appears, and the author only sees "the bond does not work" |
| `OPERATOR_FORM_MISSING` | a pool member whose `forms` miss a 自选 slot's status cannot be picked — and `tools/golden.mjs` builds a corpus scenario for every pool member, so it makes the corpus generation THROW and takes `golden` / `ci` down |

`OPERATOR_FORM_MISSING`'s requirement is DERIVED (`shared/diy.js` `requiredUnitForms`, built from `diy.slots` and the
records' `status`), never a hardcoded `2/60/7/3`: a data change that adds a slot moves the check with it. The operator
record's own shape is checked just as narrowly: six fields, everything else copied verbatim, because re-stating the
official schema would create a second truth that drifts (the same stance `ART_TABLES` takes for art).

Ordering follows §28.3 unchanged: packs merge in `byPackId` order, so the smaller pack id keeps a contested `charId`
and the loser is named (`contributors` + `PACK_ID_COLLISION`). Two faces report it, because the loser's *declaration*
is refused one layer later — it has no record to declare.

#### 28.10.3 Potential annotations: absent means potential does NOT scale

A pack operator's `forms` normally carry none of the potential annotations (record-level `potDown`, talent-level
`potMin` / `potBelow`). Measured on 0.2.2 (`_up/clemnt-runtime-proof.md`): the engine **does not error, does not drop
the talent, but neither the stats nor the talent values scale with potential** — a battle built at potential 1 and one
at potential 6 are byte-identical, while an official operator carrying the annotations scales (its `atk` moves
392 → 417). So the semantics of the new channel are: *a pack operator is fielded at full potential and lowering its
potential changes nothing.* This is a new interface with a silent consequence, which is why it is written down here —
and why no warning was added in this round (in 0.9.4's data NO record carries the annotations, so a warning would fire
for every pack operator and drown the boot log). An author who wants potential to matter copies the official record's
annotations into its `forms` along with the numbers.

#### 28.10.4 `test/modSurface.test.js` is the frozen list

`test/modSurface.test.js` (commit `7b90bb7`) pins the interface surface an in-place patch depends on. The operator
channel is the pack-side answer to the same surface, so the rule stays: **touching that file requires the repository
reference census** (it names `data/backups.json`'s record keys, `diy.operators`' field set, `assets.prof.sub` /
`assets.skills`'s container shape, the nine named exports and the live `Battle` members). The two are deliberately
complementary — the guard says "these positions must not move", this section says "and here is the supported way to
reach the same content".

### 28.11 What this section does not decide

- **No sandbox for layer B.** The ruling is "the server executes it", not "untrusted code executes safely". A pack with
  a `while(true)` is refused by the load-time budget check (§28.4), not contained.
- **No hot reload.** The pack set is fixed for the process; a digest that can change mid-match is worse than a restart.
- **No code signing, no author identity.** `pack.json`'s `author` stays metadata (`shared/workshop.js:540-546`); the
  hash proves *which* bytes, not *whose*.
- **No WASM kernel decision.** That is the performance benchmark's call, and it is a different layer: a faster kernel is
  a `combat: false` change and would be verified by §28.6 like any other.
- **The section number is contended.** `test/docs-paths.test.js:96-113` requires every `## N.` block to live exactly
  once and to run without gaps (no duplicate, no hole). The in-flight upstream 0.2.2 port claims §28 for its own
  revision section, and it also rewrites the same index table row area in `docs/DESIGN.md`. Whichever lands second
  renumbers; if the port lands first, this section becomes §28 and its subsections renumber with it. Its index row is
  appended at the bottom of that table for exactly this reason.
- **Not everything here is implemented.** The gaps that closed (identity, load-order arbitration, the override
  surface, operator packs, kit import, the two middle-layer declarations `server.preDispatch` / `routes`, and since
  B2 段 the client registration point §28.8) have code and tests named in their sections; the rest are still design —
  `assets` (the container, the Service Worker policy) is B3 段 — and each such section says so in its own text.
- **Theme variables and panel stylesheets — both, per the owner's ruling of 2026-10-10.** §28.8's draft sketched a
  `registerTheme({ id, pack, vars })`; that half is now `client.theme.vars` — CSS custom properties, **additive**,
  written by `public/js/ui/extensions.js applyTheme` and restored on `dispose`. The same ruling added the other half,
  because variables cannot express *a whole new component's styles*: `client.panels[].styles[]` injects the pack's own
  `.css` over the same registered route (`/workshop-panels/<pack>/<file>.css`, `text/css`), appended to `<head>` so it
  lands after the engine's styles, and removed on `dispose`. The variable namespace is arbitrated like every other
  collision in this layer — the **smaller pack id** holds a variable and a later pack writing the same name is refused
  by name (`CLIENT_THEME_VAR_TAKEN`, §28.3). This supersedes the earlier "no theme registration" stance: the reference
  community pack needed both halves (chat 21 KB / devices 11.7 KB / title 22 KB of component stylesheets).

### 28.12 The kit import surface (gap ④): a whitelist, resolved on both ends

**The defect, stated as the code states it.** A pack kit is one file with two loaders:

| end | who | how |
|---|---|---|
| server | `server/workshop.js loadWorkshopKits()` | `import(pathToFileURL(file).href + '?v=' + mtime)` — a **real path** |
| browser | `public/js/battle/runner.js loadSpecKits()` | `import('/workshop-kits/<pack>/<id>.js?v=…')` — a **URL** |

So `../shared/tier1.js` means `server/sim/content/kits/shared/tier1.js` to one and `/workshop-kits/shared/tier1.js` to
the other. That is why `shared/kitAuthoring.js` refused every import, and it is a real cost: the community kit
`op-clemnt.js` (克莱门莎) opens with five static imports of engine helpers and could therefore not be shipped as a pack,
even though it runs correctly as an in-place patch. Both loaders exist and both are exercised —
`test/workshopKits.test.js` asserts the served URL and `loadSpecKits`'s import line — so this is **not** a server-only
problem: the browser really does import pack kits.

**The ruling: a prefix whitelist, resolved on both ends.** A kit may import through exactly two prefixes
(`shared/kitImports.js KIT_IMPORT_FILES`, one row per file, one name per file):

- `@kit/tier1.js` … `@kit/tier6.js`, `@kit/summoner.js` — the kit SDK the official kits are written against
  (`server/sim/content/kits/shared/`);
- `@sim/constants.js`, `@sim/dir.js`, `@sim/targeting.js` — the three pure helpers that SDK is built on, and the ones
  the community kit reached for.

Everything else is still `KIT_IMPORT`: relative paths, absolute paths, `..` traversal, a legal prefix with an
unlisted module name, bare specifiers, `require()`, dynamic `import()`, and `export … from`. Every refusal names the
whole whitelist, because a refusal that does not say what *is* allowed is what makes an author guess.

**One table, two readers, and the verdict is shared.** The server rewrites the whitelisted specifiers to real `file:`
URLs (`rewriteKitImports`) and imports the result as a `data:` module — a `data:` module has no directory, so a relative
specifier inside it cannot resolve, which is exactly why every specifier has to be rewritten. The browser needs no
rewriting at all: `public/index.html`'s import map declares `"@kit/": "/sim/content/kits/shared/"` and
`"@sim/": "/sim/"` (`/sim/` → `server/sim/`, `server/http/static.js`), so the same source resolves there. The map is
generated by `kitImportMap()` and pinned to the table by `test/kitImports.test.js`, so a new whitelist row that nobody
added to the map is a red test rather than a 404 in a player's browser.

The shared verdict is the part that matters for this design: `validateKit` and `loadWorkshopKits` both call
`kitImportIssues()`, so **the editor cannot pass a kit the loader then refuses** — the property §28.3 states for the
data overlay, now true for the behaviour layer's imports as well. The loader's error keeps the validator's `code` and
its exact `reason`, and `test/kitImports.test.js` asserts that equality on a refused kit.

**What deliberately did not change.**

- **The pack hash.** §28.2 hashes `kits/*.js` from the bytes on disk (`identifyPack` → `[path, sha256]`). The rewrite
  happens in memory and never touches a file, so both ends still describe the same bytes — a hash taken over the
  rewritten text would be a hash of something no author wrote and no browser receives.
- **The determinism rules.** `Math.random` / `Date.now` / `fetch` / `document` … keep their existing verdict
  (a warning today, §28.4's pending error for `layer: B`); this section only moves the import line.
- **The module set is closed.** There is no "import anything under `server/sim/`" escape hatch: `@sim/` opens three
  files, not a directory. Widening it is a one-line change to a table that a test reads, which is the point — the
  boundary should be visible in a diff, not implied by a path.

**A whitelist row is a promise about names, so a guard holds it.** Opening a file makes its exported names an external
interface, and nothing in the engine would notice a rename. `test/kitImports.test.js` therefore records every
whitelisted file's export-name set and asserts the module still exports **at least** those names — a superset check,
not equality, because adding an export cannot break a mod while deleting or renaming one breaks every pack that imports
it. The failure names the file, the specifier and the missing names. `test/ui/kitimports.e2e.test.js` reads the same
table, so the guard and the browser check can never drift apart.

**What is verified, and what is not.** The server half is verified end to end: a fixture kit that imports all five
community-kit modules is really imported through `loadWorkshopKits`, its helper is called, and the value it computes is
asserted. The refusals are verified through both readers, and the pack hash is asserted unchanged across a load. The
browser half is verified only as far as Node can go — the import map is asserted to agree with the table, and every
whitelisted module is asserted to be served as JavaScript at the URL the map resolves it to. Import-map resolution
itself is the browser's job; `test/ui/kitimports.e2e.test.js` is the opt-in check that does it in a real Chrome
(`SP_E2E=1 node --test test/ui/kitimports.e2e.test.js`: it imports every whitelisted specifier in the page context,
asserts the export-name floor, and asserts a specifier outside the whitelist does not resolve there either), and until
someone runs it on a machine with Chrome this remains the standing gap recorded in `docs/WORKSHOP.md` §4.4.

### 28.12.1 The second key space: a kit may target an OPERATOR or a SUMMON (2026-10-11)

**The defect, stated as the code states it.** §28.12 closed the kit *import* surface. The kit **key** surface was still
one-sided: `server/sim/content/index.js setupUnitKit()` resolves an operator's kit through `kitOf()` (keyed by
`def.charId` for a 补位 / 自选 piece, else `def.baseId` / `def.id`), and a **summon's** kit through a second, entirely
separate table — `tokens.kits?.[def.id]` (`tokens.js:1620` builds it from `RAW_KITS`, one entry per official token).
That table is the engine's: a pack can ship `tokens.json` records, but it cannot put behaviour behind them. The
consequence is the worst kind — a pack's summon has data and no behaviour layer, and **nothing reports it**.

**The id is stable, and that is why this is possible.** `simdata.js normalizeToken(id, …)` writes `id` and `baseId`
verbatim from the token record id, `setupUnitKit` looks the kit up by exactly that `def.id`, and `spawnToken` takes the
token record id as its own key. So `kits/<tokenId>.js` names the same thing the engine looks up — no invented key, no
per-owner variant, no spawn counter. (This was checked before anything was built: had the key been derived per owner or
per spawn, the honest answer would have been to stop and report, because a channel that silently fails is worse than a
missing one.)

**The design: one file-name rule, two independently arbitrated spaces.** A pack kit is still `<packDir>/kits/<id>.js`
and still a top-level `.js` whose basename does not start with `_` (§28.18) — no new suffix, no subdirectory, no second
loader rule to keep in sync. What changed is that the id is judged in **two** spaces:

| space | how the engine resolves it | which targets the pack owns |
|---|---|---|
| **operator** | `kitOf()`: `def.charId` (补位 / 自选) → else `def.baseId` / `def.id` / the suffix-less id | its own `chess.json` records; the charIds it declares into the 自选 pool (`pack.json.operators` — `isDiyDef` + `kitOf` key a DIY piece by exactly that charId); a declared `"chess:<id>"` |
| **summon** | `setupUnitKit()`'s token branch: `tokens.kits[def.id]` | its own `tokens.json` records; a declared `"tokens:<id>"` |

**The space is DECIDED, never guessed — and an id in both is refused.** `data/tokens.json` really does carry `char_…`
ids (the two band map characters `char_605_cmedic` / `char_613_acmedc`), so a name-prefix rule would be a heuristic that
is wrong on the repository's own data. `loadWorkshopKits` therefore decides by table lookup — the pack's own records
first, then the two merged tables the caller hands over (`knownIds`, `knownTokenIds`), then the declared override — and
an id present in BOTH is refused by name (`KIT_TARGET_AMBIGUOUS`): the operator half would win the engine's lookup and
the summon half would be a kit **nothing ever runs and nothing reports**, which is the failure class this layer exists
to eliminate. The same rule is reproduced in `shared/kitAuthoring.js` (`ambiguousIds`), so the editor, the validator and
the loader reach one verdict.

**Independent arbitration, both halves.** Each space owns its own registry, its own holder map and its own refusal, so an
operator kit and a summon kit of the same name never hide each other; the collision rule is unchanged (§28.3: the
smaller pack id wins, the loser is named) and is applied **once per space**. Both spaces travel to the browser in the
**same** `spec.workshopKits` list, with a summon module marked `kind: 'token'` and an operator module unchanged
(absent marker ⇒ operator), so every existing reader of that list keeps its exact meaning. The server injects the two
maps separately (`Battle opts.kits` / `opts.tokenKits`), each winning over its own built-in registry; `spec.js` only
sets a key when the caller passed it, so a battle without packs receives neither and the golden corpus is untouched.

**What the caller must pass, and why one table is not enough.** `server/index.js` now builds `knownIds` from the merged
chess ids **plus every loaded pack's `pack.json.operators` keys** — a 自选 operator's kit is keyed by charId, so that
charId is a real kit target with no chess record behind it — and `knownTokenIds` from the merged token ids, i.e. the
official `data/tokens.json` plus every pack's `tokens.json`. A caller that passes only one table does **not** get a
"dead kit" verdict for the other space: a single table cannot speak for the space it does not know, so that case falls
back to the ownership rule (the pack's own records and its `overrides`). Passing neither reproduces the pre-existing
behaviour exactly, which is what the older test fixtures rely on.

**Rejected, and why.** (a) A separate module-list key in the spec instead of a `kind` marker — a second list to keep in
sync with `loadWorkshopKits`' output for no gain, and one more field every spec consumer has to learn. (b) Making
`tokenKits` a slice of one merged `opts.kits` map — cheaper for the resolver, but then a name collision between the two
spaces is decided by whichever map was consulted, silently, which is exactly the failure `KIT_TARGET_AMBIGUOUS` refuses
by name. (c) Emitting `tokenKits: {}` unconditionally — the `lobby.js` / `Match.js` / `combat.js` chain is written so a
plain install never puts the key on `Battle opts` at all, and that property is what makes "no packs ⇒ byte-for-byte"
checkable rather than merely claimed.

**What is verified.** `test/workshopKits.test.js`: a pack that ships a token record loads `kits/<tokenId>.js` with the
summon key space (`kitInfo.tokenKits[tokenId]` is a function, no error), a pack that declares only a chess record is
still refused for that token id (`KIT_NO_TARGET` — the existing rule, not relaxed), an id in both spaces is refused by
name, the collision rule is applied per space, `buildBattleSpec` carries `kind: 'token'` and the runner rebuilds both
maps, and `setupUnitKit` prefers the injected summon kit while falling back to the built-in one when the key is absent.
`test/kitAuthoring.test.js`: `ownCharIds` / `ownTokenIds` release, the same-named chess id keeps its old verdict, and
an ambiguous id is refused. The token record id is asserted to equal the key the engine looks up, so the channel cannot
rot into a silent no-op without a red test.

**复算与真跑必须用同一份 kit 表 (2026-10-12).** The server assembles a Battle in two places, and §28.12.1's two key
spaces have to reach **both**: `MatchCombat.newBattle` (server/match/match/combat.js — the battle the server really runs)
takes `this.workshopKits` / `this.workshopTokenKits`, and `MatchClientCombat._specBattle` (server/match/match/
clientCombat.js — the headless run, a takeover and **the `SP_VERIFY` re-computation** of a client's result) takes them
too. Both read the same fields, which come from **one** source: `lobby.js` hands `roomAssets.forRoom(room.modSet)`
(W-B, §28.16 — the room's declared packs are what this match runs) to `Match opts`, and `Match.js` stores them verbatim
(`assets ? assets.kits : this.workshop.kits`). So the sentence is exact: the re-computation must use *that* map — the one
the room's declared set was trimmed down to — not the process-wide one and not a fresh copy.

**What the missing half did.** Until this was closed, `_specBattle` passed only `BattleClass` / `sharedBoss` / `logger` /
`recordEvents` / `battleInstallers`, never `kits` / `tokenKits`. In a room with a kit-carrying pack, the client simulated
with the pack's behaviour layer (it rebuilds both maps from `spec.workshopKits`, §28.12.1) while the server re-computed
with the **built-in registry** — two different battles by construction. `_verifyResult` then compares result digests
(`resultDigest`), so the mismatch surfaced as a false "client result differs from the server's simulation" (the honest
player's real result replaced by the server's), and a genuinely wrong result could pass when both sides happened to agree
on the digest. A channel that silently fails is exactly the failure class this layer exists to eliminate.

**Why it is checkable rather than merely claimed.** The five keys this section grew (`kits`, `tokenKits`,
`battleInstallers`, `bossHitLimit`) had been written out **twice** — once per path — which is exactly how the missing
half happened. They now have **one** assembly, `battleOptsFromMatch` in `server/match/match/battleOpts.js`, and both
paths call it (`combat.js` from `newBattle`, `clientCombat.js` from `specBattleOpts`); a sixth key has one place to go.
The discipline is unchanged: each key is spread only when the match really has it, so on a plain install both fields are
`null` and no key is set — `Battle opts` keeps exactly the shape it had before, the same discipline as `spec.js`,
`lobby.js` and the old `combat.js`. An **empty** map (a `{}` handed in by a caller) is a no-op by the same reading as
before: `setupUnitKit` consults `opts.kits` / `opts.tokenKits` only on a hit, so the battle is unchanged (the existing
"no packs: no maps vs EMPTY maps produce identical results" test pins that).

**What is verified.** `test/workshopKits.test.js` (复算与真跑, §28.12.1): with a kit-carrying pack,
`_specBattle(f.spec)` carries the match's own map by **identity** (`battle.opts.kits === match.workshopKits`, and the
pack's kit function itself), the same for `tokenKits`; on a no-pack install neither key appears and the `Battle opts` of
two same-seed runs are field-for-field equal; and the real-run assembly (`newBattle`) versus the re-computation
(`_specBattle`) agree on every battle input (seed, players, spawns, routes, flags, …) and on the kit maps. Reverting the
two spreads to empty objects turns two of those tests red. `test/battleOpts.test.js` pins the **single** assembly
instead: the helper's own truth table (a key only when the match has it, an explicit per-battle option wins), and — on a
real match driven to COMBAT — that both paths' `Battle opts` are field-for-field equal and are what the helper returned.

### 28.13 The four capability declarations: `assets`, `client`, `server.preDispatch`, `routes` + the top-level key closure and `i18n` (A 段 + B1 段 + B2 段 + B3a 段 + B4 段 + B5 段)

**The gap, stated by its own verdict.** A third-party mod ("full resource pack: import, verify, server admission") was
rewritten into this repository's pack format and then judged by the REAL validator, on both this branch and the middle
layer: `EMPTY_PACK`, twice. It ships no operator, no item, no map, no voice line and no art — its whole payload is
`.spresources` containers it does not own plus a client-side import flow and a server-side admission hook. The four
things it needs have no field in `pack.json`, so the pack could not say what it was; the inventory, the field shapes and
the reasons are in `_up/mod4-pack/pack/README.md` §4, and the two verdicts are in
`_up/mod4-pack/pack/validator-verdict.json`.

**Two stages, and the line between them.** A 段 is the schema (`shared/workshop.js`): the four groups parse, refuse and
hash (§28.2), and nothing executed them. **B1 段 is the behaviour of two of them**: the `server.preDispatch` hook is
registered on the dispatch path and `routes` are served, both wired in `server/index.js` and both documented for
authors in `docs/WORKSHOP.md` §1.9.1 / §1.9.2. **B2 段 landed the third one**: `client` panels are registered on the
module route `/workshop-panels/`, mount in the browser from `welcome.modPanels`, and a declared module that is not
usable refuses the whole pack (§28.13.3). **B3a 段 landed the fourth and paid off the debt B2 named**: the declared
container and manifest are served on their own pack-scoped route, `serverPolicy` decides whether `/assets/` and
`/fonts/` answer at all, `verify` is checked at load time, and `server.preDispatch` was **aligned** to the
"unusable declaration refuses the whole pack" rule it had been exempt from (§28.13.4). **B4 段 closed the two things
B3a left open**, both named in the last paragraph of §28.13.4: the owner made the ruling about the root-scope worker
(the Service Worker is the **engine's**, a pack only declares — §28.13.5), and the one remaining hole in §28.13.3
(a hook module that only `import` can judge) is closed on the startup assembly path (§28.13.5).

**B5 段 closed the two remaining "declared, but silent" holes**, and the second one is the reason this section now has a
fifth row in the table below:

* **The top-level key set is closed** (`shared/workshop.js PACK_FIELDS`). Before this stage, a `pack.json` key the loader
  did not read was simply not read: the three community mods each carried keys that this format has no home for —
  `variants` (fanpack G-01, "the same record in another calibration, switchable"), `skins` (G-05) and `i18n` (G-04, now a
  real field) — and the only signal the author got was that the thing he wrote did not happen. `{content:["chess",
  "variants"]}` even normalized to `content: ["chess"]`. That is the failure mode this whole design keeps naming, so the
  loader now refuses the whole pack by name (`PACK_UNKNOWN_FIELD`, with the full field list in the reason). The direction
  is deliberate: a key we *choose* not to support (`config`) and a key the author *typoed* look identical to the author,
  and the refusal explains both. The author-facing consequences — including what to write instead of `skins`
  (`art`) and why `variants` has no substitute — are `docs/WORKSHOP.md` §1.1.
* **`i18n`: adding strings to a language that already exists.** The `packs/` `lang` type can only ADD a language — a pack
  carrying `en` / `ja` / `ko` / `zh-TW` is skipped whole (`the language en is already provided by public/i18n/en.json`),
  and a pack with a new interface needs exactly that. The field is `{ "<lang code>": "<pack-relative .json>" }`; the
  merge rule is **existing keys are never overwritten** and every overlapping key whose value differs is **reported by
  name** (key + language + pack id + both values), because the sources of such patches are machine translations and old
  official files — silently replacing a published string is the same class of failure as silently dropping a key. The
  merged body is what `/i18n/<code>.json` serves; `public/i18n/*.json` is never rewritten (the same stance the data
  overlay takes). The declared files are hashed into the pack identity exactly like `client.panels[*].module`
  (a translation is bytes that change what the player sees), so a pack that declares no `i18n` keeps its hash
  byte-for-byte. Details for authors: `docs/WORKSHOP.md` §1.10.

**The shapes, with the one decision each carries.**

| group | shape | the decision it encodes |
|---|---|---|
| `assets` | `{ container, manifest, serverPolicy?, verify? }` | `container` must be a pack-relative `.spresources` path (the container format is defined by `tools/make-spresources.mjs`), `manifest` must be a pack-relative `.json` (the flat file table the client validates), defaults `serverPolicy: 'serve'` / `verify: 'sha256'` |
| `client` | `{ panels: [{ id, slot, module, order?, gate? }], requires? }` | `slot` is a **closed enum** — the four hosts §28.8 already names (`root.overlays`, `root.guide`, `screen.game.aside`, `screen.result.footer`); `module` is a pack-relative **`.js`** path, never a URL (B2 段: this channel serves code, so the shape layer refuses a `.html` the same way the serving side does); `order` decides the mount sequence, `gate` names a client-store path that must be truthy; `requires` is the closed capability list (`serviceWorker`, `cacheStorage`, `webCrypto`), because "the browser does not support it" and "it is installed but silently does nothing" are different answers |
| `server` | `{ preDispatch: { module, policy, intercepts } }` | `intercepts` must name types that exist in `shared/protocol.js C2S` — the list is derived from the protocol, not copied here, so an author cannot declare an interception the bus never delivers (the original mod's `match.queue` / `queue.join` do not exist in this repository) |
| `routes` | `[{ path, file, cache? }]` | deliberately narrow: an absolute path, a pack-relative **`.json`** file (never `.js` / `.html`: this channel is data, not code, the same line `/workshop-assets` draws), `cache` one of `no-cache` / `no-store` / `public` |
| `i18n` | `{ "<lang code>": "<pack-relative .json>" }` | the language code must be canonical (`shared/i18nPacks.js`) and never the source language `zh` (the msgids themselves have no file); the value is a pack-relative `.json` whose entries merge into an EXISTING language without replacing any key (§28.13.6) |

**One refusal per way to be wrong, and they name the field.** Unknown keys are refused rather than ignored
(`ASSETS_UNKNOWN_FIELD`, `CLIENT_PANEL_UNKNOWN_FIELD`, `PREDISPATCH_UNKNOWN_FIELD`, `ROUTE_UNKNOWN_FIELD`): a `container`
misspelled as `containers` must not produce "the pack is valid but the resources never load". Every path must be
pack-relative (`ASSETS_BAD_CONTAINER`, `CLIENT_BAD_PANEL_MODULE`, `PREDISPATCH_BAD_PATH`, `ROUTE_BAD_FILE`) — a
declaration is part of the identity, and an absolute path erases which pack the behaviour came from (§28.2). Enums are
refused by name (`ASSETS_BAD_SERVER_POLICY`, `CLIENT_BAD_PANEL_SLOT`, `CLIENT_UNKNOWN_REQUIRE`, `ROUTE_BAD_CACHE`), and
`intercepts` is judged against `C2S` (`PREDISPATCH_UNKNOWN_TYPE`). The full list with the exact code for each case is
pinned by `test/packAssets.test.js`; the author-facing table is `docs/WORKSHOP.md` §1.9.

**Submission order is normalized, so the bytes cannot depend on how the author wrote it.** Panels sort by `id`,
`intercepts` is de-duplicated and sorted, and `requires` follows the closed enum's order — the same rule §28.2's
`canonicalJson` already applies to keys, now applied to the lists inside a declaration.

**`EMPTY_PACK` after this change.** The four groups are contributions **when they declare something**; `routes: []` is
not (it is indistinguishable from not declaring), and neither are `api` and `playtest`, which are declarations about
behaviour rather than content. The two consequences are both load-bearing and both tested: a pack whose only payload is
`assets` / `client` / `server.preDispatch` / `routes` is a legal pack, and the existing ruling — a pack carrying only
`playtest` is still refused (`test/playtestDirectToHand.test.js`) — is untouched. No assertion was relaxed to make a new
case pass.

**The hash, and the one way this could have gone wrong.** §28.2 says a declaration that can change one end's behaviour
must be in the content hash, or one digest names two behaviours. `identifyPack` hashes `canonicalJson(pack)` — the
NORMALIZED manifest — so the declaration is covered for free *if* it is in that object. The trap is the opposite
direction: adding four keys unconditionally would put them into **every** existing pack's normalized manifest, changing
every content hash and making the room digest gate (`modSetOf`, `welcome.mods.digest`) misfire on unchanged packs. So
`normalizePackManifest` adds each key **only when `pack.json` really wrote it**, and the rule is pinned three ways in
`test/packAssets.test.js`: the normalized manifest of an undeclared pack contains none of the four keys, the three
shipped example packs still hash to their pre-change digests (`96ebc2d4…` clementia, `15092019…` demo-workshop,
`77b80c6e…` kit-demo), and a declared pack's hash does change and does move the wire digest.

**`MOD_API_VERSION`, and the comparison §28.5 said was missing.** §28.5 declared `api` as the mod-layer range
"compared against a new constant in `shared/constants.js` next to `APP_VERSION`", and recorded that the constant did not
exist yet — so `api` could be written but not judged. It now exists (`MOD_API_VERSION = 1`, a whole number like
`PROTOCOL_VERSION`, deliberately not `APP_VERSION`), and the comparison is **declaration-only**: a pack that declares no
`api` is untouched (that is every pack in the tree today), while a declared range that excludes the installed mod API is
refused by name (`MOD_API_INCOMPATIBLE`). One trap is worth recording: `shared/packs.js appVersionMatches` reads a
three-part version and **treats an unparsable one as a match**, so the integer constant must never be passed to it
directly — `shared/workshop.js` builds `'1.0.0'` from the number, and the test asserts that a `'2.x'` range is refused
with the string and accepted with the bare number, so the fallback cannot come back silently.

#### 28.13.1 The dispatch-time hook, and the five decisions B1 had to make

`server.preDispatch` is registered on `server/net.js`'s `onFrame` — **after** the own-property `C2S` check and
`validateC2S`, and **before** the `ping` / `hello` branches and the `hello required` session check. The position is not
a preference: the hook bus owns three client messages (`resource.proof` / `resource.challenge.request` /
`resource.reset`, now in `shared/protocol.js C2S`), the server's challenge goes out when the socket is adopted, and a
client's proof therefore usually arrives **before** `hello` — anywhere later and it is answered `hello required`, so the
gate can never close. The three types are a protocol-face addition with no `PROTOCOL_VERSION` bump: an old client never
sends them.

1. **No second `socket.on('message')`.** The listener belongs to the framework (`handleConnection`); registering another
   one delivers every game message twice, and `room.create` / `g.buy` are side-effecting. The hook is *called*
   (`opts.preDispatch(conn, msg) → boolean`), never handed a socket; `test/modPreDispatch.test.js` pins
   `listenerCount('message') === 1`.
2. **Per-connection instances.** `server/modDispatch.js` calls the module's `createPreDispatch(deps)` factory **once per
   connection** and keeps the instance in a `WeakMap` keyed by the connection. State lives in that closure, so two
   rooms or two sockets cannot mix — the ruling forbids "set a global before the match and restore it after", which
   concurrent matches would leak through. A second, smaller guarantee comes from the injected surface itself:
3. **A frozen, minimal dependency object.** Exactly `pack`, `policy` (parsed, deep-frozen), `policyFile`, `intercepts`,
   `c2s` (a frozen copy of the protocol catalogue, so a pack cannot mutate the protocol other packs see), `log` (a
   forwarding facade), `now` (the injected clock) and `send` (the framework's own send helper, with its backpressure
   guards). There is no `data`, no `lobby`, no `Match`, no battle object. **A hook can therefore observe, record,
   report and veto the entry messages it declared — it cannot change a battle result at all**, which is what "a pack
   that does not declare `combat: true` must not change a match result" means structurally rather than as a promise.
4. **Named refusal at load, no consumption at runtime.** A missing module or policy, an unparsable policy, a module
   without the factory, or an `intercepts` entry the *loaded* protocol does not know
   (`PREDISPATCH_BAD_MODULE` / `PREDISPATCH_BAD_POLICY` / `PREDISPATCH_UNKNOWN_TYPE` / `PREDISPATCH_BAD_PATH`, the same
   names A 段 fixed) are all named refusals. **What they refuse changed twice and both changes were deliberate**: B1
   refused only *that hook* and let the pack load; B3a aligned it to §28.13.3's rule (a declaration that cannot be used
   refuses the whole pack), and B4 closed the last box by running the import-only judgements on the startup assembly
   path. A hook that throws *later* is still logged and treated as "did not consume": a gate that failed closed on its
   own bug would lock every player out, and refusing a hook is the load-time job.
5. **Every validated message reaches the hook, not only `intercepts`.** `intercepts` is the hook's own gate list (the
   framework validates and injects it); the three `resource.*` types are deliberately not entry messages and would
   otherwise never reach their only consumer. `intercepts` decides what the hook may *block*: a vetoed message does not
   go to the lobby, and an allowed one — including a type listed in `intercepts` — does. A veto is only a veto if the
   client can tell it apart from silence, so the contract requires the hook's reply to carry the request's `rid`; a
   rid-less error frame becomes an `unhandledError` toast in the browser (`public/js/main.js`).

**No pack declaring the hook means no hook**: `createModDispatch` returns `null`, `Network` receives neither option, and
`onFrame` behaves byte-for-byte as before (no object built, no listener, no log line). The three real example packs in
`docs/examples/` are the fixture for that claim — their (empty) hook set is installed and the resulting frame sequence
is compared against a `Network` with no hook code at all.

#### 28.13.2 The read-only routes, and how narrow they stay

`pack.json.routes` is resolved once per process (`server/http/workshop.js workshopRoutesFor`) into declared path →
file + cache policy, and served from `server/http/static.js` **before** the core mounts. The decisions:

* **Only an exact declared path is answered.** Traversal is therefore not a check that can be got wrong: `..` cannot
  build a key that is not in the map. The declaration side is judged twice (shape layer and serving side), because the
  serving side may read a hand-built loader object or a pack written against an older schema.
* **`.json` only, and only GET / HEAD.** `.js` / `.html` are refused again here for the same reason `/workshop-assets`
  refuses them — this channel is data, not code. Other methods never reach this code (`server/http/routes.js` answers
  405 with `Allow: GET, HEAD`).
* **`cache` maps to `Cache-Control`**: `no-cache` → `no-cache`, `no-store` → `no-store`, `public` →
  `public, max-age=86400` (the same policy the pack's own art carries).
* **The core mount wins at a path the core really serves (since 0.15.2).** This used to read the other way round — "a
  declared path wins over a core file at the same path, on purpose", the `server/http/static.js` stance that a declared
  path *is* that path. `static.js` still asks this table before the core mounts, but `workshopRoutesFor` now judges
  every declaration with the **same** core reserved table the dynamic channel uses (`coreRouteShadow` in
  `server/http/routeMount.js`, §28.35): a declaration that would shadow a path the engine really serves is **dropped
  from the map**, so the core mount answers exactly as if the pack had declared nothing. The pack is **not** refused
  (a published pack carrying such a declaration still installs and runs, only that one declaration stops taking
  effect) and the drop is **named twice**, never silent: one `errors` entry on the load report and one `log.warn` line
  at startup.
  The test is deliberately **a real collision, not "it uses the word `/data`"**: `coreRouteShadow` first asks whether
  the engine would really serve that exact path (the file exists verbatim under `dataDir` / `sharedDir` / `simDir` /
  `publicDir`, or the path is one of the engine's constant endpoints), and only then is it a shadow. A declaration that
  merely sits inside a core namespace with no core file under it keeps working and is **not** reported — one live
  published pack is exactly that shape (`ws-compression-reference` declares `/data/ws-compression.json` and `data/`
  has no such file), and reporting every such declaration would drown the one that matters. The good side effect: on
  the day the core really grows `data/ws-compression.json`, that very declaration yields to it with no rule change.
* **`RESERVED_ROUTE_PREFIXES` is the one table** (re-exported from `server/http/routeMount.js`): split into
  `CORE_ROUTE_EXACT` (constant endpoints, matched literally — `/healthz` is a path, not a tree) and
  `CORE_ROUTE_PREFIXES` (namespaces, matched by prefix). `test/modRoutes.test.js` pins the union and that both
  channels read it.
* **A declared route whose file is missing still answers 404** instead of silently falling through to whatever the
  core static mount happens to have at that path (that is why the route stays in the map, with a warning naming the
  missing file). That half is unchanged and is the converse of "the core wins": the pack that **owns** a path must not
  silently serve the core's file at it.
* **Two packs, one path**: the smaller pack id wins (DESIGN §28.3's rule, the same one the data overlay and the kit
  loader use) and the loser is reported.

#### 28.13.3 A declaration that cannot be used refuses the whole pack

**One rule, three groups, and it is stated once here because all three are judged by it.** A段 fixed the shapes;
B1段解下了 `server.preDispatch` 的行为但只拒那个钩子; B2段为 `client` 立了这条纪律; **B3a 段把 `server.preDispatch`
对齐过来，并把 `assets` 也纳入**:

> **A declaration that cannot be used refuses the entire pack.** "The pack still loads, that capability just did not
> take effect" is not an accepted outcome.

Why the difference is not a preference. A refused hook leaves the pack's *content* intact and the loss is invisible
where it happens (an entry message is not gated — the player is simply let in, and the operator believes a gate is
shut). A refused panel does not: the author wrote "my pack has an interface", the server hashed that sentence into the
pack's identity, the pack still applies its data, and the browser shows nothing at all. A refused container is the
same shape of lie one layer down: the pack says "my resources are here", the server serves a 404, and the client's
import flow fails for a reason no operator can see. All three are exactly the silent-degradation class this whole
section exists to remove, and all three are worse than a missing pack, because a missing pack is a visible absence.

What is judged, per group, and where:

* **`client.panels`** — at load (`server/workshop.js panelModuleIssues`, called from `loadWorkshop` before the pack is
  listed): the declared `module` must be a readable file **inside the pack**, must be a `.js`, and must resolve inside
  its own directory. Failure is `CLIENT_BAD_PANEL_MODULE` and the pack does not appear in `loaded.packs` at all.
* **`server.preDispatch`** — at load (`server/workshop.js preDispatchIssues`, same place): `module` and `policy` must
  resolve inside the pack and be readable files, `policy` must parse as a JSON object, and every `intercepts` entry must
  exist in the protocol **this server actually runs**. The codes are B1's own names (`PREDISPATCH_BAD_PATH` /
  `PREDISPATCH_BAD_MODULE` / `PREDISPATCH_BAD_POLICY` / `PREDISPATCH_UNKNOWN_TYPE`), so an author sees the same word in
  the editor and in the boot log. **B1 refused only the hook and let the pack load; that is what B3a changed**, and the
  reason is the one above: "the pack is installed, the admission gate is not" is the exact failure this rule exists to
  forbid.
* **`assets`** — at load (`server/workshop.js assetsIssues`, same place): `container` and `manifest` must resolve inside
  the pack and be readable files. Failure keeps the **shape layer's** names (`ASSETS_BAD_CONTAINER` /
  `ASSETS_BAD_MANIFEST`) rather than adding a second pair, because all three ways to be wrong there have one repair —
  point `assets.container` at a `.spresources` that is really in the pack — and because B2 already set that precedent
  for `.js`. In the editor, for both groups, is where they are named: §28.12's "the editor cannot pass what the loader
  refuses".
* **The serving side** (`server/http/workshop.js workshopResourceFilesFor` / `workshopPanelFilesFor` +
  `static.js`): only a registered URL is answered, and only a declared path ever enters those maps. Defence in depth,
  because the serving side may read a hand-built loader object or a pack written against an older schema (the same
  reason `workshopRoutesFor` re-judges).
* **`i18n`** (B5 段, `server/workshop.js i18nIssues`, same place): every declared language file must resolve inside the
  pack, parse as a JSON object, and hold only string values under keys that are not `_meta`'s. The merge and the
  judgement are **the same function** (`shared/workshop.js mergeWorkshopI18n`), so the serving side cannot meet a value
  the loader cleared and then drop it. Codes: `I18N_BAD_FILE` / `I18N_BAD_LANG` / `I18N_SOURCE_LANG` / `I18N_BAD_VALUE` /
  `I18N_BAD_KEY`. The reason this one matters more than it looks: a skipped translation file shows the player a string in
  the wrong language, which nobody will ever trace back to a pack.
* **On the client** (`public/js/ui/extensions.js`): an unknown `slot`, a module without `mount`, a `gate` that names no
  store path, and a required browser capability this browser lacks are each refused **by name**, and the capability case
  is also said out loud to the player. The one judgement the server cannot make is the gate (the client store is the
  client's truth) and the browser's capabilities; those are the client's half of the same rule.

**The hole this rule had, and the three things that now live in it.** `loadWorkshop` is **synchronous** —
`server/data.js` calls it while building the overlay — and `import()` is not. So three judgements about
`server.preDispatch` stay in `loadWorkshopHooks`, which runs on packs the loader already cleared: a module that fails to
import, a module whose factory export is missing or not a function, and a module that exports the optional
`validatePolicy(policy)` and **refuses its own policy**.

The first two kept their B1 names and their warning and the pack stayed loaded — which is exactly the failure this
section keeps naming, so **B4 closed it**: `server/index.js` feeds `loadWorkshopHooks`' errors to
`dropUnavailablePreDispatchPacks` **before anything derived runs** (the data overlay, the identity list, kits, panels,
the resource tables, Lobby and Network all read the trimmed array, and `server/data.js` takes the same trim as
`excludePacks`), so an unavailable hook now costs the pack its place in the loaded set. The third one is the same
refusal, one step earlier: the *inner* shape of a policy file is the hook's own dialect (`version`, `files`, …), which
the loader cannot know, so the module is the only thing that can judge it — and `validatePolicy` is that judgement,
reaching the same end state (`PREDISPATCH_BAD_POLICY`, pack dropped) as "the policy is not a JSON object" does. A
verdict the loader does not recognise (a typo like `{ valid: false }`) is a refusal too, never a silent pass: load time
is where loud refusal belongs.

What remains is only the window, not a judgement: one `stat` wide (the file changed between the two calls), or a
hand-built loader object. It is recorded here so the next reader knows it was a decision, not an oversight. Everything
else about the hook — including "the file it names is not there", the case that actually happens — is refused at load.

**What this costs an existing pack: nothing.** The rule only fires for a pack that declares `client.panels`,
`server.preDispatch` or `assets`, and no pack in this repository (nor any of the three community mods) declares them —
which is why the three example packs in `docs/examples/` keep their hashes and their parse results byte for byte
(`test/packAssets.test.js`). The fixtures that did declare one without shipping its files (`onlyAssets`, `assetsA`,
`assetsB`, `onlyServer`) now ship them: a declaration whose file is missing was legal for exactly one commit per group,
while that group was declaration-only.

#### 28.13.4 The resource container and the 412 policy (B3a 段)

`pack.json.assets` is resolved once per process into a **two-entry map per pack** and served from
`server/http/static.js`. The decisions, each with the alternative it rejected:

* **A prefix of its own: `/workshop-resources/<pack>/<declared path>`.** It was tempting to hang the container off
  `/workshop-assets/`, which already serves a pack's own files — but that route serves a pack's MEDIA under an
  extension allowlist and knows nothing outside it, while `assets.container` is a `.spresources` at the pack's ROOT and
  no allowlist covers it. Widening the media route would have traded one narrow rule for two loose ones. The new map
  holds **two URLs per pack**, built from the loaded packs exactly like `workshopPanelFilesFor`, so traversal is not a
  check that can be got wrong: `..` cannot build a key that is absent. Unregistered / traversal / not-in-the-declaration
  are all **404** (`/workshop-panels/` discipline, one route over). The `?v=<hash12>` suffix is the cache key — a
  repack is a new URL, so `Cache-Control: no-cache` is enough and a deploy still reaches an open tab.
* **Streamed, never buffered.** A container reaches hundreds of megabytes (the reference pack's own sample is
  ~791 MiB), so it goes out through `fs.createReadStream` + `pipeline`, and `Content-Length` comes from the `stat` the
  route already did. `test/modAssets.test.js` pins this by instrumenting `fs.createReadStream`: a `readFile` on that
  path would put the whole pack in the server's memory, which is the one thing this route must not do. The response
  also carries `X-SP-Resource-Sha256` — the digest the loader verified, not a second hashing pass.
* **`verify` is checked at load, and failing it refuses the pack.** The digest comes from the sidecar
  `<container>.<verify>` (the reference pack's format: `<64 hex><whitespace><name>`), and the container is hashed with
  the same streaming reader. A mismatch is `ASSETS_VERIFY_FAILED`, a missing or unparsable sidecar is
  `ASSETS_VERIFY_UNAVAILABLE`, and both refuse the whole pack — a "verified but we served it anyway" resource pack is
  the failure mode this field exists to prevent. Hashing once at load also means the serving side never hashes at all.
* **`serverPolicy` is process-wide, and only a pack can turn it on.** `serve` is the default and every pack in this
  repository declares it (which is the same as not declaring it): with `serve`, `static.js` behaves byte for byte as it
  did before this section. `cache-only` makes `/assets/` and `/fonts/` answer **412 and never touch the file system** —
  short-circuited before the mount lookup, because answering from disk once would mean the policy does not exist. There
  is no environment variable and no global flag: the only thing that can make a deployment cache-only is a `pack.json`.
  The consequence nobody should discover by accident is that those two trees are **shared by every pack and by the
  core game**, so one pack declaring it changes what the whole server serves. It is therefore said out loud once at
  boot, naming the pack(s) that asked for it, and the reference implementation of the mod says the same thing
  (`_up/mod4-pack`, gap ⑥).
* **The client half is §28.13.5, not here.** Serving the bytes and refusing to serve them are decidable on their own, so
  they landed first; what the browser does with a container it has — import it into `CacheStorage`, answer `/assets/…`
  from it, and answer **412, never the origin**, when it has nothing — is the Service Worker half, and it waited on the
  owner's ruling about a pack registering a root-scope worker (`_up/mod4-resource-pack-recon.md` §8.2 lists the models).

#### 28.13.5 The Service Worker is the engine's, and the pack only declares (B4 段)

**The ruling (owner, 2026-10-10).** `_up/mod4-resource-pack-recon.md` §8.2 put three models on the table (a pack ships
the worker; the engine ships it and the pack declares; no worker at all) and the owner picked the middle one:
**the Service Worker is engine code, and a pack only declares `assets`.** The reason is a capability argument, not
taste: a root-scope worker intercepts **every** request of the site, so letting a pack supply the `.js` that registers
it hands over client-side control — the pack could serve, rewrite or swallow anything. A pack's `assets` declaration
therefore stays exactly the four fields A 段 defined; there is no field for a worker URL, and the shape layer has no
seam to add one (`ASSETS_UNKNOWN_FIELD` names any fifth key).

**What the engine ships.** `public/resource-sw.js` (the only worker script in the tree) plus
`public/js/resources/{common,service,bundle,verify,worker,host}.js`. Registration is engine-owned
(`resources/worker.js`) and its five parameters are pinned in `test/modAssets.test.js` with a fake
`navigator.serviceWorker`:

* `type: 'module'` — the worker and the page share `public/js/resources/common.js`, and that module takes the audio
  extension list straight from `shared/media.js` (`public/js/resources/common.js` imports it) so there is exactly one
  copy of it in the repository;
* `scope: '/'` — root scope, which the reference implementation also used. The script sits at the **site root**
  (`/resource-sw.js`), so `/` is already its maximum scope and **no `Service-Worker-Allowed` header is needed**; the
  test asserts the header stays absent and `docs/DEPLOY.md` records the one case that would change it (moving the file
  into a subdirectory, e.g. behind a reverse proxy that serves the app under a prefix);
* `updateViaCache: 'none'` — the worker script is never taken from the HTTP cache, so a deploy reaches an open tab.
  `server/http/files.js` already answers `.js` with `no-cache`; this is the second lock.

**The client flow, and what each step refuses.** `welcome.modAssets` (the same shape of "only readers add it" as
`modPanels`) carries, per declaring pack: the two registered URLs, the container digest the loader verified against the
bytes, and the two normalized policy values. `host.js` turns that into a five-step flow — fetch the manifest
(`validateManifest`, then `version === sha256(compact files)[0:12]`), fetch or accept the container
(`fetchContainer` / an `<input type=file>` `File`; both are just `Blob`-shaped, so the sequential reader is one
implementation), check the container's embedded manifest against the served one entry by entry (url / size / hash /
tier, **and order**, because the order is the body order), verify every file's `SHA-1[0:12]` while writing it into the
cache with `X-SP-Resource: 1` and `X-SP-Resource-Hash`, then shallow or deep verify.

* **Two synthetic cache entries, not a compiled-in pin.** The reference implementation pinned the version in
  `pack-config.js` and checked a global receipt. That cannot express several declaring packs, so the index
  (`URL → sha1[0:12]`, the worker's allowlist **and** expected digest) and the receipt (per pack: which container
  digest, which manifest version, how many files) are ordinary entries in the same cache. The worker serves a key only
  if the index vouches for it **and** the cached response's own hash header agrees; anything else is 412. That is what
  makes "a stale entry from the previous manifest is not served" a property of the lookup rather than a cleanup job.
* **412 is the only failure answer, and the origin is never a fallback.** Returning `null`/`undefined` from the
  `fetch` handler is what "let the network answer" looks like, so the test asserts the handler returns a `Response` for
  **every** resource path, including the misses, and 412 carries `Cache-Control: no-store`. This is the other half of
  B3a's `serverPolicy: "cache-only"`: the server refuses `/assets` and `/fonts`, and the worker answers those same URLs
  from locally verified bytes or not at all.
* **Three behaviours of the reference implementation are kept verbatim, because they are its real value.** The
  extension-less audio route (`/media/bgm/act1` → `/assets/audio/bgm/act1.mp3`, candidates in `shared/media.js` order),
  the `%5B` spelling equivalence (the board-art loader uses `encodeURI`, which escapes brackets, while the importer
  preserves them — the same file has two spellings and both must hit), and Range support (a cached full response
  answers a byte range with 206, 416 when unsatisfiable, because media elements seek and Safari refuses without it).
* **The whole-container digest check is opt-in and says so.** `assetsDigest` is what ties the imported bytes to the
  container the server verified, but `crypto.subtle.digest` has no streaming interface, so checking it means holding
  the whole container in memory — exactly what the import path avoids. `verify.js verifyContainerBytes` therefore
  refuses above `maxBytes` and returns `{ checked: false, reason: 'too-large' }`: an honest "I did not check" beats a
  green light that was never earned.
* **The entry gate is the pack's panel, not the engine.** Whether an import counts as "ready" (shallow or deep, may an
  older cache do) is a policy the pack's C-layer panel owns, and B2 already gave panels exactly one write —
  `ctx.session.setPreload({ required, ready })`, which is the only thing `selectRoute` reads as a second condition.
  Both flags default to `false`, so a server whose packs declare nothing has an inert gate. The engine reports the
  verdict (`importAndVerify` returns `valid` / `missing`) and never touches the flags: an engine that closed the gate
  would make a pack that declares `assets` and no panel unplayable.
* **A failed verification revokes the index, not just the receipt.** `importAndVerify` re-verifies what it just wrote;
  on failure it drops the pack's receipt **and** its URLs from the index, because the worker reads the index — dropping
  only the receipt would leave a pack whose bytes are known to be wrong still being served (their headers are
  unchanged, so every check the worker makes would pass).

**The invariant, and why it is structural here.** "No pack declares `assets` ⇒ no field, no request, no DOM, no global"
is not enforced by an `if` in the page: `public/js/main.js` only `import`s `resources/host.js` **when the field
arrives**, so a server with no declaring pack never loads the flow, never registers the worker, and never fetches a
single engine resource module. The server side is the same statement one level up: `welcomeInfo` spreads `modAssets`
only when the list is non-empty, exactly like `modPanels`, and `test/modAssets.test.js` compares the two welcome frames
field-set-for-field-set.

**The container digest joins the pack's identity.** `assetsIssues` already hashes the container against the declared
sidecar while gating the pack, so `identifyPack` now takes that digest and adds one entry to the hash manifest —
`assets.container.sha256`, whose `hash` field **is** the container's sha256 (there are no separate bytes at that path
to hash). The path is synthetic and unreachable by a real file: the only paths that enter that list are `pack.json`,
`<content>.json`, `kits/*.js`, `assets/**` and declared panel modules (which must be `.js`). The payoff is the sentence
this section exists for: **the same room digest now implies the same container** — re-packing a container changes the
pack's content hash, which moves `modSetOf`'s wire digest, which the room gate already compares. The cost is bounded
and pinned: a pack that declares no `assets` gains no entry and keeps its bytes, so the three shipped example packs
still hash to `96ebc2d4…` / `15092019…` / `77b80c6e…` and the set digest is still `eacd0485…` (both re-asserted in
`test/modAssets.test.js`, next to the stricter pre-existing pins in `test/packAssets.test.js`).

**The last hole in §28.13.3, and the shape of the fix.** B3a moved every *filesystem* judgement into `loadWorkshop`, so
a declaration whose files are missing refuses the whole pack. Two judgements cannot go there: "does the module import"
and "does it export `createPreDispatch`" need a dynamic `import`, and `loadWorkshop` is synchronous (`server/data.js`
calls it while building the overlay, and a dozen tools and tests call it synchronously). B4 therefore does the pruning
where it can be done — on the **startup assembly path** — and does it in one place:
`server/index.js` runs `loadWorkshop` → `loadWorkshopHooks` → `dropUnavailablePreDispatchPacks` before anything derived
from the loaded packs exists, so the pruned array feeds the data overlay, the identity list, the kit loader, the panel
registry and the resource tables alike. Two details are load-bearing:

* **`loadData` had to be told.** The 创意工坊 overlay is merged inside `server/data.js` (before `deepFreeze`), i.e.
  before that point in the assembly order. Without passing the excluded ids down (`excludePacks`), a dropped pack's
  `chess.json` would still be merged: the pack would be absent from `welcome.mods`, its kits, panels and resources
  unserved, and its operator present in the game data — the half-loaded state this rule exists to forbid. So the async
  verdict is computed first and handed to the loader. `test/modAssets.test.js` asserts exactly that: three packs whose
  hook modules cannot be installed produce no `[data]` contribution and no identity entry, while a good hook next to
  them is untouched.
* **The report names the pack and the code.** Every removal appends `PREDISPATCH_BAD_MODULE: …` to the loader's error
  list (so `/healthz` and the boot summary keep telling one story) and the boot prints one line naming all of them:
  `dropped N pack(s) whose declared server.preDispatch cannot be installed: "x" (PREDISPATCH_BAD_MODULE), …`.

**What this section does not decide, and what is not verified.** The editor's graphical entry points for the four
fields are still open, and the reference mod's rewritten pack still lives in `_up/` rather than in a release. The
browser path is **not verified**: this machine has no Chrome, so the real worker lifecycle and scope, real `caches`
quota behaviour, a real `<input type=file>` `File`, the panel module's real `import()` and the rendered UI are written
as **skipped placeholders** in `test/modAssets.test.js` §10 and are recorded as unresolved in the B4 report. Everything
decidable without a browser is exercised for real in Node against a fake `CacheStorage` but real `Response`,
`Request`, `Headers` and `crypto.subtle` — including the container byte-for-byte agreement between this repository's
writer, the reference writer and both parsers.

#### 28.13.6 `i18n`: adding strings to an existing language (B5 段)

**The gap was structural, not a configuration.** The `packs/` language type ("lang", `shared/packs.js` /
`docs/PACKS.md`) can only ADD a language: a single-file pack is `public/i18n/<code>.json`, one pack per language, and the
scanner reports the second one as skipped — the exact string, measured against the real scanner, is
`the language en is already provided by public/i18n/en.json`. Measured the other way: the same fixture renamed to a new
language (`pt`) registers normally as `quickchat-pt … 1 strings`. So "new language: yes; add 74 strings to `en`: no",
and it is precisely the second thing any pack with a new interface needs (all four community-mod payloads that touch the
interface need it). Before B5 an `i18n` key in `pack.json` was not even read: the normalized manifest had no such key.

**Shape.** `i18n: { "<lang code>": "<pack-relative .json>" }`. The code must be canonical
(`shared/i18nPacks.js canonicalLang`: `en`, `ja`, `ko`, `zh-TW`, `pt-BR`) and never `zh`, which is the source language —
the msgids themselves have no file to add to. The value is a `.json` file **inside the pack**, whose contents are the
same `{ "<Chinese msgid>": "<translation>" }` shape as `public/i18n/<code>.json`. A path rather than an inline object,
for one reason: an inline map of 4 × 74 entries would put the whole translation inside a single string of the normalized
manifest, while a path can be **hashed as its own file** — which is what happens (`identifyPack`, same rule as
`client.panels[*].module`: bytes that change what the player sees belong to the identity).

**The merge rule, and why it is "never overwrite".** The pack's entries are merged onto the existing file:

1. **An existing msgid keeps the existing translation.** These patches come from machine translations and from old
   official files: the real plugin-pack data has exactly one key of its 74 that this repository already has
   (`语音语言`), and its `en` value is `Voice language` against our `Voice Language` — while its `ja` / `ko` / `zh-TW`
   values are identical to ours. Letting a pack win there is letting a pack quietly edit published interface text.
2. **Every difference is reported by name**: key + language + pack id + both values
   (`[workshop] i18n en "语音语言": kept the existing translation (pack "quickchat" wanted "Voice language")`). An
   overlap whose value is *identical* is not a conflict and does not enter the report — otherwise the one entry that
   needs a decision drowns in 73 that do not; the report counts them separately instead.
3. **Values must be strings.** A non-string is refused with the pack (`I18N_BAD_VALUE`), because `t()` would print the
   raw value into the interface — a fault with no visible link back to the pack.

**Serving.** The client has always fetched `/i18n/<code>.json` (`public/js/ui/lang.js`); a pack's entries are merged into
that response (`server/http/workshop.js buildWorkshopI18nFiles` → `static.js`), so `public/i18n/*.json` is never
rewritten — the same stance the `/data/*.json` overlay takes. A language no pack touches is not in the map and is served
from disk byte for byte.

**What it does not do.** `data/i18n/<code>.json` (the game texts, a different file family) is out of scope, and
`tools/i18n.mjs check` still does not flag a msgid a pack declares and the code never uses. Both are recorded as open in
the B5 report rather than implied by the field's existence.

### 28.14 `server.modules`: the server-module payload (implemented)

**The defect, as the community pack states it.** Three of its files — `server/ops.js` (shutdown announcement + a snapshot
archive under `var/state`), `server/stats.js` (anonymous match/emote counters under `var/stats`) and `server/healthz.js`
(three extra fields on `/healthz`) — cannot be expressed by any declaration this layer has. Each is the exact opposite of
what §28.4 requires of a kit ("no file system, no network"): they write files, mount a startup hook and extend an
existing HTTP endpoint. Today the only way to ship them is to **hand-patch engine files**, which is what the pack's own
`② 共享层补丁` folder does.

**The ruling.** A new payload class beside `kits/`, with security coming from *granting only what was declared* rather
than from banning things:

- **`uses` is a closed enum of mount points** — `boot`, `shutdown`, `healthz`, `matchClass` — and the host object a
  module receives exposes exactly those. An undeclared one **throws by name** (`MODULE_USE_UNDECLARED`) instead of being
  `undefined`: an `undefined` is a `TypeError: not a function` the author cannot tell apart from a typo.
- **Writing is a separate bit** (`"write": true`) and grants `host.io`, scoped to `<state root>/mod/<pack id>/`
  (`SP_STATE_DIR`, else `<repo>/var`). The pack's own directory stays read-only and the engine's directories are not in
  the facade at all: `..` and absolute paths are refused (`MODULE_IO_BAD_PATH`), and the directory is created on the
  first write so a module that declares `write` and never writes leaves nothing on disk.
- **`healthz` callbacks are bounded**: a flat object of scalars, at most 12 fields / 2 KB, grouped under
  `modHealth["<pack id>"]` so two packs cannot overwrite each other's fields. A callback that throws, returns a nested
  object or overflows is **named and skipped** while the others still report — the endpoint is for operators, not a data
  channel.
- **`matchClass` is the only mount point that can reach a match**, so it alone requires `combat: true`
  (`MODULES_NEED_COMBAT`): a `MatchClass` wrapper can in principle change a result, and "a pack that can change a result
  declares it" is the owner's ruling. `boot` / `shutdown` / `healthz` / `metrics` / `route` cannot, and do not need it
  (§28.31 / §28.32: one hands back a frozen scalar snapshot, the other answers a read-only GET). The layer derivation
  counts such a pack as **B**, while `combat`'s *derived* value still looks only at `kits/`.

**Where it is enforced.** The declaration is `shared/workshop.js parseServerModulesDecl` (shape, closed enums, caps:
8 modules per pack, ids unique, `entry` a pack-relative `.mjs`); the file's presence is judged in the load gate
(`server/workshop.js serverModuleIssues`); the import, the `registerServer(host)` export and the mount points themselves
are judged on the startup path (`server/modModules.js`), and a module that fails **takes its whole pack out of the loaded
set** — the same prune point `server.preDispatch` and `server.meta` use. Module bytes enter the content hash, exactly
like `kits/`, panel modules and meta modules.

**The source scan is now real (2026-10-11, bug fix).** This surface's `requires` has promised "a static determinism scan
(no `process` / `require` / `eval`)" since it was written, and until this batch the loader only checked that the file was
readable before `import()`-ing it into the server's own process (`server/modModules.js`). The same three sites that *did*
have the scan (`server/match/metaPack.js`, `server/battlePack.js`, `server/roomPack.js`) are the template:
`serverModuleSourceIssues` runs `stripComments` + `mentionsIdentifier` over the source **before** the import and returns
one `{ code: 'MODULES_BAD_SOURCE', reason }` per hit. The table it reads is `SERVER_CODE_FORBIDDEN_GLOBALS`
(`process` / `globalThis` / `require` / `eval` / `new Function`) **minus `globalThis`** — the promise names exactly
`process` / `require` / `eval`, and this repository already contains a *working* `server.modules` module that uses plain
`globalThis` to talk to an in-process test (`test/packMatchMsg.test.js`), so banning it would prune a legitimate pack
(the owner's rule: measure first, and if a real pack would be rejected, narrow the rule rather than force it). It is a
heuristic, not a sandbox: `globalThis['pro'+'cess']` slips past this scan exactly as it slips past the other three.
`KIT_FORBIDDEN_GLOBALS` (clocks, randomness, DOM, timers) is **deliberately not applied**:
`boot` / `shutdown` / `healthz` / `metrics` / `route` all run outside the match loop, so a snapshot module stamping
`Date.now()` is legitimate, and the one mount point that does run inside a match (`matchClass`) already carries
`combat: true` and the digest/golden gate. An author who needs a process reading has a sanctioned replacement —
`host.metrics` — and the refusal text names it, so the refusal is not a dead end.

**Two deliberate asymmetries, recorded rather than implied:**

- **Server modules are process-wide, not per-room.** `boot` / `shutdown` are process events by nature, and so is
  `/healthz`. `matchClass` wraps the class the *Lobby* hands to every match. So unlike `server.meta`, a room's declared
  set does not select them — a server-module pack is a property of the installation, which is what the three real
  modules are.
- **One message-driven hook, and no mount point a pack can invent.** Exactly one of the mounts is driven by traffic:
  the `matchClass` wrapper's `handlePackMsg` (below), the owner's ruling of 2026-10-10. `uses` is a closed enum
  (`SERVER_MODULE_USES`) — a name this layer does not know is `MODULES_BAD_USES`, so a pack can never name a seventh
  thing into existence.

  **This paragraph used to end with "a fifth mount point is still not something a pack can name", and that sentence is
  now false.** The owner's ruling of 2026-10-11 (`route` / metrics: "做，实在做不到就算了") added two mount points, and
  the reason the old sentence could be dropped is not that the rule was relaxed — it is that the *shape* of the new
  mount points makes the danger the old sentence was guarding against structurally impossible:

  | mount | what it hands over | why it cannot reach a core path / a match |
  |---|---|---|
  | `metrics` (§28.31) | a **deep-frozen object of scalars** (`uptimeSec`, `rss`, `heapUsed`, `elu`, `loopP*`, `sampleAgeMs`, `state`) | it is a *value*, not a handle: no `process`, no histogram, no timer, no function. A read cannot change a result |
  | `route` (§28.32) | a synchronous callback answering a JSON value | the path **must** live under `/mod/<pack id>/…`, a namespace the engine reserves for exactly this; `GET`/`HEAD` only; `no-store`/`no-cache` only; bounded body. A pack has no position to name `/data/support.json`, so the "core reserved path table" is the second line of defence rather than the first |

  The static `pack.json.routes` channel (§28.13.2) also asks this same reserved table before it mounts anything, so a
  declaration can no longer shadow a core path either — but it asks a **narrower** question than the dynamic channel's
  prefix test: it requires a real collision (a file the core would actually serve at that exact path), which is what
  keeps a published pack declaring `/data/<its own name>.json` working. The dynamic channel stays strict by prefix:
  no `host.route` may fall inside a core reserved namespace at all. Both read the one table, so widening it moves both.

**The one trigger: `handlePackMsg(playerId, msg)` on the `matchClass` subclass.** `pack.msg` is handled by the Lobby
(`Lobby.packMsg`): it validates the declaration, rate-limits the session and forwards to the room's seats and
spectators. It never reaches `Match.handle` — `routeGame` only lets `g.*` through. So the Lobby calls the optional hook
once per **accepted** message, **after the rate limit and before the fan-out**:

- **What it may write: nothing new is granted and nothing new is forbidden.** The hook is ordinary code on a
  `MatchClass` subclass, and such a subclass already holds the whole Match (economy, board, `emit`): A adds *when it is
  called*, not *what it may touch*. A pack that declares `matchClass` already declares `combat: true`
  (`MODULES_NEED_COMBAT`), which is exactly what the room digest and the golden corpus gate on — so A adds no
  `pack.json` field, no second gate, and does not move `MOD_API_VERSION`.
- **Replay: server-authoritative match state, never a battle golden.** `pack.msg` is not a type the deterministic
  replay records (the seed-driven battle and `g.*` intents are), so whatever the hook writes into the match is not
  replayed and is not part of `test/golden/*` — A moves no golden scenario.
- **Failure has no transaction.** The call goes through `callMatch`, whose `try`/`catch` logs one line naming the
  method (`[lobby] <room code> match.handlePackMsg threw`) and returns `undefined`. That `undefined` is read as **not
  consumed**, so a throwing hook still leaves the fan-out byte-identical: one bad message cannot cut the channel.
- **Return value.** `true` or `{ consumed: true }` means *consumed* — nothing is forwarded (the sender does not get the
  echo either). `false`, `undefined`, any other value, or no such method at all means *not consumed* — forwarded
  exactly as before. `playerId` may be a **spectator**: unlike `room.chat` (`ERR.SPECTATOR`), `pack.msg` has no
  spectator criterion and this change does not add one, so a hook that cares must judge for itself.

### 28.15 `notices`: plain text as a declaration (implemented, server + declaration)

**The gap was a missing product surface first.** The community pack's `public/js/ui/announcementData.js` and
`titlePanels.js` (`CREDITS_TOP` / `CREDITS_REFS` / `CREDITS_LINE`) carry a structured announcement and a credits list.
Neither exists here: there is no announcement carrier at all, no generator, and no panel on the title screen. So the
first half of this section is not a pack feature — it is the carrier itself.

**The engine's half is generated, not written.** Announcements come from `CHANGELOG.md`: `## <version> — <date>` is a
release, its first paragraph is the summary, `### <name>` is a section and `- ` lines are items (indented continuations
join the item above). That is the "one source of truth" stance the pack's own file claimed (`ANNOUNCEMENT_SOURCE =
'CHANGELOG.md'`) and the reason a release note never has to be written twice. Credits are a small list in
`server/notices.js` (this repo, the upstream game, and the rights holders).

**The pack's half is `pack.json.notices`** — `{ announcement?, credits? }`, both pack-relative `.json` paths (a body of
prose belongs in a file that can be hashed and checked, not inline in the manifest):

- `announcement`: `{ version, date, summary, sections: [{ name, items: [string] }] }`;
- `credits`: `[{ name, note?, url? }]` with `url` limited to `https://` (a page that links out must not be able to
  reach a local scheme).

**Merging is append, not overwrite** — deliberately unlike `i18n`: a pack's announcement is *its own* news and its
credits are *its own* attribution, so two packs cannot collide and neither can displace the engine's. The merged body is
bounded (8 announcements, 40 credits, 12 sections × 40 items each); when the cap is hit, the entries dropped are the
**oldest engine ones** — a pack's notice is news the player has not seen, while an old release note is permanently
readable in the changelog.

**Where it is enforced**: shape in `shared/workshop.js parseNoticesDecl`; the files' presence and JSON-ness in the load
gate (`server/notices.js noticesIssues`, wired into `loadWorkshop`, so a pack that declares a notices file it does not
ship is refused whole); the values at merge time, where a bad entry is **named and skipped** without taking the rest of
the pack down (unlike i18n, a bad notice cannot affect anyone else's); the bytes enter the content hash like `i18n`'s
files. The merged body is served over the **existing** merged-data route (`/data/notices.json`), so there is no new
route and no new static path.

**What is not done yet**: the announcement body is single-language (the engine's half is generated from a Chinese
`CHANGELOG.md`). The panel exists (`public/js/ui/notices.js`, title screen) and reads the merged body through the
ordinary data layer; translating pack announcements and engine credits is a `data/i18n/` slice of its own.

### 28.16 A room runs its own set (W-B) and aligning to it (W-D)

§28.9 declared a room's set and shipped it to the clients; by its own words it did **not** decide anything — every room
still ran the process data, the process kits and the process `server.meta` modules, and this section is the cut that
makes the declaration true. `server/roomAssets.js` is the whole mechanism:

- `createRoomAssets({ official, processData, packs, kits, kitOwners, modules })` → `forRoom(Room.modSet)`:
  - **No set, an empty set, or the whole set ⇒ object identity** with the process data, the process kit map and the
    process module list. So "a room that declares nothing is byte-identical to before" is an assertable **identity**, not
    a promise, and it is the path every room of a plain install takes.
  - **A subset ⇒ materialised**: `applyWorkshop(official, chosen)` over a **pack-free official load**
    (`loadData(dir, { workshopDir: null })` — anything else would already carry the other packs), kits filtered by the
    owner map `loadWorkshopKits` returns, kit modules filtered by pack. The result is deep-frozen (the same rule as
    `server/data.js`) and cached **per digest**, so two rooms declaring the same set share one materialisation instead of
    merging per match.
- `Lobby.create` materialises as soon as a room declares a set (that is also what gives the face below something to
  answer), and `Lobby.startMatch` takes the room's `data`, `workshopKits` and `workshopKitModules` from it. The
  `server.meta` modules are filtered to the room's packs too; `Match.mods` — the identity every BattleSpec carries — is
  the **room's** digest, not the process's.
- **The two bypass singletons.** `Match opts.data` was already per match and the sim's record layer (`sim/simdata.js`)
  already took it, but the record tables the content helpers read (bonds / items / bands / garrisons / effects)
  went through `sim/content/support/index.js gameData()` — on Node, `server/data.js getData()`, i.e. **every installed
  pack**. Now `DataSource` carries the whole data object it was built from (`source`) and `Battle` pushes it around its
  SYNCHRONOUS entry points (`withGameData`: construction, `start`, `step`, `runToEnd`, `forceEnd`, `result`). It is a
  stack rather than a global set/restore for the reason §29 already gives about the meta registry: two matches run
  concurrently in one process and can only interleave **between** steps, never inside one. Outside a battle the default
  data is unchanged (identity), and a scoped object is merged **flat** over it, so a partial data object (every test that
  hands a battle a few tables) behaves exactly as it did for the tables it does not carry. `coreBondIds()` is cached per
  data object.
- **The face**: `/room-data/<digest>/<file>.json` serves the materialised data of a digest a room really declared, with
  `/data/`'s file whitelist. An unregistered digest or file name is a 404 — a client cannot make the server merge a
  combination no room declared, and the number of caches stays bounded by the number of rooms. `/data/*.json` keeps
  serving "official + every installed pack", unchanged.
- **The entry gate is still the process set**, on purpose (§28.9): a joiner cannot know the room's set before it is in
  the room, so `room.join` proves "same catalogue, same pack bytes", `room.state.mods` tells members and spectators what
  the room runs, and aligning to that set is the client's job before it readies up (W-D): the room cannot start with an
  unready member, and a spectator is never asked to ready.
- **W-D, the client's half** (`public/js/mods/align.js`): `planAlignment` answers 「do the bytes on THIS client rebuild
  every pack the room declared」 by re-hashing the stored files against the catalogue (`localPackHash(...,
  { verifyBytes: true })` — a corrupted cache entry is not "I have this pack"), `alignRoom` downloads exactly the room's
  packs (never the others the server carries) and re-asks, and `roomDataBase` is the one rule for which face a battle
  simulates on: `/room-data/<digest>/` when the spec carries a room set that is not the process set, `/data/` otherwise.
  `public/js/battle/runner.js` passes its data face through `dataBaseFor(spec)` and caches the sim **per face**, so a
  page that plays in a subset room and later in a plain one never mixes the two. The room screen shows the set, the
  per-pack state, a 「补齐模组」 button driven by `sync`'s progress events, and **withholds the Ready button** while the
  client is not aligned — the server's own rule stays what it was (a room starts only when every human is ready).
- Asymmetries kept on purpose: `server.modules` stays process-wide (§28.14) and a `matchClass` wrapper still wraps every
  match the process builds. A room's set decides what a **match** runs, not what the **process** boots.

Tests: `test/roomAssets.test.js`.

### 28.17 `server.battle`: a pack's battle-level logic (implemented)

**Why `kits/` is not enough.** §28.12's behaviour layer is one file per operator (`kits/<chessId>.js`): a kit sees its
own unit and the battle through the public API. A real community mod's whole "personality" is not per-operator — its
`bonds/custom.js` (331 lines) and `garrisons/custom.js` (336 lines) say things like *"every member of this bond deals
more damage to enemies that are stunned / bound / immobile"*, *"at 6 distinct members every member gains attack speed
and its attacks carry true damage"*, *"an operator holding both of these items burns controlled enemies in range every
second"*. Those conditions read the player, the whole field and the item combinations — a kit cannot see any of that,
and one file per operator would mean rewriting the mod's 42 operators by hand (gap G-13).

**The declaration is one field.**

```jsonc
"combat": true,                                   // required — a battle installer changes results
"server": { "battle": { "module": "battle/bonds.mjs" } }
```

The module exports `install(battle)` — **the same shape official content uses** (`content/bonds/custom.js` and
friends). Like `server.meta` (§29) the declaration is a hard gate: without `combat: true` the pack is refused whole
(`BATTLE_NEEDS_COMBAT`), because a pack that cannot state that its code changes results must not ship battle logic.
The module's bytes enter the content hash (§28.2) — the same reason kits, panels, `server.meta` and `server.modules`
do: one digest must not describe two behaviours.

**The import surface is a whitelist, and it is a different one from a kit's.** A battle module may import
`@battle/index.js` (the battle content layer's helpers — `num`, `bondRecord`, `buffParams`, `bondActive`, `isMember`,
`playerOps`, `passiveBuff`, `directMods`, `battleStore`, …: the very module the official content modules are built on)
and `@sim/` (three pure helpers). `@kit/`'s tier SDK is deliberately *not* on that list: a battle module is not an
operator kit. One table (`shared/kitImports.js BATTLE_IMPORT_FILES`) feeds both ends — the server rewrites each
whitelisted specifier to a real `file:` URL and loads the module from a `data:` URL, and the browser resolves the same
prefixes through `public/index.html`'s import map, so the pack's source runs **unmodified on both ends**. That is what
makes the two execution paths (the player's browser and the server's re-computation) run literally the same code.

**Determinism, load-time and run-time isolation.** The source is scanned **before any import** with the same two tables
a kit and a `server.meta` module go through (`KIT_FORBIDDEN_GLOBALS` + `SERVER_CODE_FORBIDDEN_GLOBALS`: no
`Math.random` / `Date.now` / `fetch` / `setTimeout`, no `process` / `globalThis` / `require` / `eval`), and an import
outside the whitelist refuses the pack. A module that fails to load, has no `install` export, or whose declaration names
a file that is not in the pack is reported and the **whole pack** leaves the loaded set at the same prune point as
`server.preDispatch` / `server.meta` / `server.modules`. At run time each pack's installer is called **inside its own
`try/catch`** by `server/sim/content/index.js installContent` (reported as `content:pack:<id>`), so one broken pack
cannot take a whole field down — the same isolation kits get per unit.

**How it reaches both ends.** The server passes the real functions to `Match` (`opts.battleInstallers`) and the JSON-safe
URL list (`opts.workshopBattleModules`) into every BattleSpec (`spec.workshopBattle`, the twin of `spec.workshopKits`);
`public/js/battle/runner.js loadSpecBattleInstallers` imports those URLs and hands the result to
`createBattleFromSpec`. `/workshop-battle/<pack>/<path>` serves only URLs the loader registered (the discipline every
pack-scoped route here follows). W-B applies (§28.16): a room that declares a subset assembles only **its** packs'
installers, so "the declared set decides what runs" holds for this payload too.

Tests: `test/packBattle.test.js`.

### 28.18 Pack-relative imports: `./…` inside `kits/`

**The defect §28.12 left behind.** §28.12 opened the engine's library to a pack kit, and that was the half the community
kit `op-clemnt.js` needed — but it is not the half a real pack needs next. The reference community mod ships **one**
`kits/custom.js` of 1138 lines covering many operators, and a pack that wants one file per operator cannot have it:
there is no way to reach a shared helper. The whitelist (`shared/kitImports.js KIT_IMPORT_FILES`) opens engine files
only, and a `@pack/` prefix is **impossible**, not merely absent — the browser resolves prefixes through
`public/index.html`'s import map, a static per-page table that cannot express "one prefix per installed pack" (a pack is
installed after the page was built). So the only form both ends can resolve natively is a **downward relative
specifier**: `./helpers.js`, `./lib/bonds.js`.

**The geometry is the whole design.** A kit on disk is `<packDir>/kits/<id>.js`; the browser fetches it as
`/workshop-kits/<pack>/<id>.js` — the `kits/` segment is **not** in the URL.

| end | base | `./lib/util.js` resolves to | file |
|---|---|---|---|
| server | `file:///<packDir>/kits/<id>.js` | `file:///<packDir>/kits/lib/util.js` | `<packDir>/kits/lib/util.js` |
| browser | `/workshop-kits/<pack>/<id>.js` | `/workshop-kits/<pack>/lib/util.js` | the same file, because the route maps `<pack>/<rel>` back to `<packDir>/kits/<rel>` |

That is why the URL form can be legal at all. And it is exactly why `..` can never be: `../x.js` must walk one level
*out of* `kits/` on disk, while the URL has no `kits/` segment to walk out of — the two ends walk a different number of
levels and always land on different files. `..` therefore stays refused (`kitImportUnavailableReason` says so, naming
`kits/`), and the refusal is arithmetic rather than conservatism. The same reason keeps a `kits/lib/../x.js` form out.

**The verdict is extended, not replaced.** `shared/kitImports.js` gains `isPackRelativeSpecifier()`: a specifier that
starts with `./`, ends with `.js`, has no `..` segment, no backslash, no `%` (any percent-encoding is refused outright —
that is how `%2e%2e` gets in), no NUL, no `?` / `#`, no empty segment (`./`), and is not a bare `x.js`. It feeds both
readers unchanged: `loadWorkshopKits` and `shared/kitAuthoring.js validateKit` still call `kitImportIssues()`, so the
editor cannot pass what the loader refuses (§28.12's property, kept). Every existing refusal keeps its `KIT_IMPORT` code,
and every refusal now ends by naming **both** the whitelist and the new legal form — a refusal that only says "no" is
what makes an author collapse everything back into one file.

**The loader rewrites accepted relative specifiers to real `file:` URLs.** §28.12 loads an importing kit from a `data:`
module, and a `data:` module has no base directory; the same is true of a helper reached *through* a relative specifier,
so the rewrite is done **once per source the loader loads**, against that source's own directory
(`rewriteKitImports`'s new `resolveRelative`). A `kits/_shared.js` and a `kits/<id>.js` therefore get different answers
for the same string — exactly what the browser does (it resolves against the importing module's URL). The rewrite is
still in-memory only: §28.2 hashes the bytes on disk, so the pack digest is unaffected. A kit with **no** import keeps
the real-path fast path byte for byte.

**The route is widened, and only as far as `kits/`.** `/workshop-kits/<pack>/<rel>` used to serve exactly the URLs the
loader registered; it now maps `<pack>/<rel>` to `<packDir>/kits/<rel>`, where `<pack>` must be a **loaded** pack (the
table comes from `loadWorkshop`'s result, §28.3) and the resolved absolute path must be a `.js` regular file under
`<packDir>/kits/`. The discipline is unchanged and explicit: exactly one percent-decode (the request path is already
decoded once before the route sees it, so `%2e%2e` arrives as `..` and is refused as a segment — a second decode is how
`%252e%252e` becomes `..`); empty / `.` / `..` segments and backslashes refused; containment decided by `path.resolve` +
`path.relative`, never by string prefix matching (a prefix test accepts `<packDir>/kits-evil/x.js`); and a non-`.js`
file, an unknown pack, a traversal and a missing file all answer the **same 404 body** — never reveal existence. The
registered kit URLs keep working unchanged. `/workshop-battle/` deliberately does **not** get this treatment: a battle
module is loaded on the server from a `data:` URL (§28.17), where a relative specifier cannot resolve, so the form is
refused for that payload and the route keeps its registration table as the whole of its entry surface (`@battle/` is
what its authors use).

**The identity hash covers every `.js` under `kits/`, recursively.** A shared helper's bytes decide how a battle plays
out exactly like the kit file's do, and the digest is what W-D alignment compares (§28.16: the bytes on a client must
rebuild every pack the room declared). Hashing only `kits/*.js` would let two clients whose `kits/lib/bonds.js` bytes
differ share one digest — the one thing that digest exists to prevent. The manifest path in a **flat** `kits/` directory
is still `kits/<name>`, so no existing pack's hash moves (asserted against the three shipped example packs in
`test/packRelativeImports.test.js`, and cross-checked by `test/packAssets.test.js`'s baseline). `kits/_shared.js` is in
the hash too, for the same reason, while it does **not** count as a kit.

**What counts as a kit stays a fixed, small rule.** A **top-level** `kits/<id>.js` whose basename does not start with
`_`. A subdirectory is not a kit (its files are the ones a kit imports with `./…`), and `kits/_shared.js` is a shared
helper, not an operator called `_shared` — so splitting one large file must not make every fragment a kit. The editor
reports the same rule (`editor/ui/kit.js`), because a rule the loader enforces and the editor does not is a rule the
author learns from a silent failure.

**Still refused**, in one list: `..` in any position; a leading `/`; a bare module name; `require()`; dynamic
`import()`; any `%`, `\`, `?` or `#` inside a relative specifier; a non-`.js` extension; a relative specifier in a
`server.battle` module. What deliberately did not change: the `@kit/` / `@sim/` / `@battle/` whitelist tables, the
determinism scan, the ownership rule, and the pack hash of any pack that does not use the new form.

Tests: `test/packRelativeImports.test.js`; the whitelist and its two readers: `test/kitImports.test.js`,
`test/workshopKits.test.js`.



### 28.19 组件级改写：面板可以包裹或替换一个具名引擎组件

**槽位表达不了「这一屏长得不一样了」。** §28.8 的九个 `[data-mod-slot]` 宿主说的是「插进这个位置」：包在**引擎已经
渲染出来的容器**里画自己的东西。参考社区插件包的十个客户端文件干的是另一件事 —— **整屏重画**，改的是引擎自己那个
组件。所以 C 层补上最后一块：面板除了挂槽位，还可以对引擎的**具名组件**声明 `wrap`（包一层，链条下方那一份作为
`orig` 交给它）或 `replace`（整段换掉）。两者可以同时出现在一个面板上，也可以只改写不挂载。

**声明**（`client.panels[].wraps`，形状层的闭枚举）：

```jsonc
"client": { "panels": [
  { "id": "hud-badge", "slot": "screen.game.hud", "module": "ui/badge.js",
    "wraps": [
      { "component": "game.hud.topBar", "mode": "wrap" },     // 顶栏外面包一层
      { "component": "game.bondStrip", "mode": "replace" }    // 盟约条整段换掉
    ] }
] }
```

三条判据、三个码，全是**整包**级别的拒绝（与 §28.13.3 同一条纪律：一个用不了的声明不许变成「装了但静默不工作」；
与 §28.12 的 import 白名单同一个做法 —— 一份闭枚举，两个读者各判一次）：

| 坏在哪里 | 码 | 判在哪 |
|---|---|---|
| `component` 不在闭枚举里（理由里**列出全部合法 id**） | `CLIENT_WRAP_UNKNOWN_COMPONENT` | 形状层（`shared/workshop.js`）+ 客户端复判 |
| `mode` 不是 `wrap` / `replace`（**缺了也算**，大小写写错也算） | `CLIENT_WRAP_BAD_MODE` | 同上 |
| 不是数组 / 空数组 / 条目不是 `{ component, mode }` / 同一个组件两条 / 条数超过组件数 | `CLIENT_WRAP_BAD_SHAPE` | 同上 |

装载期再补两条：模块 import 不了 = `CLIENT_PANEL_IMPORT_FAILED`（与槽位那条**同一个码**：坏的是这个字段，不是
「在哪一层被发现的」，§28.13.3），模块没有 `wrap` 导出 = `CLIENT_WRAP_NO_EXPORT`，**整个面板**不落地（连它声明的
槽位也不挂）。**声明了 `wraps` 的模块不再必须导出 `mount`**：一个只改写的模块声明一个它用不到的槽位就行（`slot`
仍是闭枚举里的必填项，形状层一个字没改 —— `[ASSUMED]`：让 `slot` 可选会是第二条规则，而这一步要的只是「能改写」）。
`wraps` 只在清单真的写了这个键时才进归一化结果，所以没声明它的包内容哈希**逐字节不变**（§28.2）；声明了的包，
`mode` 不同就是两个摘要。

**注册表：一个组件 id 就是一处 `modComponent(id, impl)`。** 引擎的具名组件渲染**经过**
`public/js/ui/modComponents.js`。每个 id 在自己的文件里登记，今天四个，都是**纯视图**（改不了对局结果 —— 与
「面板不给 store」是同一条边界）：

| id | 实现 | 被谁渲染 |
|---|---|---|
| `game.bondStrip` | `ui/bondStrip.js BondStrip` | 对局 HUD 的盟约条 |
| `game.shopCard` | `ui/shopBar.js ChessCard` | 商店 / 晋升奖励 / 定向投放的每一张干员卡 |
| `game.hud.topBar` | `ui/hud.js TopBar` | 对局 HUD 的顶栏 |
| `loadout.detail` | `ui/detailPanel.js DetailPanel` | 干员详情面板 |

`impl` **就是**今天那份实现；`modComponent` 返回的组件里只有一次查找：

```js
function ModComponent(props) {
  if (!wrapped.has(id)) return impl(props);   // 没有任何包声明 wraps ⇒ 就是今天那一棵 vnode 树
  return renderChain(id, impl, props);
}
```

**没有声明的路径逐字不变**，而且这是结构性的，不是「小心地等价」：`ModComponent(props)` 返回的是 `impl(props)`
**原样的那个 vnode 对象**，props 也**就是**引擎给的那一个（不多一层组件边界、不多一次快照、不多一个 DOM 节点、
不多一次订阅）。没有任何包声明 `wraps` 时 `wrapped` 是空集合，`setComponentWraps` 一次都不会被调用，页面不重画。
`test/modPanelWraps.test.js` 钉的就是这条：返回同一个 vnode、props 同一性、四个空断言（不 import 包模块、不建
DOM、不重画、组件树里没有多出来的那一层）。

**链的次序就是既有面板比较器**（§28.3）：`order` → 包 id → 面板 id。注册点在每次 `apply` 之后按 `panels` 已经排好
的次序重建每个组件的链 —— `panels[0]` 的那一条贴着引擎组件（**内层**），最后一条在**最外面**；与数组次序、发现
次序、加载次序都无关。求值也是确定的：

```js
let rendered = h(impl, props);                    // 链底 = 引擎自己的组件，拿的是这一帧的 props
for (const link of links) {                       // 内层 → 外层
  const below = rendered;
  const out = applyLink(link, link.mode === 'replace' ? null : below, props);
  rendered = out === null ? below : out;          // 这一环坏了 ⇒ 它下面那一份照旧渲染
}
```

* `wrap` 拿到链条下方那一份当 `orig`（一个 **vnode**，直接嵌进自己返回的树里）；
* `replace` 拿到的 `orig` 是 **`null`** —— 「它下方整段不再被渲染」由**引擎**决定，不靠作者自觉：引擎实现与内层的
  wrap 都不会跑，链条从它的结果继续往外包；
* 混合链（wrap → replace → wrap）因此也是确定的；一个 `replace` 坏掉时退回的是**它下面那一份**，不是整屏。

**边界：`ctx` = 面板那份冻结注入面 + `component` + `props`，没有别的东西。** 一次改写的工厂是
`export function wrap(ctx) { return (orig) => vnode; }`，**每次渲染调用一次**（`ctx.props` 是**这一帧**的只读深拷贝，
用的就是数据口那一个 `readonlySnapshot`）：

| 给 | 说明 |
|---|---|
| 面板那 11 个键 | `id` / `pack` / `slot` / `order` / `gate` / `log` / `host` / `hostKey` / `session` / `net` / `data`，一字不改；改写没有宿主可挂，所以 `host` / `hostKey` 是 `null` |
| `component` | 这一条链改的是哪一个组件 id（一个面板可以声明两条链，模块得知道自己是哪一条） |
| `props` | 这个组件**这一帧**的 props 的冻结深拷贝（改它改不到引擎那份） |

**没有** store 句柄、没有 store 切片、没有 engine、没有 `Match` / `Battle`、没有对局状态 —— 边界由**没给什么**决定
（§28.8）。所以一次改写能画错，**改不了对局结果**。

**失败隔离，两个码，各点名一次。** 链条上任何一环：

* 抛异常（工厂里或渲染里）⇒ `CLIENT_WRAP_THREW`，这一环退回它下面那一份（最内层就是引擎自己的组件）；
* 什么都没返回 / `wrap(ctx)` 返回的不是函数 ⇒ `CLIENT_WRAP_NO_RENDER`，同样退回。

两条都带**包 id + 面板 id + 组件 id**，并且**同一环同一个码只报一次**（一次渲染一条会把控制台刷满）。一个写坏的包
因此不会把屏幕弄没：最坏情况就是「引擎照今天的样子渲染」。

**传输与重画。** 服务端不判 `wraps`（形状层已经在装载期判死），只把 `component` + `mode` **原样**放进
`welcome.modPanels`；模块 URL / 注册路径**一字不动**（`/workshop-panels/<包>/<模块>?v=<摘要>`，
`server/http/workshop.js workshopPanelFilesFor`，§28.8）。链是**渲染期**生效的，所以注册成功之后注册点调用一次
`main.js` 注入的 `onWrapsChanged`（再 `render` 同一个 `<App/>`：Preact 就地 diff，状态不丢）；没有包声明 `wraps`
时它一次都不被调用，页面上不多一次渲染、不多一个新全局。

Tests: `test/modPanelWraps.test.js`（声明 / 装载期 / 传输 / 链的次序与合成 / `replace` / 混合链 / 两个失败码 /
无声明零工作 / 快照脱钩 / 组件 id 表的漂移守卫），`test/modClientPanels.test.js` 与 `test/modClientHosts.test.js`
（既有 C 层行为一字未改）。


### 28.20 `server.room`: the room-level hooks (implemented)

**Why a fifth server payload.** After §28.14 and §28.17 a pack has four server-side payloads — `server.modules` (process
start), `server.preDispatch` (one HTTP request), `server.meta` (a match's shop/economy), `server.battle` (the
battlefield) — and **none of them covers the LOBBY/ROOM lifecycle**: a room being created, a member joining or leaving,
a spectator joining, a match starting or ending, a room being disposed. That is not a hypothetical gap: the reference
community plugin pack hand-patched `server/lobby.js` (**+687 / −14 lines**) to get exactly these behaviours, and every
one of those edits is a rule this layer has to state instead. §28.4's boundary is not violated by opening the seam —
it is tested by what the seam hands out.

**The declaration is one field, parallel to `server.battle`** (`shared/workshop.js parseRoomDecl`):

```jsonc
"server": { "room": { "module": "room/hooks.mjs" } }
```

Same closure rules as the other four members: `room` is a member of the `server` object (`SERVER_UNKNOWN_FIELD`
otherwise, and the refusal lists it), the shape is `{ module }` and nothing else, the path must be pack-relative with no
traversal (`ROOM_BAD_PATH`) and end in `.mjs` (`ROOM_BAD_MODULE` — this module is server-only, unlike `server.battle`
which both ends run). Named refusals mirror `BATTLE_*` exactly: `ROOM_BAD_SHAPE` / `ROOM_UNKNOWN_FIELD` /
`ROOM_BAD_PATH` / `ROOM_BAD_MODULE` / `ROOM_NO_INSTALL` / `ROOM_BAD_SOURCE` / `ROOM_BAD_IMPORT` / `ROOM_IMPORT_FAILED`.
It is a **contribution** (§28.13's `EMPTY_PACK` list names `server.room`), the module's **bytes enter the content hash**
(`server/workshop.js identifyPack` — the same reason kits, panels, `server.meta`, `server.battle` and `server.modules`
do: one digest must not describe two behaviours), a declaration whose file is not in the pack **refuses the whole pack**
at the same prune point (`server/workshop.js roomIssues` → `loadWorkshop` → `dropUnavailablePreDispatchPacks`), and the
editor needs no change because `normalizePackManifest` is the one validator it saves through.

**Loading mirrors `server/battlePack.js`, with a narrower import surface.** `server/roomPack.js roomSourceIssues` scans
the source **before any import** with the same two tables (`KIT_FORBIDDEN_GLOBALS` + `SERVER_CODE_FORBIDDEN_GLOBALS`), and
`kitImportIssues` judges the imports against a whitelist that is **`@sim/` only** (`ROOM_IMPORT_FILES`). The module
exports `install(room)`; anything else is refused by name. The `@sim/` files are the three stateless pure-function
modules the engine itself is built on.

**No `@room/` prefix, and that is a decision.** A whitelist prefix is a **two-end** table: `kitImportMap()` and
`public/index.html`'s import map are generated from the same rows and pinned together by `test/kitImports.test.js`, so
adding `@room/` would open a browser-side namespace for a module the browser never loads — the exact "declared but
never used" failure this section keeps removing. Reusing `@sim/` costs nothing: this module only ever runs on the
server, so it needs no two-end resolution at all. `@battle/` is deliberately **not** on the list either: those are
battlefield helpers (`battleStore`, `passiveBuff`, …) and a room hook is an observation surface.

**The hook API is bounded, and the boundary is what is NOT passed in** (§28.8's rule, applied to the lobby). What
`install(room)` receives, one line of justification each:

| Member | What it is | Why it is there |
|---|---|---|
| `room.id` | the 4-letter room code | a pack must be able to name the room its logs/broadcasts belong to |
| `room.modIds` | the pack ids this room declared (frozen), or `null` when it declared none | after §28.16 "which packs does this room run" is the room's most important fact |
| `room.players` | frozen **seat snapshot** at `install` time: `{ playerId, name, seat, isBot, ready, connected, left }` | a read-only roster: bots are distinguishable from humans, and the pack never holds a live seat object |
| `room.spectators` | the spectator snapshot (`{ playerId, name, connected }`) | spectating is a real seat class here (header of `server/lobby.js`), and 播报/statistics must be able to count it |
| `room.player(seat)` | one entry of the above by seat index (an empty seat yields an empty object, never `undefined`) | saves the author a `find`; one accessor is safer than teaching them to walk internals |
| `room.phase()` | `'lobby'` or `'match'` | "are we in a match right now" is the most basic question a hook asks |
| `room.now()` | the lobby's own clock (ms) | 播报/采样 need a timestamp, and it must **not** be `Date.now()` (see the scan below) |
| `room.on(event, fn)` / `room.off(event, fn)` | subscribe/unsubscribe to one lifecycle event | the observation channel; the event names are a **closed enum** and a typo is named (`ROOM_UNKNOWN_EVENT`), never silently inert |
| `room.log.{info,warn,error}` | a logger prefixed with the pack and the room code | one line must be attributable to "which pack, which room", or an operator cannot separate them |

**Eight events, fired in the engine's own call order**, each with a frozen payload:

| Event | When | Payload |
|---|---|---|
| `create` | after the room is **fully** built (host seated, set materialised, `room.state` broadcast) | `{ room, by }` |
| `join` | a new human took a player seat (a repeated `room.join` does not fire) | `{ room, by }` |
| `spectate` | a new spectator sat down | `{ room, by }` |
| `leave` | any permanent departure (`room.leave`, kick, spectator removal, lobby grace timeout, expiry) — **before** the seat is freed | `{ by }` |
| `matchStart` | a match really started (`match.start()` returned without throwing) | `{ matchNo, mode, difficulty, seed, players, spectators }` |
| `matchEnd` | a match ended, before the seat cleanup | `{ matchNo, summary, victory, players, spectators }` |
| `matchFailed` | the match could not start (construction or `start()` threw) | `{ matchNo, error }` |
| `dispose` | the room was destroyed (last event; `room.disposed` is already `true`) | `{ reason, room }` |

`by` is a seat snapshot in the same shape as `room.players`; `room` is the room state at that instant (`room.state`'s
fields minus the wire `t` and minus `mods`, which is static per room and already available as `room.modIds`).
`leave` carries **no** room snapshot on purpose: the room is mid-change and a snapshot would lie.

**The gating classification, stated once — this is the point of the slice.** A room hook does **not** require
`combat: true`, and the shape layer therefore has no `ROOM_NEEDS_COMBAT`. The rule is about **capability, not intent**:

> A payload that can change **who plays**, **what set is loaded**, or **a match's outcome** must declare `combat: true`
> (that is what puts it into the room digest gate and the golden corpus — §28.13.1, and §28.14's `matchClass` case). A
> payload that can only **observe and announce** must not, because forcing the declaration would either refuse honest
> packs or dilute the gate into a slogan.

Every member above is a read-only snapshot, an accessor over one, a subscription, or a logger; the return value of an
`on(...)` callback is **ignored**. So `server.room` is not combat-gated: it does not enter the room digest gate, it does
not enter the golden corpus, and the layer derivation (`identifyPack`) counts it as **B** (it is server-side code that
reads a room, not data and not UI) while `combat` stays exactly what it was (`kits > 0` when undeclared). The rule is
written down here so the **next** addition to this layer has a test to pass: the day a room hook can refuse a join, pick
a set, or touch a battle, that capability — not the payload as a whole — must be gated behind `combat: true`.

**Isolation: load-time refuses the pack, run time refuses the hook.** A module that cannot load, has no `install`
export, or whose declaration names a file that is not in the pack costs the pack its place in the loaded set at the
same prune point as `server.preDispatch` / `server.meta` / `server.modules` / `server.battle`. But `install(room)` and
every event listener run inside **their own** `try/catch` (`server/roomPack.js createRoomHooks`): a throw is named once
as `ROOM_HOOK_THREW` with the **pack and the hook**, the pack's remaining hooks stay silent for that event, and room
creation, a join and a match end all complete normally. The asymmetry with the load-time stance is deliberate and is the
same one §28.16's per-room materialisation makes: at load time no human is in the room yet, so refusing is free; at run
time real players are sitting in it, so the room must survive. One log line per event, never a broken lobby.

**W-B applies the way it does everywhere else.** `Lobby.create` calls `roomHooks.install(room)` once per room, and only
the packs **that room declared** get their hooks installed in it (`room.modIds` → the same `Set` used for the room's
`server.meta` modules and battle installers). A room that declared nothing runs every installed pack's hooks — that is
the process-level set, i.e. today's behaviour, and with no pack declaring `server.room` the hub holds **no entry at
all**: `fire` is one early return, so a clean install's lobby is byte-for-byte what it was.

**What a room hook still cannot do** (the list is the contract): it cannot change a battle result (no `Battle`, no
`Match`, no store, no result channel); it cannot change who plays (seat snapshots are copies and callback return values
are ignored — a pack can neither admit nor remove anybody); it cannot change what is loaded (`room.modIds` is frozen;
the only way in is `room.create`'s `modIds`, and that is the client's request, not a pack's); it cannot touch the file
system or the network (the static scan refuses `process` / `require` / `fetch` / `setTimeout` / `Date.now` /
`Math.random` / `globalThis`, and the import surface is three pure-function modules); it is **not protocol**: it cannot
add or intercept a client message (that is `server.preDispatch`, §28.13.1, and the C-layer pack channels, §1.9.6) and
it cannot send a frame to a player (there is no `send`).

**Where this seam sits relative to the two engine features it must not block.** Quick match (野排匹配) and room
retention (房间保留) are **engine product features**, not pack powers, and this section deliberately adds no
pack-facing surface for them. The hook points are nevertheless exactly where those features need their own call sites:
quick match has to create/seat/fill a room (the same point `Lobby.create` / `Lobby.join` fire `create` / `join` from)
and retention changes *when* a room is disposed (the one function that fires `dispose`). Both are engine decisions
about `Lobby`'s own state machine; neither needs a new hook name, and a pack can observe both through the existing
events without being able to influence either.

Tests: `test/packRoom.test.js` (declaration shape and named refusals, the gating classification, load-time
success/failure, the static forbidden-global scan, the whitelist verdict, and a real server + real lobby: the event
order `create → join → matchStart → matchEnd → dispose`, a throwing hook that does not break the room, and W-B where
only the declared pack's hooks are installed).


### 28.21 The surface list: what a pack may depend on, frozen and guarded

Every section above adds one more thing a pack may write. This one names the set, because the question the owner asked
on 2026-10-10 has no shape until it does: **「如果改动引擎，我们的中间层可能又被覆盖，那怎么办呢」**.

**The honest half of the answer first.** Nothing in this layer can stop an engine rewrite. `server/lobby.js`,
`server/match/*` and `public/js/screens/*` are ordinary engine files and a port will replace them. What a rewrite cannot
do is **succeed silently**: the pack-facing contract is enumerated in one machine-readable table
(`shared/modSurface.js MOD_SURFACE`), every row is anchored to a **real exported symbol** of the schema
(`shared/workshop.js`), and `test/modSurface.test.js` asserts each row — symbols present, members still in them,
implementing files on disk, the pinning test file on disk, the design section still in this document, the row still in
`docs/MOD-SURFACE.md`. A port that drops a surface fails the test suite in the port itself, not in a community bug report
three releases later.

**The list is closed in both directions.** The other direction is the one that usually rots: adding a surface. The
guard also requires that **every** pack-declarable list in the schema (`PACK_FIELDS`, `WORKSHOP_CONTENT_FILES`,
`CLIENT_PANEL_SLOTS`, `SERVER_MEMBERS`, …) is referenced by some row. So a new declaration cannot land without a row, a
doc anchor and a test — which is the only way this file stays true a year from now.

**Generations, not releases.** The table belongs to an ABI **generation**: `shared/constants.js MOD_API_VERSION`, the
number `pack.json.api` is compared against (§28.5). Two rules decide whether it moves:

| change | generation | why |
|---|---|---|
| **add** a surface (a new `server.*` member, a new panel field, a new whitelist prefix) | **does not move** | it is additive for every published pack; bumping it would refuse every pack that declared `api: "1.x"` — punishing the packs that did the right thing |
| **remove, rename, or change the meaning** of a surface | **moves**, with a migration note | a pack written against the old shape cannot be shown to still be safe; `MOD_SURFACE_FROZEN` records each generation's ids, and dropping one without a bump is a red test |

The ledger's rule is a pure function (`surfaceLedgerIssues(ids, generation)`) for the same reason as everything else
here: a guard whose failure branch has never been executed is not a guard. `test/modSurface.test.js` feeds it a list with
one id removed and requires the message to name that id and to say that removal needs a generation bump — so the rule
itself is tested, not only today's data.

**Negotiation already exists, and it is loud.** A surface this build does not implement is not ignored: `pack.json`'s
top-level keys and `server`'s members are closed sets, so the pack is refused at load time by name
(`PACK_UNKNOWN_FIELD` / `SERVER_UNKNOWN_FIELD`), and a `layer: B` pack whose `api` range excludes this build is refused
outright (§28.5). The table adds the half an author needs to *avoid* that: which generation carries which surface, and
what else that surface requires (`requires` in every row — the `combat: true` gate, determinism, both ends running the
same bytes).

**What is deliberately not a surface.** Patches that edit engine files in place (`shared/protocol.js`,
`shared/constants.js`, `server/lobby.js` — the reference mod ships exactly those as `.patch` artifacts) are distribution
artifacts, not surfaces: to get their *effect* in this model, the effect must first become a row. Product features are
not surfaces either: **quick match and room retention are the engine's own features**, unrelated to this layer, open to
no pack and requiring no declaration. The full list lives in `docs/MOD-SURFACE.md`.

Tests: `test/modSurface.test.js` (the second half of that file; the first half pins the generic names that *in-place
patch* mods depend on — those mods never pass through our validator, so they need their own guard).

### 28.22 `ctx.me`: one read-only session cell, and the one host key that was missing

Two small additions closed six "half-done" items at once (§28.8's C layer had every mount point and data table, but a
panel still could not answer two questions about itself).

**`ctx.me` — read-only session facts.** A panel's ctx now carries exactly three readings plus one helper:

| reading | what it answers | who needs it |
|---|---|---|
| `playerId` / `name` | who am I (my own seat, my own lines) | a chat panel's own-message marking |
| `room` | the room's **display face**: `code` / `mode` / `difficulty` / `inMatch` / `mySeat` / `spectating` / `mods` | `cardMarks` (clear marks when the match changes), a chat panel (`spectating` disables input), a match overlay (`inMatch`) |
| `snapshot()` | all of the above from **one** `store.get()` | a panel that needs two readings consistently |

Three properties, each deliberate:

* **It is a live reading, not a frozen value.** A panel mounts once and is not re-mounted when the store changes, so a
  captured value would freeze at mount time. Every read re-reads the store (the same stance as `ctx.data.get()`), and
  `snapshot()` exists so a panel that needs two readings gets them from one read rather than risking a torn view.
* **The returned objects are frozen.** A panel can read them, cannot write them, and therefore cannot write the
  engine's state through them.
* **The boundary is still what is NOT here.** No store handle, no `match`, no `battle`, no `battleRunner`, no `audio` —
  the same rule §28.8 states. This is a *read-only fact*, not a capability.

**Deliberately NOT included: `search` (quick-match state).** That reading lives in the **lobby screen's own
`useState`** today (`public/js/screens/lobby.js` subscribes `room.queued`); the store has no such field. Surfacing it
would mean first lifting it into the store — a new piece of client-global state added for a payload whose value has
already dropped (0.13.0 ships quick match as an engine feature, §1.6 of `docs/META.md`). That is a different job, and
it is recorded here rather than half-done.

**The missing host key.** `screen.loadout.detail`'s container rendered `data-mod-slot` but **no**
`data-mod-slot-key` (`public/js/ui/detailPanel.js:915`), so a panel mounting there read `ctx.hostKey === null` and
could not know *which operator* the detail panel was showing — and `ctx` has no store, so it could not find out.
The repeatable shop-card host was the positive example all along. One attribute fixes it:

```html
<div class="mod-host" data-mod-slot="screen.loadout.detail"
     data-mod-slot-key=${detail?.type === 'chess' ? (detail.chess?.chessId || detail.standIn?.charId || detail.chess?.charId || null) : null}></div>
```

`null` (no target yet) is "not yet", not an error: the registry does not mount into a keyless container it cannot
resolve, which is the same stance the component-rendered hosts already take.

**What the chain covers (the skin design's open question 2, decided: yes).** The unified chain is not just the detail
panel's portrait — **every** avatar and portrait consumer goes through it, because a consumer left on the old function
produces exactly the silent split the chain exists to remove (the same operator reads as the original on the result
screen and as the new outfit in the detail card, and each of the two screens agrees with its own code). Concretely:

| consumer | what it draws |
|---|---|
| `public/js/ui/gameComponents.js` `UnitThumb` | the shared small avatar — **the result screen, the squad panel, the hand and the shop all go through this one component**, so wiring it here covers them at once |
| `public/js/ui/detailPanel.js` | the detail card's portrait |
| `public/js/ui/shopBar.js` | the shop card's portrait |
| `public/js/ui/fallbackField.js` | the stand-in (补位) avatar |
| `public/js/screens/{loadout,diy,ownership,support}.js` | the picker, the DIY slots, the ownership list, the support list |

`test/ui/portraitChain.test.js` guards this at the **source level**: for every one of those files it asserts that no
line outside an `import` still calls `chessAvatarUrl(...)` / `chessPortraitUrl(...)`, and that each one passes
`currentAppearanceLookup()`. A consumer that quietly keeps the old call therefore fails the suite instead of showing a
stale picture to one player. `chessAvatarUrl` / `chessPortraitUrl` themselves stay exported — they are the reference
implementation the chain is tested **against** (`test/ui/portraitChain.test.js` compares the two on every case).

**Cost and blast radius.** Both additions are *additive*: a page with no pack declaring a panel behaves exactly as
before (no new DOM, no new request, no new global), and `ctx.me` is one more property on an object that already
exists. Per `docs/MOD-SURFACE.md`'s policy these are additions, so `MOD_API_VERSION` does **not** move and no published
pack is refused. The two tests that pin the ctx key set (`test/modClientPanels.test.js`,
`test/modPanelWraps.test.js`) had to learn the new key, which is exactly what they are for.

Tests: `test/modClientPanels.test.js` — the ctx surface, the frozen-snapshot rule, and the three room states (not in a
room / seated / spectating), plus "a later store change is visible through the same ctx".

### 28.24 ctx.net.status(): the connection reading a panel cannot take itself

A panel can see a room and its own identity (§28.22), but it could not answer **「这条连接现在怎么样」**. That reading
cannot be derived in the panel: the panel gets no `WebSocket`, no heartbeat round-trip and no reconnect counter — the
boundary of §28.8 is exactly "what is not passed in is not reachable". The engine already holds all of it.

**The reading.** `ctx.net.status()` returns the **same fact** the engine publishes as its `'status'` event
(`public/js/net.js` `Net.snapshot()`, fed by every `_setStatus` and every `pong`), as a frozen copy:

| field | meaning |
|---|---|
| `status` | `idle` / `connecting` / `connected` / `handshaking` / `online` / `reconnecting` / `closed` — the seven values of `Net.status`, verbatim |
| `attempt` | consecutive failed connection attempts (0 when none) |
| `retryAt` | epoch ms of the next reconnect attempt (0 = none) |
| `ping` | last measured round-trip in ms, or `null` before the first `pong` |
| `lastError` | `{ code, text }` of the last connection-relevant `NetError` (e.g. `REPLACED`, `VERSION`), or `null` |

Three properties, each deliberate:

* **Read-only, and a copy.** Every call builds a **new frozen object** with exactly those five keys. The engine's own
  state is not handed out (`playerId` and the private socket fields stay inside), a panel that writes the returned object
  gets a `TypeError`, and a later state change does **not** reach into a snapshot that was already handed out. Read
  twice, get two objects; the earlier one keeps its old values.
* **Nothing when there is nothing.** A `net` without `snapshot()` (a Node harness, a minimal host), a malformed return
  value, or a `snapshot()` that throws all yield **`null`** — never a filled-in default and never a thrown error. A
  panel draws its empty state; it must not compute one.
* **A reading, not a channel.** The method originates no frame, sends no request and changes no engine behaviour. This
  is asserted mechanically, not by promise: `test/modClientNetReads.test.js` wraps every exit of a real `Net`
  (`send` / `request` / `sendResourceMessage` / `_sendRaw`) in a counter and requires zero calls.

### 28.25 ctx.net.welcome(): the handshake frame the client already received

> **编号注记（只说明，不改号）。** 本仓库这里的 §28.24 / §28.25 是**本节新增的面板读面规范**
> （`ctx.net.status()` / `ctx.net.welcome()`；只在包内 `PROVENANCE.md` 与代码里同样写作 §28.24 / §28.25，
> 故两个号一律保持不动，mod 作者才对得上）。`docs/design/engine.md:214` 那个
> 「Community corrections (2026-10-10, §28.25)」是**另一处松引用标签**，`docs/design/client.md:150` 引的
> §28.25、`docs/design/network.md:23` 引的 §28.27 同为松引用（`test/docs-paths.test.js` 只判「号是否出现过」，
> 不核对所指内容）。**二者不是同一节**，互不替代。

The second half of the same gap. The `welcome` frame (`shared/protocol.js` S2C; assembled in `server/net.js:713` from
`welcomeInfo()`) is the server's identity: protocol version, the pack set it runs (`mods { digest, packs }`), the
operator catalogue, the seat ceiling. A panel could already subscribe to it (`ctx.net.on('welcome', fn)`, an engine type
passes through unchanged), **but the frame that mounts the panel is the same one it would have to subscribe to** — the
panel list travels in `welcome.modPanels`. A panel that subscribes inside `mount()` therefore waits for a reconnect to
learn who it is talking to, which is exactly what the `net-panel` submission reported.

**The reading.** `ctx.net.welcome()` returns a **frozen deep copy** of the last `welcome` frame this page received
(same `readonlySnapshot` as `ctx.data.get()`), or `null` if none has arrived yet. The frame is passed through as it
reached the page — no fields renamed, trimmed or defaulted — so a panel reads `playerId` / `name` / `serverNow` /
`version` / `mods` / `modPanels` … exactly as `on('welcome')` would deliver them.

* **Where the copy comes from.** The registry subscribes to `welcome` **once, when it is created**, and keeps one
  frozen copy. This is not a new frame and not a new request: `main.js` already subscribes to the same frame for the
  panel list, the resource declarations and the theme, and the registry is created at page scope — so its listener is
  in place before the `welcome` that calls `apply()` is dispatched. Subscribing lazily on first read would be too late
  for **every** frame, including the reconnect one.
* **Read-only, and a copy.** A panel cannot write the frame, and a later `welcome` does not rewrite a snapshot already
  handed out. `dispose()` unsubscribes and clears the copy (anything injected once must be recoverable), after which
  the reading is `null` again — while `status()`, which only reads live engine state, still answers.
* **Nothing when there is nothing.** Title screen, a rejected handshake, a plain install: `null`, no error.

**Cost and blast radius.** Both cells are *additions* to an object that already exists: `MOD_API_VERSION` does **not**
move (§28.21's table, the first row) and no published pack is refused. A page whose packs declare no panel behaves as
before — the two cells are defined on the facade, which is only built for a mounted panel — and the one extra
`welcome` listener caches a private copy without adding a frame, a request or a DOM node. The two tests that pin the ctx
key set had to learn nothing: `net` is still one key, and the pinned nets in `test/modClientPanels.test.js` /
`test/modPanelWraps.test.js` are minimal hosts, which is exactly the `null` path above.

Tests: `test/modClientNetReads.test.js` — both cells on one frozen facade; the `status()` field-by-field agreement with
`Net.snapshot()`; a handed-out snapshot surviving engine changes and rejecting panel writes; `welcome()` pass-through,
depth of the freeze, and a later frame not rewriting an earlier snapshot; `null` for every "nothing to report" host;
`dispose()`; and "no new protocol message".

---

### 28.28 工坊时装（§28.28）：一个开关，加「提供者先说话」

`pack.json.skins`（表面 `skins`）是 A 层的一格，形状与 art 同形并复用同一个解析器（`SKIN_FIELDS`，
`shared/workshop.js`；A 层只判形状，拒绝码全部点名）。**数据和引擎都不认识「皮肤」** —— 这一段说的正是
§28.2 那条边界落地之后剩下来的那一件事：**一个包声明了一套外观，谁来回答「这位玩家现在要哪一套」**。

**1. 声明与落点。** 包的声明归一化成 `pack.skins` 并**并进清单**：`assets.skins[<charId>] = [{ pack, id,
name, series?, desc?, art?, voices? }, …]`（`mergeWorkshopSkins`）—— 按干员分组的一列，客户端要问的问题
（「这个干员有哪几套」）就是那张表本身。两个包给同一干员的同一套 id 时按包 id 升序第一个赢并点名
`SKIN_COLLISION`（与 `ASSETS_COLLISION` 同一条纪律）。`skins` 同时是贡献项：只带时装、`content: []` 的包合法。

**2. 谁决定「哪一套生效」。** 不是引擎。引擎侧只有一个中间层接口，既有的**外观提供者**
（`client.panels[].appearance(ctx)` → `{ lookup(kind, charId, id) }`，§28.8，`public/js/ui/extensions.js`）：
一个进程最多一个，后注册者被拒；它返回**被问的那一条 kind** 的一张图（`{ portrait }` 或 `{ avatar }`；
老写法「整套 `portrait` / `avatar` / `portraitE2` / `avatarE2`」在步骤 0 与步骤 4 都仍然能用 —— 链只取
自己那一条 kind 的字段）或者 `null`。**引擎不知道那个 `id` 是一套时装、一个包名还是一串随机字符** ——
它把不透明 id 连同**这条链的 kind** 交给提供者问一次。

**2b. 立绘与头像分开受控。** `lookup` 的第一参数是这一条链的 `kind`（`'portrait'` / `'avatar'`），于是
「立绘用时装那张、头像还是原版」是提供者可以回答的一件事，而不是链替它猜的。四条一起构成这条边界：

1. **按 kind 问**：链里 `kind: 'avatar'` 的那一次只问 `avatar`，与立绘那一次互不影响（两处调用点各画各的）；
2. **按 kind 取字段**：步骤 0 只认 `FIELDS[kind]` 那一个字段（立绘看 `portrait` / `portraitE2`，头像看
   `avatar` / `avatarE2`）—— 提供者给另一条 kind 的字段**不算答案**，否则一份只有 `avatar` 图的时装会把
   头像也画到立绘位上（就是业主实测撞到的那个错）；
3. **按 kind 记**：链自己**不读、不写偏好**（那是「引擎不认识皮肤」的一部分）；「记」由提供者决定
   （`skin-picker` 用 `skin:portrait:<charId>` / `skin:avatar:<charId>` 两格，旧键 `skin:<charId>` 仍作
   两条 kind 的公共退路）。链负责的只有「按 kind 问」这一半；
4. **调用方点名版本时提供者不参与**（见下面第 3 条的第 4 点与优先级）。

**3. 「提供者先说话」（步骤 0）。** 解析链（`public/js/ui/portraitChain.js`）里，`_1`/`_2` 后缀那一步
**之前**先问一次提供者：给 URL 就用它，给 `null` / 抛错 / 给一个没有可用字段的对象就**继续走原来的链**
（吞异常与步骤 4 逐字相同：坏 mod 不外溢、画面照旧）。**优先级：调用方显式点名的变体 > 提供者的选择 >
官方回落。** 四条同时成立这一步才存在：

1. **开关**：玩家设置里的「工坊外观」（`settings.workshopSkins`，默认 `true`）。链的门控是模块级的一份
   （`setAppearanceFirst`，唯一写入面是 `public/js/ui/settings.js`：启动时 + 每次变更的同一次订阅里），
   **默认 `true` 且与设置默认同值**；`opts.skins === false` 是这一个调用点的否决（压过模块值）。
2. **确实注册了提供者**（`appearanceLookup` 非空）—— 这就是「装了时装却什么都不发生」在今天的原因：
   没有任何东西把「玩家选的那套」写进 `chess.assets.portrait`，而问这一步本身也不存在，于是注册好的
   提供者是**死代码**。
3. **有 `charId` 也有 `id`** —— 提供者按这两样归属一套外观。
4. **调用方没有点名版本**（`explicitVariant`）。三种写法都算点名：`opts.variant === 'elite'`、`id` 以
   `_1` / `_2` 结尾（`assetUrls.js` 逐字同一套语义：`_2` = 精锐、`_1` = 一阶）、`kind: 'portrait'` 且
   `chess.isGolden`（详情页 / 商店卡的既有语义）。命中时提供者**一次都不被问到**，链先给这个干员的精锐
   字段、没有精英字段就走官方回落 —— 「别人明确要精锐立绘」不该被一份只有一张图的时装盖掉。**头像不看
   `isGolden`**（与步骤 5 同一条：精锐头像由调用方自己传变体），所以时装在头像那一条 kind 上照旧生效。

问的是**模块级那一个**提供者，不是调用点的 `opts.lookup`：后者是渲染点上那一份引用，可能比注册晚，
而失败形态是**静默回落原版**（同一个干员在两个画面上不一样，各自都对）。步骤 4 那个 `opts.lookup` 是
**另一条口**（登记外观 id 的历史形状）：它仍以 `'chars'` 作第一参数被调用，与 `kind` 无关 —— 两个问题不同
（「这个 id 是谁」对「这一条链现在画哪一张」），所以没有合并成一次调用。

**4. 最硬的那条不变量：关掉时逐字相同。** 开关关掉时步骤 0 **整段不存在** —— 增删的只有一次「要不要问」的
判断，不用引擎认识皮肤、不动 `chess.assets`、不动任何读取点。`test/ui/portraitChain.test.js` 把它钉成两个
方向：**关**（拿今天 `chessPortraitUrl` / `chessAvatarUrl` 两个实现当对照逐项比对，另加「一个调用点写
`skins: false` 时连注册好的提供者都不问」）与**开**（提供者给的优先于 `chars` 里同名的条目、给 `null` 或抛错
就回落、`_1`/`_2` 后缀与精确命中仍在它之后）。房主把开关关掉 = 这一版的解析结果与不装包逐字相同。
「分开受控」那一段（2b / 第 3 条第 4 点）只在**开关打开且确有提供者**时才有意义：关掉时连这一步都不存在，
所以四条性质不需要各自再钉一次逐字相同。

**5. 表面与守卫。** `skins` 进 `shared/modSurface.js`（锚 `SKIN_FIELDS` / `PACK_FIELDS{skins}` / `SKIN_ID_RE`）
与 `docs/MOD-SURFACE.md`；`test/modSurface.test.js` 的 `SURFACE_LISTS` 里加了 `SKIN_FIELDS`，所以「字段表被
挪走」与「新加一格没进清单」两头都红。加一格对已发布的包是纯增量，`MOD_API_VERSION` **不动**。

### 28.29 形态（clip set）与静态相位：两条**行为增量**通道

这一节回答业主那一条要求：「做不了的我们就加接口，做到完美兼容。」有两件事今天包做不了，而两件都不是数据、
是**渲染器的行为常量**：

* `public/js/render/units.js` 的 `FORMS` —— 按 spine id 键、值是「形态名 → `{change, end, leave, next, roles}`」
  的**冻结模块常量**。一个包带来的干员/怪物若有自己的变身形态（新模式、新 clip 集），今天没有任何声明能让
  渲染器认识它。
* `public/js/render/fx/kinds.js` 的 `SILENT_PHASES` —— 一个 `Set`（`'bombed'` / `'warning'`），命中的 `'phase'`
  特效**不放**通用特效（模型自己会表示）。一个包自己的相位种类今天只能得到一层不属于它的通用特效。

两条通道的形状是同一个：**第一方常量一个字节不动，包只做增量，消费点走统一入口**。

**1. 第一方 `FORMS` 不动。** 它是第一方常量，每一条都是对着真 skeleton 的 clip 名校出来的（`units.js` 那段
长注释逐条记着来源）。所以答案不是把它换成一个可写表，而是新增一张**包形态覆盖表**（`shared/packForms.js`）
与一个统一入口：

```js
formsFor(FORMS, info.spine || info.defId)?.[form]   // 第一方在前、包只补第一方没有的形态名
```

四个消费点（`units.js` 的 `_formSpec`、`setForm` 的准入与 `next`，以及 `render/app.js` 的 fx `form` 那一处）
全部改走它；两个文件都不再直接索引 `FORMS`。

**2. 合并规则：第一方优先，包只做增量。** 四条，判据都落在代码里：

| 情形 | 结果 |
|---|---|
| 包声明与**第一方**同名的形态（同一个 spine id） | 形状层 `FORMS_FIRST_PARTY_OVERLAP` —— **整包拒绝**，不是静默丢掉 |
| 包声明一个第一方**没有**的形态名（同一个 spine id） | 进表；第一方那几条不受影响 |
| 包声明一个第一方**完全没有**的 spine id | 进表（这就是「包自带干员/怪物有自己的形态」那条路） |
| 两个包声明同一个 `spine id + 形态名` | `FORM_COLLISION` 点名；**包 id 小的赢**（与 art / skins 同一条） |

**为什么第一方优先，而不是「包可以覆盖」**（取舍，请业主过目）：覆盖会让「第一方干员长什么样」变成
**取决于装了哪个包**，而同一份摘要下的行为必须唯一（§28.2）。一个包真想改一个第一方干员的形态，它需要的
其实是「新 spine id + 新形态名」，那条路一直是通的。反过来，若允许覆盖，作者写下一个不会生效的声明却拿不到
任何提示 —— 那正是这一层存在的全部理由要消灭的方向，所以这里选择**大声拒绝**而不是悄悄让步。

**3. 声明形状**（`pack.json.forms`，按 `ART_TABLES` 的**对象表**分组：形态说的是 spine 模型，而模型只住在这
三张表里）：

```json
"forms": {
  "chars": {
    "char_ws_hero": {
      "shift":   { "change": "Start_B", "end": "Die_B", "next": "shifted",
                   "roles": { "idle": "Idle_B", "die": "Die_B_2", "move": { "loop": "Move_B" } } },
      "shifted": { "roles": { "idle": "Idle_C", "die": "Die_C" } }
    }
  }
}
```

判据（每条对应一种「写了却不生效」的失败方向，全部**整包拒绝**）：表名 ∈ `FORM_TABLES`（`chars` / `enemies` /
`tokens`，`FORMS_UNKNOWN_TABLE`）；形态名合 `FORM_KIND_RE`（`FORMS_BAD_KIND`）；形态级字段只许
`change` / `end` / `leave` / `next` / `roles`（`FORMS_SPEC_UNKNOWN_FIELD`）；三个 clip 名是非空字符串或 `null`
（`FORMS_BAD_CLIP`）；`roles` 必须存在（`FORMS_MISSING_ROLES`）、键 ∈ `FORM_ROLE_KEYS`、值是非空字符串 / `null` /
`{begin, loop, end}`（`FORMS_BAD_ROLES`）；`next` 必须指向**同一个 spine id 上已声明**的形态 —— 第一方或本包
（`FORMS_NEXT_UNKNOWN`，纯函数 `formNextDeadLink` 判，失败分支自己也被测）。

`change: null` 与省略 `change` 归一化后**逐字相同**（都表示「没有过渡 clip」）：同一份行为不该有两个哈希。

**4. 第一方形态名的镜像与它的守卫。** 「与第一方同名」这条判据需要「第一方在这个 spine id 上有哪几个形态名」，
而加载器不能 import 渲染器。所以 `shared/formNames.js` 是**生成物**（`node tools/build-form-names.mjs`，从
`FORMS` 真身读出来），`test/packForms.test.js` 把每一格与 `FORMS` 逐条比对 —— 少一个、多一个、拼错都红。

**5. 静态相位与 `forms` 共用同一个顶层键里的 `fx`。** `pack.json.fx = { silentPhases: [...] }`。**为什么并进
`forms` 那一刀而不是各开一个顶层键**：两者是同一类东西（渲染器的行为增量、同一趟并进同一份 `assets.json`、
同一条「第一方优先 / 并集」的规则），一个顶层键把它们归到一处，作者的发现路径与文档路径都短一条；而 `fx`
这个名字本身是开放的（将来「哪些 kind 不抖屏」「哪些 kind 不进伤害数字」都落在它下面，不必每次加一个顶层键）。
`fx` 在 `PACK_FIELDS` 里是**闭集成员**，不写它的包一个字不变；未知字段 `FX_UNKNOWN_FIELD`；每一项必须是非空
字符串（`FX_BAD_SILENT_PHASE`）。合并规则是**并集**（`bombed` / `warning` 永远静默，包只能加；并集没有减法），
`silentPhases: []` 与 `routes: []` 同义（合法但什么都不做 ⇒ 不算贡献项，只带它的包照旧 `EMPTY_PACK`）。

**6. 落点与取数路径：`assets.json`。** 两条声明都并进**已经存在**的那份清单（`assets.modForms` /
`assets.silentPhases`，`shared/workshop.js` 的 `mergeWorkshopForms` / `mergeWorkshopFx`），于是：

* 客户端**零改动**就能 `data.get('assets')` 读到它们（与 `assets.skins` 逐字同一条理由）；
* 服务端那一半只有一行：`workshopTouchedFiles` 把 `assets` 加进「必须合并后发给浏览器」的集合 —— 漏掉它，
  服务端会说「包已加载、形态也在」，而浏览器拿到的是磁盘上那份没有 `modForms` 的清单（一个不会报错的静默失效）；
* `public/js/assets.js` 在**清单被采纳的那一刻**装这两份声明（`adopt`，以及构造时就带清单的那一支），
  不在每个视图上重复。

**7. 没声明这两条的包：逐字相同。** 归一化清单里不会多出 `forms` / `fx` 键（「写了才进」那条纪律，§28.13），
`formsFor` 在没有包增量时返回的就是 `FORMS[spine]` **本身**（`test/packForms.test.js` 断言对象同一性），
`silentPhase` 在没有包增量时只认第一方那两个。所以老包的哈希与第一方的行为都不动，`MOD_API_VERSION` **不动**。

**8. 表面与守卫。** 两格表面（`forms`、`fx.silentPhases`）进 `shared/modSurface.js`（锚 `FORM_TABLES` /
`FORM_KIND_RE` / `FORM_ROLE_KEYS` 与 `PACK_FIELDS{fx}`）与 `docs/MOD-SURFACE.md`；`test/modSurface.test.js` 的
`SURFACE_LISTS` 里加了那三个符号，所以「名单被挪走」与「新加一格没进清单」两头都红。

测试：

```
node --test test/packForms.test.js                    # 声明生效 / 第一方与包共存 / 不合法被拒 / 没声明时逐字相同
node --test test/workshopValidateArtTables.test.js    # art 的扁平表不再让校验器崩（本轮那条真 bug）
node --test test/modSurface.test.js
```


### 28.30 伤害看板（投稿 30498a468a0f 那一格）：今天能读什么，读不到什么

业主点名的那一格是「让包在**客户端**自己算 DPS 与总伤」。查完的结论**分成两半**，两半都写在下面 ——
因为把「总伤今天就能读」与「逐单位 / 逐场 DPS 今天读不到」混成一句，作者就会照着一个不存在的读数写代码。

**一、今天就能做：总伤（零引擎改动）。** 面板本来就订阅得到引擎的 S2C（`public/js/ui/extensions.js:827`
`S2C_TYPES.has(type) → net.on(type, fn)`，**原样透传**），而伤害数字在两条既有帧上：

| 面板读得到的 | 既有 S2C 帧 | 帧里的哪一格 | 粒度 |
|---|---|---|---|
| **每人总伤害** | `m.result`（`shared/protocol.js:758`） | `players[].stats.dmgDealt`（同处还有 `bossDamage` / `healingDone` / `kills` / `leaks` / `perfectRounds`；`server/match/results.js:156-161` 组装，`ui/stats.js` 与 `screens/result.js` 的战绩页读的就是它） | 整场**结算时**一次，按玩家 |
| **实时领袖伤害** | `b.pool`（`shared/protocol.js:764`） | `acked[fieldId]` = 那一场累计计入的领袖伤害（`server/match/match/bossRounds.js:381` `_broadcastPool`「to everyone」，≤ 4 Hz） | 首领 / 隐藏回合，按**场**，≤ 4 Hz |
| 共享池血量 / 队伍 LP | 同一条 `b.pool` | `hp` / `max` / `teamLp` | 同上 |

所以「总伤看板」是一个**今天就能发**的包：订阅 `m.result` 排个序就够了。

```js
// client.panels[] = [{ id: 'board', slot: 'screen.result.footer', module: 'board.js' }]
export function mount(ctx) {
  const rows = new Map();                        // playerId → 总伤
  const off = ctx.net.on('m.result', (m) => {    // 既有 S2C：原样透传，不是新通道
    rows.clear();
    for (const p of m.players || []) rows.set(p.playerId, p.stats?.dmgDealt ?? null);
    draw(rows);                                  // 面板自己的 DOM，ctx.host 里
  });
  return { unmount: off };
}
```

**二、今天读不到：逐单位伤害、逐场伤害、每一次命中。** 三条各自有判据，不是「没查到」：

* **逐单位伤害留在服务端。** 那份带 `defId/dmg/kills/heal` 的 `unitStats` 只到服务端为止
  （`server/match/fields.js:61` / `:873`，`Match.js` 把它累进 `ps.stats.unitStats`），结算帧里**只有**由它选出来的
  一个 **mvp id**（`server/match/results.js:154` `mvp: mvpOf(ps, lineup)`）—— `m.result` 的每个玩家条目里
  **没有** `unitStats`。
* **唯一带 `dmg` 元组的 S2C 是 `b.ev`**（`shared/protocol.js:766`，元组种类 `EV.DMG` 在同文件 `:799`），
  而那一行自己的注释写着 `server-run combat streaming (legacy / SP_COMBAT=server only)`。
* **默认（客户端跑战斗）时那些元组不进 `net`。** 权威客户端的战斗在本机跑，`b.snap` / `b.ev` 走
  `public/js/battle/runner.js:282` 的 `emit` —— 那是 runner **自己的** listener map（`public/js/screens/game.js:601` 用
  `battleRunner.on('ev', …)` 消费），不是 `net`。runner 对 `net` 只有三件事：`on`（订阅 `b.start` / `b.end` …）、
  `send`（`b.progress` / `b.result`）、`request` —— 一条都不是「把伤害元组交给面板」。
* 顺带一条容易踩的：**`b.progress` 不是 S2C**。它是 C2S（`server/match/match/reports.js:18` 是它的处理器，
  服务器只把它折进 `m.public` / `b.pool`，**从不原帧广播**），所以面板 `ctx.net.on('b.progress', …)` 会被
  `CLIENT_CHANNEL_UNDECLARED` **点名拒绝** —— 那条路上连订阅都不成立。

**三、要真 DPS，需要什么（本批**已实现**，见 §28.38）。** 「面板可以画错、但不能算错」在这里的落点是：**没有读数就
不造读数**。一个能算逐单位 DPS 的读面至少要有三件事，缺一条就不该做：

1. **数据源**：**§28.38 已落地**，而且不是这里当初设想的那两条路（把 `on('ev')` 转出去、或由 runner 自己再累计
   一份）—— 查下来**伤害早就在模拟里算好了**（`server/sim/damage.js` 每次命中写 `source.stats.dmg` 与
   `battle._perPlayer[ownerId].damageDealt`），所以那一格只是 runner 里的一个**只读读者**：碰的文件确实还是
   `public/js/battle/runner.js` 与 `public/js/main.js`，但**没有第二份累计**，`step()` / `drainEvents()` / `emit`
   一行都不动。
2. **形状**：**不再是** `ctx.net.damage()`（模拟事实不该挂在 `net` 上，见 §28.38 的理由）；落地的是
   **`ctx.battle.damage()`** → 一次读一份冻结副本
   `{ battleId, fieldId, kind, authoritative, own, gt, t0, players, units }`，`null` = 当前没有正在跑的战斗 / 没有
   注入战斗运行时 —— 与 `status()` / `welcome()` / `transport()` 同一套「拿不到就是 `null`，不抛、不编造」。
3. **判据**：它只读已经在那儿的数字，**不许**让 runner 多算一步 / 改一条帧 / 碰模拟输入 ——
   可执行的判据是「同一 seed 的战斗结果摘要逐字节相同」，模板就在 `test/modClientSettings.test.js` 的
   「模拟侧零副作用」那一条（§28.38 又加了一份专门的守卫：`test/modClientBattleReads.test.js`）。

**四、表面与守卫。** 这一节当时没有新代码，所以没有新表面：与 §28.24 / §28.25 同一先例（纯读数不新增
`pack.json` 声明，没有 schema 符号可锚，故不进 `shared/modSurface.js`）。守卫是 `test/modClientSettings.test.js`
里「伤害看板」那一组：`m.result` 原样透传、结算帧里没有 `unitStats`、`b.progress` 订阅被点名、runner 的元组
不进 `net`、以及面板活着时战斗摘要不变。**`MOD_API_VERSION` 不动**（今天这一半是零改动）。
**逐单位那一半后来落地了**：见 **§28.38**（`ctx.battle.damage()`），它把「这一点读不到」补成「读得到，但只给
本场」，并把上面这三条判据写成了可执行的守卫 `test/modClientBattleReads.test.js`。

### 28.31 `ctx.me.voice` 与 `ctx.session.setVoiceLang`：一格配音读数，加一个**唯一**的设置写口

面板答不出「这台机器现在用哪套配音」：那个值住在**另一个** store（`public/js/ui/settings.js:47`
`settingsStore`，与 `ctx.me` 读的 `public/js/store.js` 不是同一个），而注入面里没有 store 句柄。
干员详情里的切换口（`public/js/ui/detailPanel.js:318` / `:519-522`）能改它，面板不能 —— 所以补一格**读数**加一格
**受限写口**（业主裁决 2026-10-11：「能优化就优化，但要守边界」）。

**1. 注入。** 注册点收 `deps.settings = { get, setVoiceLang }`（`public/js/main.js` 给的就是引擎自己那一对：
`settingsStore.get()` 与 `ui/settings.js` 的 `setVoiceLangByChar`）。注入的是**两个函数**，不是 store 句柄 ——
与 `deps.data` 同一条理由：`ui/settings.js` 会拖进 Preact 与整套界面，而这一层必须能在 Node 里跑。

**2. 读数：`ctx.me.voice`。**

| 字段 | 含义 |
|---|---|
| `global` | 全局配音（`settings.voiceLang`），永远是 `VOICE_LANGS`（`shared/constants.js:77`：cn / jp / en / kr）的成员 |
| `byChar` | 逐干员覆盖的**冻结浅拷贝**（`charId → 语言`）；缺档 = 键不在，不是 `null` |

* **每次读一份新的冻结副本**（与 `readMe()` 同形）：改它 `TypeError`，引擎之后换了选择也不会回溯改写已经
  发出去的那一份。`byChar[charId] ?? global` 就是播放时用的那个语言 —— 最后一档「默认配音」被
  `sanitizeSettings` 保证不会露出来（store 里的 `voiceLang` 一定是词表成员）。
* **第二个读者**：形状不是 `char_…` 的键、值不在 `VOICE_LANGS` 里的，都不进快照 —— 面板画出来的不该与
  `public/js/audio.js:1207` / `:1214` 播放的不一致。
* **拿不到就是 `null`**（没注入设置库 / 不成形 / `get()` 抛）：不抛、不编造，面板画空态。
* **不进 `me.snapshot()`**：那三格来自**一次** `store.get()`（「一次取全」才不撕裂），这一格来自另一个 store。

**3. 写口：`ctx.session.setVoiceLang(charId, lang)`。** 它开了**新的一类**（在此之前面板只写得了
`session.setPreload` 那两个入口闸门标志），所以边界写死在代码里（`public/js/ui/extensions.js`
`VOICE_CHAR_ID_RE` 上面那一段注释）：

* **只此一格**：只写 `voiceLangByChar` 的**一个键**，其它设置（音量 / 静音 / 画质 / 文字大小 / 快捷键 /
  工坊外观开关）一个字节都不动；
* **只影响本地**：配音在**播放时**解析（`public/js/audio.js:1207` 的 `voiceLangOf` → `ui/gameLogic/settings.js
  voiceLangFor`：覆盖 → 全局 → 默认），整个写口是纯 localStorage 偏好 —— 不发帧、不落对局、改不了任何人的战果；
* **闭枚举**：值只收 `VOICE_LANGS` 的成员，或 `''` / `null`（= 清掉这一格，回到跟随全局；与
  `public/js/ui/detailPanel.js:519` 的「跟随默认」同一个含义）。`VOICE_LANGS` 本身一个字也不许改；
* **越界一律点名**（不静默丢弃）：`CLIENT_VOICE_BAD_CHAR`（干员 id 形状）/ `CLIENT_VOICE_BAD_LANG`
  （非枚举值，**列出全部可用配音**，并说清 `''` 才是清空 —— `undefined` 不是）/ `CLIENT_VOICE_NO_SETTINGS`
  （这一页没注入设置库）/ `CLIENT_VOICE_WRITE_FAILED`（写函数抛）/ `CLIENT_VOICE_REFUSED`（设置库自己拒了，
  例如覆盖表满 `VOICE_OVERRIDE_MAX` = 400 —— 这一条只有引擎知道，所以要点名）。
* **落盘只有一条路**：写进 store → 设置库顶部那**一条**既有订阅（`settings.js` `settingsStore.subscribe`
  → `savePref('settings', …)`）落盘。这里**不另调一次** `savePref`（同一件事两条落盘路径早晚会漂）。

**4. 落点。** `public/js/ui/extensions.js`（`VOICE_CHAR_ID_RE` / `readVoice` / `session.setVoiceLang` /
`net.transport`）、`public/js/ui/settings.js`（`setVoiceLangByChar`：只改一格的写函数，第二读者是
`sanitizeVoiceLangByChar`）、`public/js/main.js`（注入那一对函数）。

**5. 表面与守卫。** 加一格读数不抬版本（`MOD_API_VERSION` 不动，已发布的包一个都不受影响）。两条**既有**
断言必须学新键 —— `test/modClientNetReads.test.js` 的「net 面不多不少」那张枚举表（多 `transport`）、
`test/modClientPanels.test.js` 的 `Object.keys(ctx.me)`（多 `voice`）；两处**严格度不变**（仍然断言「不多不少」），
这正是那两条断言存在的意义。新守卫是 `test/modClientSettings.test.js`。

### 28.32 `ctx.net.transport()`：只有服务端知道的那一格

同一条「面板推不出来、只有引擎答得出来」的清单又加一格：**这条 WebSocket 实际跑在什么参数上**。浏览器侧的
`WebSocket` API **不暴露** `Sec-WebSocket-Extensions`（也没有 `maxPayload`），panel 与引擎都推不出来 —— 而这正是
`permessage-deflate` 那种会让「帧大小 / 延迟 / CPU」一起变的配置最容易被误判的地方。

**来源。** 服务端知道它自己启动时用的参数，于是在 `welcome` 里带一格**只读**字段 `transport`
（与 §28.24 / §28.25 同一份快照：`ctx.net.welcome()` 与 `ctx.net.transport()` 读的是**同一条帧**）。
字段名与本批服务端那一格的约定就是 `welcome.transport`。

| 字段 | 含义 | 读不到时 |
|---|---|---|
| `deflate` | 压缩开着吗 | `null`（**不是** `false`：「不知道」与「关着」是两件事） |
| `params` | 协商出来的参数串 | `null` |
| `maxPayload` | 单帧上限（字节） | 这一格是必填的：**不成形（非有限、负数）就整格 `null`** —— 半个读数比没有更危险 |
| `threshold` | 压缩阈值 | `null` |

**只读语义。** 每次调用一份**新的冻结副本**，只带上面四个键（服务端那一格里多带的字段不外传）；改它
`TypeError`；后到的一帧不回溯改写已经发出去的那一份。

**拿不到时。** 返回 `null`，**不抛、不编造**，并**记一行**（注册点的 `log` = 页面控制台，**每种原因一次**，
见 `extensions.js` 的 `transportGapsLogged`）：

* 这一页还没收到过任何 `welcome`（标题屏、握手被拒）—— 这是「还没到时候」，**不记**；
* 收到的 `welcome` 里**没有** `transport`（老服务器 / 未装服务端那一格的部署）—— 记一行并如实说明
  「待服务端补字段」。**绝不自己造一个默认值**：一个凭空来的 `maxPayload: 65536` 会让面板照它去解释
  「为什么这一帧被拒」，那比 `null` 危险得多。

**表面与守卫。** 它**不是**新的消息类型：`transport` 只是 `welcome` 里的一格字段（`S2C` 里没有 `transport`，
`C2S` 里也没有）。守卫是 `test/modClientSettings.test.js` 的「三格读数一次都不碰四个出口」（真 `Net` 的
`send` / `request` / `sendResourceMessage` / `_sendRaw` 各套一个计数器，要求 0），加上 `test/modClientNetReads.test.js`
那张「不多不少」的枚举表。**`MOD_API_VERSION` 不动**（加法）。

### 28.33 `pack.json.server.transport`：声明式的启动期传输配置（服务端那一半）

§28.32 说的是客户端那一格读数（`ctx.net.transport()`）；这一节说的是**它读的那个字段从哪来**。

**问题。** WebSocket 的 `perMessageDeflate` 写死在 `server/http/websocket.js`（`false`）。参考包
`ws-compression-reference` 想开压缩，唯一办法是手改引擎那一行 —— 正是这一层到处在消灭的东西。

**两条路，业主裁决选第二条（`D 声明式足够就不做`）。**

| 路 | 能力面 | 结论 |
|---|---|---|
| 包注入服务端代码去改 `wss` | **进程启动选项写权限**（改监听、改压缩、改超时） | 不做。那已经不是内容 / 界面 / 只读观察里的任何一层，而是运维杠杆 |
| `pack.json.server.transport` 一张字段闭集 | 声明若干有上下界的值 | **做**。同一个结果，代价小一个数量级 |

**声明。** `server.transport = { deflate, threshold?, level?, memLevel?, concurrencyLimit?,
serverNoContextTakeover?, clientNoContextTakeover?, serverMaxWindowBits?, clientMaxWindowBits? }`。
`deflate` **必填**（一个没有开关的块什么都没说，`TRANSPORT_BAD_DEFLATE`）；未知字段 `TRANSPORT_UNKNOWN_FIELD`；
区间在 `shared/workshop.js TRANSPORT_BOUNDS`（`level` 0–9、`threshold` 0–1048576 …），越界 `TRANSPORT_BAD_VALUE`。
**只把声明过的键交给 `ws`**：省掉的字段用库自己的缺省 —— 引擎不把库的缺省值抄成第二份真相。

**落实（与 `assets.serverPolicy` 的 `resourceServerPolicy` 逐字同一条三件套）。** 读声明 →
`transportPolicy(policies, { log })` 收敛成**一个进程级**的值（`perMessageDeflate` 是 `WebSocketServer` 的构造
选项，不是某个房间的属性）→ **启动日志点名**。多包声明时按 DESIGN §28.3「包 id 小的赢」，其余每一包**点名**
说明被谁盖住了。没有任何包声明时是 `false`，与这一刀之前逐字节相同。

**`welcome.transport`。** 生效值随既有的 `welcome` 帧送到客户端，形状
`{ deflate: boolean|null, params: string|null, maxPayload: number, threshold: number|null }`，来源是
`server/lobby.js welcomeInfo()`。两条纪律：

- **报的是生效值，不是声明值。** 声明了 `deflate: false`（或声明被更大的包 id 盖住、或最终没开）时
  `deflate` 就是 `false`、`threshold` 就是 `null` —— 报声明值会让面板显示一个不存在的压缩。
- **不新增协议消息。** `transport` 只是 `welcome` 里的一格字段（`S2C` / `C2S` 里都没有 `transport`），
  **`MOD_API_VERSION` 不动**。

**包只能观察，不能设值。** `pack.json` 里没有任何字段能往启动变量里写东西；`onBoot` 收到的是一份**深冻结**的
只读快照（见 §28.34）。

### 28.34 `uses: ["metrics"]`：只读指标快照，加 `boot(config)` 的冻结快照

**为什么在这一刀里。** §28.14 的源码扫描从这一批起**真的会拒 `process`**（见上面那一段）。一条只有禁令没有替代
品的规则会逼作者绕路（`globalThis['pro'+'cess']`），而「给 `/healthz` 加几个字段报内存 / 事件循环延迟」正是那三件
原始社区需求里的一条。`host.metrics()` 就是那个替代品。

**形状（`server/hostMetrics.js`）。** 返回一个**深冻结**的普通对象，字段闭集
`HOST_METRICS_FIELDS = [uptimeSec, rss, heapUsed, elu, loopP50, loopP95, loopP99, loopMax, sampleAgeMs, state]`：
`rss` / `heapUsed` 是字节，`elu` 是 [0,1] 的累积利用率，`loopP*` 是**毫秒**、最近一个采样窗口内的延迟。

- **是值不是句柄**：没有 `process`、没有直方图对象、没有定时器、没有函数。包拿不到任何能改变服务器的东西。
- **惰性启用**：`monitorEventLoopDelay` 与采样定时器**只在真有包声明 `uses: ["metrics"]` 时**才建（没装的进程
  开销为零）。
- **过期不给旧值**：采样器跑不动（事件循环被卡住）时 `loopP*` 全是 `null`、`state` 是 `stale`，并**点名 warn 一次**
  —— 「不许静默空白」与「不许静默旧值」是同一条纪律的两面。
- 没声明就抛 `MODULE_USE_UNDECLARED`（与 `io` 同一条，不是 `undefined`）。

**`boot(config)`。** `onBoot` 的回调收到一份**深冻结**的只读配置快照
`{ port, host, stateDir, env }`（`server/modModules.js bootConfigSnapshot`），`port` / `host` 是**真正绑到的**值
（快照在 `listen` 之后建）。`env` 是**白名单** `BOOT_CONFIG_ENV_KEYS`（`SP_BOT_EMOTES` / `SP_STAGE` /
`SP_STATE_DIR` / `SP_WORKSHOP` —— 引擎源码里读过的**全部** `SP_*`，`test/packServerSurface.test.js` 用反射钉住），
其余环境变量看不见。**包只能观察不能设值**：改一个冻结属性在严格模式 ESM 里直接抛。

### 28.35 `uses: ["route"]`：动态只读端点（`host.route(path, fn)`）

`pack.json.routes`（§28.13）能让包把一个**包内写死的 `.json` 文件**挂到一条绝对路径上，但「内容随运行时状态变」
表达不出来（今天的在线数、这一局的归档标签、包自己攒的计数）。这一格就是那条不手改的通道：一个**同步返回
JSON 可序列化值**的回调。

六条纪律（判据的唯一真相在 `server/http/routeMount.js`）：

1. **命名空间**：路径必须在 `/mod/<包id>/…` 里。两个包在结构上不可能撞车，核心命名空间也不可能被顶掉 ——
   包**没有位置**去点名 `/data/support.json`。
2. **核心保留路径表**（`RESERVED_ROUTE_PREFIXES` = `CORE_ROUTE_EXACT` + `CORE_ROUTE_PREFIXES`，都在
   `server/http/routeMount.js`）：常量端点 `/healthz`、`/data.js`、`/mods/catalog.json` 逐字比，命名空间
   `/ws`、`/data`、`/shared`、`/sim`、`/i18n`、`/mods`、`/media`、`/packs`、`/assets`、`/fonts`、`/workshop-*`、
   `/room-data` 按前缀比。这是**纵深防御**：将来谁放宽了第 1 条，第 2 条还在。分成两份是因为判据本来就不同 ——
   `/healthz` 是一条**路径**（`/healthz/x` 不是它），`/data` 是一棵**树**（`/data/x` 是它）；混成一张扁平表只能靠
   派生去猜哪条是哪条。**这张表只此一处真相**：动态通道与静态 `pack.json.routes` 通道（§28.13.2）读的是同一份。
3. **只有 GET / HEAD**（别的动词在 `server/http/routes.js` 就已经 405）。
4. **缓存只有 `no-store` / `no-cache`**，默认 `no-store`。刻意**没有** `public`：一个现算的端点说「可以公开缓存
   一天」几乎总是错的（静态 `routes` 有 `public`，因为它挂的是一个**文件**）。
5. **认证口径：与引擎其余 HTTP 面逐字一致 —— 没有认证。** 这台服务器没有任何需要凭据的 HTTP 端点。所以一个包
   **不得**把 `host.route` 当私有通道（凭据进 URL / 靠路径保密）—— 要私有数据就落 `host.io`。
6. **回调必须同步返回**（`Promise` 点名拒绝，不 await），体有上限（`DYNAMIC_ROUTE_MAX_BYTES` = 64 KB）。
   理由是实在的：单进程单事件循环，一个 `await` 的处理器就是一条能拖住整台服务器的路，而这一格**不**做每请求隔离。
   四种失败（`Promise` / `undefined` / 不可序列化 / 超限）各自点名并回 500，**不**回落到空体 200。

**与 §28.13 静态通道的关系。** 两条通道都声明同一条路径时**静态的赢**（`static.js` 里静态那一半先查）；
一条路径若与**核心**相撞，则**核心先吃**，两条通道都不得顶掉它（§28.13.2 写下静态那一半的判据）。

**静态 `pack.json.routes` 这一半在 0.15.2 收紧了（本节的立场原来写着「本批未动」）。** 旧立场是 `static.js` 里那句
「声明过的路径就是声明过的路径」，即一条声明能回答一条与核心挂载同名的路径。现在：`static.js` 仍然先查包声明，
但 `workshopRoutesFor` 在**建表时**就用**同一张**核心保留表（`coreRouteShadow`，与上面第 2 条同源）判一遍，撞上
核心的声明**不生效** —— 核心挂载照旧回答，包**不被拒**（已发布的包不会因为多写一条声明就装不上），并且**响亮
点名**：装载报告里一条 `errors`、启动日志里一行 `log.warn`（不许静默失败）。

判据刻意**只认真的撞上**，不是「用了 `/data` 这个词就当撞上」：`coreRouteShadow` 先看核心是不是**真的会服务这条
路径**（`dataDir` / `sharedDir` / `simDir` / `publicDir` 里逐字存在那个文件，或命中常量端点），只有那样才算顶掉。
线上有一条已发布的包（`ws-compression-reference`：`/data/ws-compression.json`，而 `data/` 下没有同名文件）正好落在
这条线上 —— 它今天照常服务、也**不**报警，因为那个文件不是核心的，它没有顶掉任何东西。副作用是好的：核心将来真的
长出 `data/ws-compression.json` 那一天，同一条声明**自动**让位给核心，不需要再改一次规则。

**两条被否掉的路（业主裁决 2026-10-11）：「不做动态 `route` 挂点、不做 `/client-build`」。** 写在这里，免得反复
被问 —— 也免得把「没做」误读成「漏做」：

* **动态 `route` 挂点只开包自己命名空间下的路径**：`host.route()` 的路径**必须**在 `/mod/<包id>/…` 里（本节第 1
  条）。引擎自己的顶层 HTTP 路由**不由包提供** —— 包没有位置去点名它们。
* **`/client-build` 这条引擎路由不做。** 它属于「引擎自己的 HTTP 路由」那一类，不由包提供；今天的**合法做法**是包用
  **静态** `pack.json.routes` 在**自己的命名空间下**放一份「字段契约」文档：先例是 `ws-compression-reference` 的
  `/data/ws-compression.json`（它今天照常生效，见上一段），以及 `256e45e4e588` 的 `/mod/healthz-ext.json` 与
  `/mod/client-build.json`。作者要用哪几个字段，就照这条路写一份自己的 JSON。
* **口径**：静态 `routes` 的保留表就是 `server/http/routeMount.js` 的 `CORE_ROUTE_EXACT`（`/healthz`、`/data.js`、
  `/mods/catalog.json`）加 `CORE_ROUTE_PREFIXES`（`/ws`、`/data`、`/shared`、`/sim`、`/i18n`、`/mods`、`/media`、
  `/packs`、`/assets`、`/fonts`、`/workshop-*`、`/room-data`），两条通道读的是同一张表。**`/mod/…` 不在那张表里**：
  表里的 `/mods` 按 `:96` 的 `p === prefix || p.startsWith(\`${prefix}/\`)` 比对，`/mod/<包id>/x` **不**命中它
  （`/mods` 与 `/mod/` 是两个不同的命名空间）—— 所以包的自留地正是 `/mod/<包id>/…`。

### 28.36 作者自备 CDN 的语音素材（`{ url, sha256, file }`）

**业主口径（2026-10-11）：「分发官方语音不行，但应该留出下载作者语音素材的 CDN 链接支持」。** 所以这一格做的事
永远只有一件：按**作者在 `pack.json` 里写下的地址**把字节取回来。

**声明。** `voices` / `voiceLangs` 表里的一个条目可以是一个对象而不是包内相对路径字符串：

```json
{ "voices": { "char_x": { "place": [
  "voice/char_x/place_1.mp3",
  { "url": "https://作者自己的域名/x/place_2.mp3", "sha256": "<64 位小写 hex>", "file": "voice/char_x/place_2.mp3" }
] } } }
```

字段闭集 `VOICE_CDN_FIELDS`（`VOICE_CDN_UNKNOWN_FIELD`），三条一体：`url` 必须是绝对 `https://`（`http:` /
`data:` / `file:` / 协议相对 / URL 里带凭据一律 `VOICE_CDN_BAD_URL`）；`sha256` 必须是小写 64 位 hex
（`VOICE_CDN_BAD_DIGEST`）；`file` 必须是 `assets/` 下的安全相对路径 + 音频扩展名
（`VOICE_CDN_AUDIO_EXTS` = `.mp3` / `.ogg` / `.wav` / `.m4a`，与 `/workshop-assets` 那条路由的白名单同一批，
否则取回来也送不出去）。声明了它就**必须**写 `license`（`VOICE_CDN_NEEDS_LICENSE`）：素材的再分发者是作者，
授权问题不因为字节放在别人的 CDN 上就消失。**CDN 条目不需要 `assets/` 文件夹**（它读的不是包里的字节），
但包内路径的那一条既有规则（`VOICE_NEEDS_ASSETS`）一字未动。归一化结果里 `voiceCdn` **只在声明过时才存在**
（与 `skins` 同一条纪律：给每个包都加一个空数组会换掉所有已发布包的哈希）。

**装载（`server/voiceCdn.js materializeVoiceCdn`）。** 在**合并语音表之前**取、核对、落缓存：

- **内容哈希是唯一判据**：字节先过作者声明的 sha256，对不上就 `VOICE_CDN_DIGEST_MISMATCH`，**不落盘、不进覆盖表**；
- **缓存位置**：`<状态目录>/voice-cdn/<sha256>`（`voiceCdnCachePath`）。键就是摘要 ⇒ 两个包声明同一份字节只存一份，
  第二次不联网。先写 `.part-<pid>` 再 `rename`，半截的下载不会在缓存里留下一个「看起来命中」的文件；
- **有界**：单条超时 `VOICE_CDN_TIMEOUT_MS`（20 s）、单条上限 `VOICE_CDN_MAX_BYTES`（24 MB）；
- **送出去走既有路由**：`server/http/static.js` 的 `/workshop-assets/` assets 分支在拼接包目录**之前**查一张覆盖表
  （键与 URL 逐字同形 `<包id>/<assets 内的相对路径>`）。客户端看见的 URL 与「素材本来就在包里」时**逐字相同**；
- **失败要响亮**：每一条失败回一条 `{ pack, file, url, code, reason }`，`server/index.js` 逐条 `log.warn` 点名，
  并且把那条台词从**客户端读的语音表里摘掉**（`dropFailedVoiceCdnFiles`）—— 宁可让那个语种回落到默认配音，
  也不要留一条永远 404 的静音台词。一条外部 CDN **不**让服务器起不来。

**三条红线怎么守。** ① 引擎里**没有一个语音素材主机名常量**，也没有「已知素材站」白名单 —— 主机名只来自
`pack.json`（要写白名单就得把官方域名写进引擎，那正是红线本身）；② **没有新增任何下载路由**：取回来的字节由
既有的 `/workshop-assets/` 送出；③ **`VOICE_LANG_*` 一个字没放宽**：语种闭枚举（`shared/constants.js`）、槽位闭
枚举、以及「默认语种不能写进 `voiceLangs`」三条都没动，也没有任何便于拿官方语音的新通道。

### 28.37 `/healthz` 的只读字段：确认可用，以及两件**做不到**的事

挂点**今天就有**，不是本批新增的：`uses: ["healthz"]` 的回调返回一个**扁平对象**（值只能是字符串 / 数字 / 布尔 /
`null`，≤ 12 字段 / 2048 字符，`server/modModules.js HEALTHZ_LIMITS`），落在
`/healthz` 的 `modHealth["<包id>"]` 下（按包 id 分组，两个包不能互相盖字段）。回调抛异常、返回嵌套对象或超限，
都是**点名 warn + 跳过那一条**，别的包照旧报。没有包声明 `healthz` 时 `/healthz` 里**没有** `modHealth` 这个键
—— 干净安装的字节不变。

两件如实说清的事：

- **`ok` 恒为 `true`、状态码恒为 `200`**（`server/http/routes.js healthReport`），本批**不动**。`ok` 的含义是
  「这个 HTTP 服务在答话」，不是「一切正常」；让包的字段去影响它是把运维端点变成一条包可写的健康闸门。
- **「不 ok 时 503」做不到，本批也不做。** 要那个语义就得先定义「谁的不 ok」：是所有已装包都说 ok？还是任一包说
  不 ok 就 503？前者给不出信息，后者等于**一个第三方包可以决定整台服务器被判死**（负载均衡/容器编排会照它摘流量）
  —— 那正是本层一直在拒绝的能力形态。所以这一格只报事实，判断留给运维。

### 28.38 `ctx.battle.damage()`：逐单位伤害读数，让包自己算 DPS

§28.30 把「伤害看板」拆成了两半：总伤今天就能读（`m.result` 的原样透传），逐单位 / 逐场那一半「今天读不到」。
这一节补上后半：一格**只读**的逐单位 / 逐人累计伤害，加一个**时间基准**，让包自己算 DPS。

**为什么引擎必须给，而不是包自己算。** 默认路径下战斗在**这台机器**上跑（`public/js/battle/runner.js`），
伤害元组走 runner **自己的** listener map（`:282` 的 `emit`），**根本不进 `net`** —— 面板订阅不到（§28.30 已经
查明）。包要想自己算，只能再去订阅一条它拿不到的通道，或者自己维护第二份累计；而**第二份账与引擎那份必然会对不
上**（`m.result` 报的是服务端按 `_perPlayer` 累出来的数）—— 那正是「面板可以画错、但不能算错」要消灭的东西。
所以这一格只能由引擎给，而且给的是**同一本账**。

**这一格不是新账，是一个读者。** 伤害早在模拟里逐次命中就记好了：`server/sim/damage.js:370` 写
`source.stats.dmg`，`:371` 写 `battle._perPlayer[ownerId].damageDealt`，`:352` 写 `bossDamage`（单位那本账在
`server/sim/units.js:97` 初始化）。`battleRunner.damage()`（`public/js/battle/runner.js`）只做一件事：**把这些
已经在那儿的数字按面板看得懂的形状抄出来**。

* **不维护第二份累计**：`step()` / `drainEvents()` / `emit` 一行都不动，也**没有**逐 tick / 逐命中的新工作。实测
  代价（`_up/dps-probe-3.mjs`，四个公开 perf spec 前 600 tick、N=30 交替取样）：写元组本体 95（normal）/ 425（boss）
  / 435（hidden）次每 1000 tick，各配置的 p50 差值 ≤ 1.1 ms，全部落在噪声（sd 2–9 ms）内。
* **配的是引擎自己那本账**：逐人那几行照 `Battle._buildResult()` 的写法配对
  （`server/sim/battle/lifecycle.js:209-210`：座位在 `battle.players[]`，账在 `battle._perPlayer[playerId]`，
  **不是同一个对象**）。写错一边（例如 `getPlayer(pid).damageDealt`）会永远读到 `0`，而单位那几行照样有数字 ——
  这个静默错误由 `test/modClientBattleReads.test.js` 钉住。

**形状**（一次读一份**新的、冻结到第二层**的副本）：

| 字段 | 含义 |
|---|---|
| `battleId` / `fieldId` / `kind` | 这一场是谁（`b.start` 的那三个字段；`fieldId` 缺失时是 `null`） |
| `authoritative` / `own` | 这场是本机在算的（要上报），还是替别人放的显示副本；与自己那一场的关系（`own`） |
| `gt` / `t0` | **时间基准**：`gt` = `Battle.time`（战斗内秒），`t0` 恒为 `0`（一局一场）⇒ `dps = dmg / (gt - t0)` |
| `players[]` | `{ playerId, dmg, bossDmg, kills, heal }`，**这一场真在场的玩家**（`battle.players`），次序即场上次序 |
| `units[]` | `{ id, uid, defId, ownerId, kind, dmg, kills, heal }`，场上己方单位（操作员 / 召唤物 / 装置） |

三条**口径**决定，都是刻意的：

* **`dmg` / `bossDmg` / `kills` / `heal` 取整**，与 `shared/protocol.js` `compactResult`（结果页读的那一份）同一个
  口径。DPS 是速率显示，给未取整的浮点只会**装作更精确**，还会让面板的数字与结果页差一个尾数。
* **`players[].dmg` 已经含 `bossDmg`**（`damageDealt` 就是这么累的，与 `m.result` 的 `stats.dmgDealt` 同源），
  所以「总伤」与「领袖伤害」都在这一格里 —— 作者不必再拼 `m.result` + `b.pool` 两个面。
* **`uid` 必须给**：那是这块棋在那个玩家棋盘上的 id（与 `battleRunner.unitIdOf()` / 结果页 `unitsEnd` 同一个号）。
  面板对名单靠它；少了它，作者只能拿战斗内的 `id` 去猜。装置（`ownerId: null`、`uid: null`）也在 `units[]` 里，
  它们打的伤害一样进拥有者那本账，对不上号的几行按 `kind` 自己归并即可。

**只给本场 —— 这是边界，不是缺陷。** 读的就是**屏上这一场**（与 `battleRunner.unitStats()` 同一语义，含正在播的
显示副本）。**队友那几场不在这一格里**（一次战斗只有一个 `battleId`），正在准备的下一场也不在。`ctx.battle` 那一格
**不合并**多场 —— 合并会把「别的玩家同一场」算成另一份，也会把副本重复计入。面板要**全队总伤**时走 `m.result`
（`players[].stats.dmgDealt`，服务端按每个玩家累出来的全队口径；§28.30 那张表）。

**只读语义。** 每次调用都是**一份新的、冻结到第二层的副本**（外层对象、两个数组、以及每个单位 / 每个人那一行都
`Object.freeze`）：面板写它当场 `TypeError`，引擎之后的新伤害也不会回溯进**已经发出去**的那一份。

**这里不复用 `readonlySnapshot`，是有意的。** 那个函数的底图缓存按**源对象**缓存（`snapshotCache`），而这一格每次
读都造一个**新对象** ⇒ 用它等于每次读往缓存里塞一个新键，一局几千次读就把缓存撑爆。它适用的场合是「每次读拿到
同一个源对象」（`ctx.data.get()` 那几张表）。

**拿不到就是 `null`，而且绝不让这一格把别的东西带崩。** 四种出口分开写（`public/js/ui/extensions.js`）：

| 情形 | 返回 | 日志 |
|---|---|---|
| 注册点没被注入战斗运行时（Node 用例、极小的宿主） | `null` | **一行**：`CLIENT_BATTLE_UNAVAILABLE (absent)` |
| 注入的 `damage()` 抛了 | `null` | **一行**：`(threw)` + 可读原因 |
| 返回值不是一个对象（数组 / 字符串 / 数字） | `null` | **一行**：`(bad-shape)` —— 半个读数比没有更危险 |
| 引擎说这一场拿不到（`null`：没有正在跑的战斗、战斗还没建好） | `null` | **不记** —— 那是正常状态（准备期 / 结算期），不是缺件 |

每种原因只记一行（与 `CLIENT_TRANSPORT_UNAVAILABLE` 同一条 `dedup` 规矩、同一个理由：面板每秒可能读一次，刷屏的
日志与没有日志一样没用），而且走**注册点**的 `log`（引擎级事实，不在每个读它的包的日志里各说一次）。

**注入路径。** `public/js/main.js` 把**一个函数**交给注册点：`createPanelRegistry({ …, battle: battleRunner })`
（`deps.battle.damage()`）。注入的不是 runner 句柄 —— 与 `settings` / `data` 同一条边界（**不传什么就是边界**）：
面板拿不到 `step`、拿不到 `Battle`、拿不到 `_entries`、也拿不到 `stats()` 那种运行时可写面。

**一格里有什么、没有什么：**

| 有 | 没有（这一格的边界） |
|---|---|
| `ctx.battle.damage()`（唯一成员，门面冻结） | `ctx.net.damage()` —— 模拟事实**不挂在 `net` 上**（`net` 那六格都是连接事实） |
| 逐单位 / 逐人累计伤害 + `gt` / `t0` | runner 句柄、`Battle`、`_entries`、`stats()`、`on('ev')` |
| `uid` / `defId` / `ownerId` / `kind` 供对名单 | 任何写入、任何订阅、任何帧 |

**表面与守卫。** 这一格**不新增 `pack.json` 声明**（纯读数，没有 schema 符号可锚）⇒ **不进 `shared/modSurface.js`**，
与 §28.24 / §28.25 / §28.32 同一先例；**`MOD_API_VERSION` 不动**（加能力不加版本）。守卫是
`test/modClientBattleReads.test.js` 那一组：

* **数字是真的**：逐单位 / 逐人与模拟自己那本账（`u.stats.dmg`、`battle._perPlayer[pid]`）逐个相同，含 `uid` 映射与
  取整口径 —— 配错对象、抄错单位、少算一个人当场红；
* **只读**：每次一份新的冻结副本，面板改不了、引擎之后的新伤害不回溯（`readFileSync` 级的源码判据也钉住
  「`damage()` 里没有 `step()` / `drainEvents` / `emit`」）；
* **零协议消息**：真 `Net` 的四个出口（`send` / `request` / `sendResourceMessage` / `_sendRaw`）全计数，读这一格
  **一次都不许发生**（`test/modClientNetReads.test.js` 的同一套判据）；`damage` 既不是 S2C 也不是 C2S；
* **不碰 `net`**：`runner.js` 对 `net` 仍然只有 `on` / `request` / `send`，面板那份 `ctx.net` 门面的键集**一个都没多**；
* **零副作用**：面板活着、真的消费这一格去算 DPS / 总伤 / 领袖伤时，同一场战斗的结算账与不变量照旧
  （`test/modClientSettings.test.js` 的「模拟侧零副作用」那一条现在也读这一格）。

### 28.39 `pack.json.variants`：变体 / 口径层（闭枚举，不是数值覆盖通道）

**要解决的那面墙**逐字记在 `shared/workshop.js` 的 `PACK_FIELDS` 注释里：`variants` 是 0.10.0 时代三个社区 mod
「写了等于没写」的键之一 —— `normalizePackManifest` 从没读过它，`{content:["chess","variants"]}` 归一化之后
只剩 `["chess"]`。`docs/WORKSHOP.md` §1.1 那张表把它记成「**没有通道**」，并写明要做就得先在引擎里做出
「口径 / 变体」这一层。这一节就是那一层。驱动它的是投稿 `e4fe4d5cf0a0`（「干员满练mod」）：同一份数据要两套
表现 —— 满练度 / 12 部署位 —— 由房间选一套。

**它不是什么，比它是什么更重要。** 一个能指定任意文件覆盖、或让包直接写数值的包格式**就是安装器**：
`official` / `config` / `meta` / `shared` / `theme` / `serverModules` 那六格「刻意没有通道」的判断逐字适用
（`AGENTS.md`「Official first … the maintainer's decision only」）。所以这一层收成**闭枚举的口径声明**：
包说的是**「哪一套」，不是「改成几」**。值由引擎自己给，且**一个数只有一个真相**（§28.35 那条口径之外的又一处：
从前 `12` 硬编码在 `server/match/effectsMeta.js` 的 `setDeployCapAtLeast` 里，本刀把它提成
`shared/constants.js` 的 `DEPLOY_CAP_MAX`，两处都读它）。

**轴表**（`shared/variants.js` 的 `VARIANT_AXES`；**只在被一份真实投稿要求时才加轴**，不许为将来预留空轴）：

| 轴 | 选项 | 缺省 = 引擎今天的行为 | 动什么 | 依据 |
|---|---|---|---|---|
| `training` | `official` / `full` | `full` | 这一局用哪一套练度 | 投稿 `e4fe4d5cf0a0` 的 `training` 一段（258 条干员 + 19 个召唤物）。落点是引擎**已有的** `room.loadout.ops`（`{ potential, cultivate }`，`shared/potential.js` 的 `POTENTIAL_DEFAULT` / `CULTIVATE_DEFAULT`），**不在数据里塞第二套数值** |
| `deploy` | `official` / `max` | `official` | `config.economy.deployCap` | 同一投稿的 `deploy.config.economy.deployCap = 12`；官方 `maxBattleChessCnt` 是 8（`data/config.json`，`tools/build-data.mjs`），`max` = `DEPLOY_CAP_MAX` |

**形状**：`variants: [{ axis, default?, name?, desc? }]`，条目字段闭集；归一化结果**按轴名排序**（键序是清单字节的
一部分，不许随作者书写顺序变）。**声明了但选了缺省**与**没声明**在**数据上**等价 —— 但归一化清单**不丢**作者写的
那个键（「选了 official」要能读回来）。

**四条判据**（判据只有一份：`shared/variants.js`，装载器与校验器都调它）：

1. **闭枚举、响亮失败**。`VARIANTS_BAD_SHAPE`（不是数组 / 条目不是对象 / 未知字段 / `name`·`desc` 写坏）·
   `VARIANTS_UNKNOWN_AXIS`（轴名不在表里，文案列出全部轴）· `VARIANTS_UNKNOWN_OPTION`（`default` 不在那个轴的
   选项里，文案列出该轴全部选项）· `VARIANTS_BAD_DEFAULT`（`default` 是 `null` / 数字 / `false` 这类「不是选项名」
   的东西 —— 与 §28.5 的 `BAD_API_TYPE` 同一条理由：非字符串会被读成「用了轴的缺省」，即**静默不是作者写的那个**）·
   `VARIANTS_DUPLICATE_AXIS`。**每一条都是整包拒绝**，不是忽略、也不是回落。
2. **缺省逐字节不变**。不声明 `variants` 的包归一化清单里**不长出这个键**（无条件写进去会让**所有**已发布包的
   内容哈希改变，房间的摘要闸门随即误判，§28.2）—— 与 `skins` / `voiceCdn` / `assets` 同一条纪律。
   `GameData` 拿不到口径时 `deployCap` 逐字是 `posIntOr(economy.deployCap, DEFAULTS.deployCap)`。
3. **声明了必须进身份哈希**。`identifyPack` 哈希的是归一化清单的 `canonicalJson`（`server/workshop.js:834`），
   所以只要第 2 条那条「写了才进清单」成立，这一条自动成立 —— 而它**必须**成立：只差口径的两份包摘要若相同，
   同一个摘要下就有两种对局行为（§28.2）。
4. **必须 `combat: true`**（`VARIANTS_NEED_COMBAT`）。判据是**能力**而不是意图，与 `server.meta`
   （`META_NEEDS_COMBAT`）/ `server.battle`（`BATTLE_NEEDS_COMBAT`）/ `modules[].uses: ["matchClass"]`
   （`MODULES_NEED_COMBAT`）同一条线：一条**能**改结果的口径声明必须进房间摘要闸门与 golden 语料。
   位置在 `BAD_COMBAT`（类型）之后、`EMPTY_PACK` 之后 —— 一个只声明了口径、什么都没带来的包，真问题是「空包」。

**不是贡献项**：与 `support` / `playtest` 同一个语义 —— 口径选的是引擎已有的一套表现，不是内容。所以
`contributesDecl` 不数它，一个只带 `variants` 的包照旧 `EMPTY_PACK`（文案里点名 `"variants" is NOT a contribution`）。

**多包抢同一个轴**：按既有的「包 id 字典序小的赢」（§28.3，与数据记录 / kit / 图标同一条），由
`mergeVariantDecls` 合成，输的一方进 `overridden` 供调用方点名报告。

**执行点**：口径**不写进 `data/*.json`**（那张离线重建表要能逐字节复现 `data/`，§数据契约）。它在**这一局**生效，
走的是既有的那条链，**不加协议消息**：

1. `server/index.js:187` 构建 `welcome.mods` 的条目时**带上 `variants`**（只在声明过时才存在这个键）。`modDigest`
   只哈希 `[id, hash]` 对（`shared/modIdentity.js:196`），所以带它**不改任何摘要** —— 这一点必须钉住：改摘要等于让
   每个已发布的包在同一条房间里被判成「另一个包」。
2. `modSetOf` 只按 `isModEntry`（id / hash / layer / combat / api）**过滤**、不剥别的键，所以房间集合
   （`server/lobby.js:1476` 的 `room.modSet || this.modSet`）把声明原样带到 `Match`。
3. `Match` 用 `mergeVariantDecls(mods.packs)` 合成轴表（`server/match/Match.js`），交给 `GameData`
   （`opts.variants`），`GameData.deployCap` 读它。

第 1 步是这一层最容易做坏的地方：漏掉那个投影，`Match` 读到的是 `undefined`、口径**静默不生效**
（`test/workshopVariants.test.js` 的「装载结果 → 房间 mod 集合 → `Match` 的那条链」那一节钉住它）。
没有包声明口径 ⇒ `[]` ⇒ 每一处读点都走今天那条缺省路径。

**既有静默失败一并修掉**：`normalizePackManifest` 的 `content` 成员资格从前是
`raw.content.filter((f) => WORKSHOP_CONTENT_FILES.includes(f))` —— 一个不认识的条目被**安静地丢掉**，
于是 `{content:["chess","variants"]}` 的作者看到「包合法、我写的那件事没发生」。这正是本格式存在的理由
（§1.1 那句「不认识的声明必须响亮失败」），只是位置从「顶层键」挪到了「这张表的成员」。本刀改成
`UNKNOWN_CONTENT_FILE` 点名整包拒绝（`config` 与 `variants` 都在文案里被点名说明它们**没有** content 通道）。

**`MOD_API_VERSION` 不动**（仍是 `1`）：`api` 是**可选项**（§28.5），没声明 `api` 的包一个字节都不受影响，
而加一格字段不抬版本有 `:434` 的先例。**不新增协议消息**：口径是服务端的判据，客户端读到的仍然是它一直在读的
`priv.deployCap`。

**还没做的**：`training` 今天只落在引擎已有的练度开关（`room.loadout.ops`）上；把一名**普通**干员的精锐形态
数值投影给它（投稿 `training` 一段真正想做的那件事：`_a` 拿到 `_b` 的 `status`/`stats`/`skills`/`talents`，
258 条 + 19 个召唤物）**不在本刀**，需要独立立项 —— 它是「练度投影」这条新规则，不是声明通道。





