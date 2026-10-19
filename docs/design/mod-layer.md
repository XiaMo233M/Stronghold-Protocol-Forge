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
| **A** content | declarative data, no code: the workshop pack of today (`shared/workshop.js:3394` `applyWorkshop`) | nobody — it is merged into the data every consumer reads (`server/data.js:106`) | always, and never detectably by the golden corpus (the corpus is generated from the official `data/*.json`, `test/golden/README.md:8-10`) |
| **B** server logic | hooks and kits: the code of `workshop/<pack>/kits/<id>.js` (`server/workshop.js:390` `loadWorkshopKits`) — one file-name rule over **two key spaces**, operator and summon (§28.12.1) | **the server only** — this is new | only through the hooks it registers, and only after a declared intent passes deterministic verification |
| **C** client UI | rendering, themes, panels | the player's tab | never |

Two sentences in the repository already fix the constraints this design must satisfy at once, and they are currently
written as if they conflicted:

- `docs/PACKS.md:131-139` — "the maintainers' study of mods, 2026-10-07": server-side only for gameplay; a content hash
  in the handshake (`welcome`, `/healthz`, the BattleSpec) before data packs ship; **no third-party code** ("a pack type
  that runs code is a separate decision of the owner's"); golden stays on the original content.
- `docs/WORKSHOP.md:672` — the behaviour layer **is** an owner decision, taken later: "scripts run in the client
  (default `SP_COMBAT=client`), and `SP_VERIFY` can only recompute the result, not stop the script".

The ruling resolves them: **B runs on the server, so the `docs/PACKS.md:137-138` objection no longer applies** (the
owner has now taken that separate decision), and the `docs/WORKSHOP.md:672` warning stops being a permanent hazard
because a room containing a B pack is no longer simulated in the player's tab (§28.4). The three-channel distribution
(`docs/WORKSHOP.md:672`) stays.

What already exists, and must not be rebuilt: the two event buses (`server/sim/battle/hooks.js:17` `on`, `:57` `emit`;
`server/match/effectsMeta.js:48-52` the 19 meta hooks), the kit injection point `Battle opts.kits`
(`server/sim/content/index.js:112-114`), the pack loader and its file-system discipline
(`server/workshop.js:27-100`), the static kit checks (`shared/kitAuthoring.js:182` `validateKit`), and the 8-layer
author-side validator (`tools/workshop-validate.mjs:11-14`). The middle layer is the **seam** between them: who a pack
is, who wins when two of them want the same id, and what has to be true before its code is allowed to run.

### 28.2 Identity (gap 1)

Today a pack has an `id` (the directory name, `shared/workshop.js:377-379`) and free-text metadata
(`shared/workshop.js:700-703`), and the BattleSpec carries only `SPEC_VERSION = 1` (`server/sim/spec.js:46`, written at
`:61`) plus a list of kit **URLs** (`server/sim/spec.js:79-81`; produced by `server/workshop.js:491`). There is nowhere
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

1. `pack.json` — hashed **after** `normalizePackManifest` (`shared/workshop.js:1802`), so the hash covers the pack's
   effective declaration (normalized `overrides`, `content`, icon tables, `art`, `support`, `voices`), not its
   whitespace. Two spellings of the same pack then hash the same, and a declaration the loader silently dropped
   (`shared/workshop.js:1859` filters a malformed `overrides` entry in silence today) cannot hide behind the hash.
2. every declared content file, after `normalizeContentFile` — the same normalized records the loader merges.
3. **every other regular file under the pack directory** — its bytes, byte for byte. That is `kits/**`, `assets/**`, the
   declared panel modules and stylesheets, the `server.meta` / `battle` / `room` / `modules[*].entry` modules, the i18n
   and notice files and the root-level files — and, the reason this rule exists at all, the files **nothing declares**
   that one of those declared modules `import`s or reads at runtime (`server/rules.mjs`, `data/rules.mjs`,
   `client/helper.js`, `kits/lib/util.js`).

**The one enumerator, and why there is exactly one** (业主裁决 B, 2026-10-11). "Which files does this pack have" is one
function, `server/packFiles.js listPackFiles` (`:42`): recursive, sorted by path, symlinks neither followed nor listed,
`[]` when the directory is not there. `identifyPack` (`server/workshop.js:949`) builds the manifest from it, and
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
(`server/workshop.js:1345` — a version credential that is not a content hash, and the reason `docs/WORKSHOP.md:610`
records content addressing as unimplemented), the pack directory's absolute path, and any engine code. The last one
matters and is the answer for the third file the ruling names:

- **`shared/loadoutRecord.js` gets no new field, and that is a ruling, not an omission.** That module derives the
  record a unit actually fights with from `data/chess.json` plus the player's picks — `resolveRecordLoadout` (`:18`),
  `composeStats` (`:37`), `composeTalents` (`:48`), `loadoutRecord` (`:79`). If the pack hash covered *derived* records,
  every engine change would change every pack's hash and no pack could prove it was the same pack as yesterday. So: the
  hash covers a pack's own bytes; the **engine** half of the identity is `api` (§28.5). One consequence has to be
  designed for rather than discovered later: a loadout pick is validated against the **merged** data
  (`shared/protocol.js:235` `checkLoadout`, `:266` `resolveLoadout`), and an id that exists on the server can be an
  unknown id in a client that has a different pack set — where `lookup` returns `null` (`server/data.js:156-159`) and
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
  (`server/net.js:796-797` builds it from `handler.welcomeInfo()`), so the client knows the server's mod set the moment
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
| a **new** id claimed by two packs — a data record | **refused, and the report names the pack that holds it** (neither author's claim can be preferred) | `shared/workshop.js:3251-3254` (`PACK_ID_COLLISION`, `definedBy`) |
| a new kit id claimed by two packs | **refused, and the report names the pack that holds it** | `server/workshop.js:1249-1253` (`KIT_ID_COLLISION`, `definedBy`) |
| two packs **overriding the same existing record** (an official id, or a record another pack contributed) | **the smaller pack id wins + the conflict is reported** (`definedBy` names the pack that was passed over) | `shared/workshop.js:3251-3254`, `:3251-3254` |
| an icon / item icon / art entry claimed by two packs | **the smaller pack id wins**; the loser is reported and named | `shared/workshop.js:3763`, `:3838`, `:4175` |
| `overrides` declares the replacement of an **OFFICIAL** id | **allowed, and the declaration is what makes it allowed** | `shared/workshop.js:14-16`, `:3251-3254` |
| anything, between two packs | **the smaller pack id wins — on every face** | one comparator: `shared/workshop.js:2894` `byPackId` |

Two rules, not three, and they are the only two:

1. **An official record is never replaced without a declaration.** Not negotiable: silently redefining a shipped
   operator would corrupt every match on the server (`shared/workshop.js:14-16`).
2. **Between two packs, the smaller pack id wins, for every kind of contribution** — data, kit, icon, item icon, art.
   Equal ids cannot occur: the manifest must equal the directory name (`shared/workshop.js:1831` `PACK_ID_MISMATCH`).
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
one — they agreed only because the production loader sorts directory names (`server/workshop.js:34-40`) and the manifest
rule forces `id === directory`. `byPackId` (`shared/workshop.js:2894`) is now exported and used by every face, including
the kit loader (`server/workshop.js:401`), so the winner is a property of the pack ids and not of who called the merge.
The two in-memory callers that can pass any order — the tests, and the editor — no longer decide anything by accident.

**Attribution.** Every collision error carries `{ pack, code, file, id, definedBy, reason }`, where `definedBy` is the
pack id that holds the record, or the string `official`. The text says the same thing:

- official: `"<id>" already exists in the official data — add "<file>:<id>" to pack.json overrides to replace it` (`OFFICIAL_ID_COLLISION`)
- against another pack: `"<id>" is already contributed by pack "<X>" — the pack with the smaller id keeps it (DESIGN
  §28.3). Rename this record, or let "<X>" drop it; an "overrides" entry does not win against another pack` (`PACK_ID_COLLISION`)
- kit: `kit "<id>" is already defined by pack "<X>"` (`KIT_ID_COLLISION`, `server/workshop.js:1249-1253`)
- icon / art: `another pack (<X>) already ships …` (`ASSET_COLLISION`, with `definedBy` as well)

Why it matters enough to be a section: the data path used to say "**official** data" for both cases, because the
variable holding "official + every pack merged so far" was called `official` (it is `prior` at
`shared/workshop.js:3260` now). The author's next move was to open `data/chess.json` and look for a record that is not
there. Both defects — the wrong attribution and the unnamed kit holder — are fixed in the first step of the slice.

**Cross-pack conflicts are reported once, at load, in one shape.** The report used to be split across three carriers
with three shapes: the overlay's `report.errors` (logged by `server/data.js:95`), the icon and art collisions on that
same array, and `loadWorkshopKits`' own `errors` (`server/workshop.js:508`) — no single line an author could grep. Every
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
and `docs/WORKSHOP.md:672` records the consequence honestly. Under the ruling, a room whose mod set contains any
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
now runs those fields itself, sliced by the existing wall-clock budget (`server/match/Match.js:443`, default 8 ms per callback).
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

**`battle.errors` is full at 100 and the rest is lost.** `server/sim/battle/hooks.js:268-271` deduplicates by `label|who|message` and
`:173` stops at 100 entries; a battle spammed by a mod therefore silently loses every error after the first hundred,
and they are only reachable through `m.simErrorLog` (`server/match/Match.js:127-129`) or `tools/matchrun.mjs --errors`. The cap is
right (it is a memory and wire budget) so the design keeps it and adds what the cap omits: **per-owner counters** —
`battle.errorCounts` keyed by owner label, unbounded in keys but bounded in memory, so the *summary* is complete even
when the detail log is truncated. The counters are what reaches the author (§28.7).

**Time budget.** There is no timeout that can interrupt a handler: a tick is one synchronous call
(`server/sim/battle/lifecycle.js:70`), so a loop in a pack hangs a battle in the browser and, for a server-run field,
a scheduler callback. The design does not pretend to add preemption (that is a runtime change, not a middle-layer one).
What it does is make the budget visible and enforceable at load: a pack's verification run (§28.6) measures the wall
clock of the fixed scenario list with and without the pack, and a `combat: false` pack whose cost exceeds a declared
budget is refused. On the client side, layer C is the only place a mod touches rendering, and B never reaches a tab
(§28.4 first paragraph) — so the "no budget in the browser" hole is closed by removing browser execution rather than by
inventing a timer.

### 28.5 Versioning (gap 4)

`gameVersion` is metadata and nothing reads it (`docs/WORKSHOP.md:610` records version alignment, dependency
declaration and content addressing as unimplemented), while the editor writes the string `'0.2.2'` in seven places
(`editor/server.mjs:1986` and six siblings, `tools/workshop-scaffold.mjs:82`, `editor/ui/pack.js:94`). Two problems,
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
| **degrade** | a `layer: A` pack whose `game` range excludes the installed game version | load only the records that still pass the existing per-record validators — the same functions `tools/workshop-validate.mjs` already runs as layers 2–8 (`:482`, `:511`, `:551`, `:578`, `:592`, `:609`) — report every dropped record by id, and mark the pack `compatible: false` in the sense `shared/packs.js:148-149` already uses. |
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
   places, while `this.flags` is assigned at `server/sim/Battle.js:150` and line 113 is a statement about `this.data`.
   The citation guard (`test/promptCitations.test.js`) could not see it: it verified only that the cited line exists and
   is not blank. **Deliberately not fixed at the time**: the drift was a consequence of the in-flight 0.2.2 port moving
   every server-side line number, so the fix belonged to that port rather than to a second branch editing the same file
   (owner's coordination of 2026-10-09). The upgraded guard below therefore **reported these three**, each with the line
   the member really lived on, and turned green by itself once the cited line followed the member (`:113` → `:149`) — no
   test had to be touched for that. A fourth instance of the same defect, `docs/prompts/kit.md:460`, has no dotted member
   next to it and is not
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
| `combat: true` | run the fixed scenario list twice with the pack loaded and require digest equality (the `--twice` idea, `test/golden/README.md:44`), plus the two execution paths the ruling keeps (server headless vs. the browser's module list, `public/js/battle/runner.js:298-303`) | the pack is non-deterministic, or the two paths disagree. |

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
   `applyWorkshop` merges anything (`server/data.js:106`). "Verification fails → the pack is not loaded" is the owner's
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
| a kit that returns no `skill` leaves the operator with no skill (`docs/WORKSHOP.md:2571`) | the loader knows both facts — a kit was injected *and* `skillSource` says where the skill came from (`server/sim/content/index.js:214`, `:219`). A pack kit with no skill becomes a validation error the editor shows before saving, not a live surprise. |
| a `chess.assets.spine` that points at an uninstalled model draws a flat portrait and logs nothing (`shared/workshop.js:3385-3417`) | already solved by `report.looks` (logged at `server/data.js:97`) — generalise it: every field that degrades silently gets a `looks`-style check, and the editor surface must show it, not only the server log. |
| the editor deliberately does not import author files (`editor/server.mjs:428-431`) | **do not change this.** An HTTP endpoint that executes author code is a code-execution surface. Instead expose the verifier of §28.6 as an explicit action that runs in the **playtest subprocess** (`server/index.js:72-76` `SP_WORKSHOP`), which is already a separate process. |
| runtime errors land in a 100-entry array reachable only through `m.simErrorLog` (`server/match/Match.js:127-129`, `server/sim/battle/hooks.js:167-185`) | per-owner counters (§28.4), plus the room's mod digest on every error line, so a player's bug report carries the identity of the content it came from. |

### 28.8 Layer C and the client: a minimal registration point

The client has no plugin surface: `public/js/main.js:75` is a frozen `SCREENS` object, `:311` resolves a route as
`SCREENS[route] || LobbyScreen`, and the routes themselves come from `selectRoute` (`public/js/store.js:126-136`). What
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

Two channels, already decided (`docs/WORKSHOP.md:672`): the official bundle stays clean (`docs/PACKS.md:133-134`,
`:139`), workshop content ships separately through the existing zip path (`shared/zip.js`,
`tools/workshop-pack.mjs`). What is missing is the player-visible half of `docs/PACKS.md:135-136`, and it is four
surfaces quoting one string:

1. `welcome` (from the lobby's `welcomeInfo()`, `server/net.js:796-797`) — what the server is running;
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

Finally, `tools/package.mjs:13-14` and `:174-175` (the `git ls-files` allowlist) mean a mod-layer file that is not
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
- **No code signing, no author identity.** `pack.json`'s `author` stays metadata (`shared/workshop.js:700-703`); the
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
separate table — `tokens.kits?.[def.id]` (`server/sim/content/tokens.js:1624` builds it from `RAW_KITS`, one entry per official token).
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

### 28.12.2 按文件开放官方 ops kit：`@ops/` 是命名空间，准入判据仍是那张表（2026-10-14）

**The defect, stated as the code states it.** §28.12 的表把包能 import 的东西收成两类：kit SDK（`@kit/tier1..6` +
`@kit/summoner.js`）与三个纯函数模块（`@sim/constants` `dir` `targeting`）。它**没有**给「复用引擎自带的官方 ops kit」
留路，而工坊包 `rimbilliton`（雷姆必拓）正是这一类：它的 4 张棋子卡就是 4 名官方干员换皮，作者的 kit 是极薄的委派 ——

```js
import opShwaz from '@ops/op-shwaz.js';        // ← 引擎里根本没有这个 specifier
export default (bb, chess, def) => {
  const k = opShwaz.char_340_shwaz(bb, chess);
  const sid = (def?.raw?.skills ?? []).find((s) => s.isDefault)?.skillId ?? null;
  if (sid && k.skills?.[sid]) { k.skill = k.skills[sid]; delete k.skills[sid]; }
  return k;
};
```

作者自己的文件头写着「import 白名单：`@kit/` `@sim/` `@ops/`」—— 他假设了一条不存在的通道。这与同一个包里
`pack.json` 那个不存在的 `stripDiyOverlaps` 是**同一类错误的两个实例**。装载器与校验器（同一份 `kitImportIssues`）
把这 4 个 kit 逐个拒掉：包本身还能装，但那 4 名干员的战斗行为缺失，而校验器报的是 **error**（`errors = 4`）。

**当时唯一「不改引擎」的出路，以及实测出来的那个数字。** 把 ops kit 复制进包就得连它的依赖一起复制：传递闭包
**18 个文件 / 513 KB**，含 `sim/content/tokens.js`（召唤物注册表，107 KB）、`sim/ai.js`（索敌，58 KB）、
`sim/simdata.js`、`sim/professions.js`、`sim/damage.js` 与 `shared/i18n.js`（浏览器 i18n 运行时，25 KB）。
那不是「搬几个 helper」，是**把引擎子系统在包内冻结一份**：引擎日后更新这些模块，包仍跑旧副本，而且**没有任何东西会报**。

**The ruling: 按文件指名，不开前缀（业主 2026-10-14）。** `KIT_IMPORT_FILES` 加四行：

| specifier | file |
|---|---|
| `@ops/op-shwaz.js` | `server/sim/content/kits/ops/op-shwaz.js` |
| `@ops/op-ray.js` | `server/sim/content/kits/ops/op-ray.js` |
| `@ops/op-aglna2.js` | `server/sim/content/kits/ops/op-aglna2.js` |
| `@ops/op-thumpy.js` | `server/sim/content/kits/ops/op-thumpy.js` |

**「前缀」与「准入」是两件事，这里刻意把它们分开。** `KIT_IMPORT_PREFIXES` 里加了 `@ops/`，因为浏览器侧的 import map
是**按前缀**生成的（`kitImportMap()`），而且错误文案必须能说「模块名未开放（前缀合法）」而不是「未知前缀」——
否则作者看到的是「这个命名空间不存在」，真相却是「它在，只是这个文件没开」。**准入判据始终是 `KIT_IMPORT_FILES`**：
`kitImportIssues` 走的是 `targets.has(specifier)`，所以 `@ops/op-siege.js`、`@ops/op-chen.js` 这类**同前缀、未列名**
的文件今天仍然被拒。这条界线由 `test/kitImports.test.js` §⑥ 钉住（其中一条就断言那几个文件仍被拒、且理由说的是
「前缀合法」）。这正是 §28.12 那句「the boundary should be visible in a diff, not implied by a path」的同一个做法：
开的是 **4 行**，不是 1 个前缀。

**为什么这 4 行两端都不需要改写文件（所以也别去改写它）。** 靠的是同一个性质：**两端都是按真实位置加载它**。

- 服务端：`loadWorkshopKits` 把 specifier 窄重写成 `pathToFileURL(path.join(ROOT, file))` 之后 import；该文件
  **自己的**相对 import（`../shared/tier1.js`、`../../../body.js`、`../../tokens.js` …）由 Node 按它的**真实路径**
  原样解析。
- 浏览器：import map 把 `@ops/` 指向 `/sim/content/kits/ops/`，而 `/sim/` 与磁盘 `server/sim/` **同构**
  （`server/http/static.js`，只服务 `.js`）⇒ 该文件的 `../../../body.js` 原样解析成 `/sim/body.js`，与磁盘上的
  `server/sim/body.js` 是同一个文件。

⚠️ 所以 `@ops/` 这一族**不做任何 import 改写**：`rewriteKitImports` 只重写它认得的白名单 specifier，给 ops kit 做
内部改写会把它的相对路径弄坏（`data:` 模块没有目录 —— 正是 §28.12 那条理由的反面）。

**What deliberately did not change.**

- **`MOD_API_VERSION` 不抬。** 这四行是**纯加白名单**：不新增字段、不改既有 specifier 的含义、不改变任何**已经**
  判定过的包的结论（此前 `@ops/*` 一律被拒 ⇒ 没有任何在册包依赖它的旧行为）。加白名单不打断谁，所以不需要新的
  API 版本号。
- **`@sim/` 那三个文件的门、`@battle/` 的门都没动。** 唯一跟着变的是**说清拒绝理由**那一处：
  `KNOWN_IMPORT_PREFIXES` 现在从两份前缀常量算出来，不再在 `kitImportUnavailableReason` 里抄第二份 ——
  抄了就会在前缀表变动时给出错的那一句（`@ops/` 进表时正是这条分支要跟着改）。
- **包的哈希与 `./…` 规则一字未动**，与 §28.12 逐条相同。

**What is verified.** `test/kitImports.test.js` §⑥（5 条）：这 4 条逐条在表里、指向真实文件、浏览器 URL 落在 `/sim/`
上；`@ops/` 下 5 个**未列名**的文件仍被拒且理由是「前缀合法」；`kitImportMap()` 为 `@ops/` 给出的前缀与
`index.html` 一致；**加载器口径与校验器同源**（真的让 `loadWorkshopKits` 加载一个 `import "@ops/op-shwaz.js"` 的夹具
kit，断言零 error），且同前缀未列名的夹具仍被拒（`test/workshopKits.test.js` 那类真加载，不是在文本上比对）。
另有一条把**包真正调用的那个 `default` 成员**（`default.char_340_shwaz` / `char_4117_ray` / `char_1015_aglna2` /
`char_4235_thumpy`）钉成函数 —— 这 4 个文件的具名导出很少（两个是空的），§①b 那条具名导出下限对它们等于空转，
所以下限必须记在 `default` 的成员上。

**这一段判据是先红后绿的**（这是"有牙齿"的证法）：加这四行**之前**跑
`node --test --test-name-pattern='按文件开放官方 ops kit' test/kitImports.test.js` 是 `pass 0 / fail 4`
（失败信息就是 `@ops/op-shwaz.js 必须在 KIT_IMPORT_FILES 里…` 与 `未知前缀 "@ops/"`）；加完之后整个文件
`pass 41 / fail 0`（含这一段 5 条）。

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
as **skipped placeholders** in `test/modAssets.test.js` §10 and are recorded as unresolved in the B4 report. (The
lifecycle itself has since been measured in a real browser — 0.18.5, headless Edge over CDP against the source tree:
registration and scope, the 412 surface, the self-heal path and the cache-name switch; the §10 placeholders themselves
are still unimplemented.) Everything decidable without a browser is exercised for real in Node against a fake
`CacheStorage` but real `Response`, `Request`, `Headers` and `crypto.subtle` — including the container byte-for-byte
agreement between this repository's writer, the reference writer and both parsers.

**Revision (2026-10-14, 0.18.5): the worker must not become a permanent hijack.** Owner-visible symptom: after an
upgrade the bond icons, the portraits and the 3D scenes were blank, and only `Ctrl+Shift+R` brought them back. Measured
on a clean profile, the six probes below were 200 ×5 + 404 (the sixth is a file that does not exist, so the server was
telling the truth) with 35 `<img>` on the S.W.E.E.P. screen; after registering `/resource-sw.js` the same six are all
**412** and the count is **0**. The worker was doing exactly what this section specifies — 412, never the origin — and
that is the defect: nothing ever gave the interception back. `CACHE_NAME` was the fixed `sp-workshop-resources-v1-all`,
`activate` only claimed clients, and `welcome.modAssets` only ever *registers*. So once a declaring pack was removed
(or the deployment returned to a release that declares none), the page stopped registering while the old root-scope
worker kept answering 412 for `/assets`, `/fonts` and `/media` — one registration, permanent hijack, clearable only by
a hard reload or by wiping site data. The probes: `/assets/bond/arcaneShip.png`, `/assets/char/portrait/…png`,
`/assets/local/scene/act1autochess_m01/scene.json`, `…/scene.bin`, `/assets/local/mesh/…/pPlane1.obj` and a
nonexistent name.

Three rules, each red on its own before the change and green after (`test/modAssets.test.js` §6b,
`test/asset-index.test.js`):

* **The cache name carries `APP_VERSION`** (`sp-workshop-resources-v1-<version>-all`) and `activate` deletes every
  cache of this engine's family whose name is not the current one (`common.js staleCacheNames`). Another application's
  caches are never touched, and neither is the current one: it holds the player's imported bytes, and `service.js`
  will not fetch them again.
* **The page heals itself.** When a `welcome` arrives with no `modAssets` while `navigator.serviceWorker.controller` is
  set, `main.js` lets the worker go: `resources/release.js` unregisters this engine's registration (matched on
  `scriptURL` ending in `SW_URL`) and deletes this engine's caches. It is a **dynamic** import, so the invariant above
  ("no declaring pack ⇒ no field, no request, no DOM, no global") stays structural rather than becoming an `if`; the
  owner's emergency line (`Ctrl+Shift+R`, then clear site data) now only covers a page that cannot be welcomed at all.
* **An unhashed `/assets/**` URL revalidates** instead of being cached for a day (`server/http/files.js
  LONG_CACHE_DIRS` drops `assets`; `fonts` / `vendor` keep the day, and every content-hashed path — the `~hash`
  segment, a Spine model group, `?v=` — stays `immutable`). Those URLs do not change when the bytes do, and the root
  worker answers that whole tree, so a day-old copy shows up as a missing picture rather than a slow one.

The reproduction itself turned up one residue, fixed with it: answering 412 used to call `caches.open(CACHE_NAME)`
first, which **creates** an empty cache. A worker that has just been unregistered but still controls the page
re-created it on every request, so `caches.keys()` never emptied — "unregistered, yet it still looks like a resource
pack was imported". `service.js` now returns early when that cache does not exist (`caches.has`).

One more thing worth stating in this section: the version bump is part of the fix, not bookkeeping. `CACHE_NAME` reads
`APP_VERSION`, so raising it is what renames the cache for players who already have the old one on disk.

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
(`process` / `globalThis` / `require` / `eval` / `new Function`) — the whole table, `globalThis` included again since
2026-10-13. It was **removed from this one site** for a while, and the reason was a real use case, not an oversight:
this repository contains a *working* `server.modules` module that used plain `globalThis` to talk to an in-process test
(`test/packMatchMsg.test.js`), so banning it would have pruned a legitimate pack (the owner's rule: measure first, and
if a real pack would be rejected, narrow the rule rather than force it). That use case now goes through the engine's
**explicit injection** instead — the pack declares `write: true` and records into `host.io`, a facade confined to
`<state dir>/mod/<pack id>/` — so the exemption has no reason to exist: with it open, `globalThis.process` walked past
the `process` row (reading the environment, `process.exit`), the most obvious hole in this scan. No derived table is
kept here any more: the same rule filtered in two places is how one digest ends up with two behaviours.
It is a heuristic, not a sandbox: `globalThis['pro'+'cess']` slips past this scan exactly as it slips past the other three.
`KIT_FORBIDDEN_GLOBALS` (clocks, randomness, DOM, timers) is **deliberately not applied**:
`boot` / `shutdown` / `healthz` / `metrics` / `route` all run outside the match loop, so a snapshot module stamping
`Date.now()` is legitimate, and the one mount point that does run inside a match (`matchClass`) already carries
`combat: true` and the digest/golden gate. An author who needs a process reading has a sanctioned replacement —
`host.metrics` — and the refusal text names it (and the host object the engine hands the module: `log` / `io` /
`route` / `healthz` / `matchClass`), so the refusal is not a dead end.

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

### 28.23 `server.modules[].channels`: the declaration surface of a pack channel (declaration + delivery landed)

**The asymmetry this closes.** §1.9.6 gave a pack a channel of its own (`client.panels[].messages` → `pack.msg`): the
engine fixes the wire type, the pack names the channel, the server validates, rate-limits and relays it. The receiving
half of that feature is the **match**, and `matchClass` is the only mount point this layer ever granted the power to
touch one (§28.14) — the hook `handlePackMsg(playerId, msg)` is that inlet. What was missing is not the inlet but the
**declaration**: nothing in `pack.json` said *which* channels a module receives in a match, so the only statement
available was the module's whole `matchClass` mount.

**The declaration.** `channels` is an optional `server.modules[]` field:

```jsonc
"server": { "modules": [ { "id": "xie", "entry": "server/ops.js",
  "uses": ["matchClass"], "channels": ["borrow", "answer"] } ] }
```

Four rules, each one a rule this layer already states elsewhere:

1. **One name shape, both halves.** The names use `PACK_CHANNEL_RE` (`shared/workshop.js`) — the *same* regex
   `client.panels[].messages` uses. Two spellings of "a channel name" would let a pack declare a channel it can never
   send or one it can never receive; that is exactly the "declared but cannot happen" shape this layer refuses.
2. **Every name must be reachable.** Each name must also be declared by one of the pack's own panels
   (`MODULES_UNKNOWN_CHANNEL`, refused as a whole pack). Lobby's `packChannels` whitelist is *derived from the panel
   list*, so a channel no panel declares could never be sent — storing it would be storing a declaration that cannot
   occur.
3. **Channels need a receiver.** A module that declares `channels` must also declare the `matchClass` mount point
   (`MODULES_CHANNELS_NEED_MATCH`), because the match is what receives them. `matchClass` already requires
   `combat: true` (`MODULES_NEED_COMBAT`), so the "this can change a result" gate is the existing one, not a new one.
   Bounded like its panel half: at most 8 (`MODULES_TOO_MANY_CHANNELS`), no duplicates
   (`MODULES_DUPLICATE_CHANNEL`), non-empty when present (`MODULES_BAD_CHANNELS` — drop the key instead of writing
   `[]`).
4. **Undeclared ⇒ byte-for-byte unchanged.** `channels` enters the normalized manifest **only when declared**, and is
   sorted, so two spellings are one pack (§28.2's hash rule: an undeclared key must not move a pack's identity). The
   module's bytes were already in the digest.

**What landed here.** The declaration surface is the shape layer (`shared/workshop.js`), the loader carrying the
declared set out (`server/modModules.js`), the surface ledger (`shared/modSurface.js`) and
`test/modMatchChannels.test.js`. The **delivery** is narrowed to exactly what was declared — this section is now the
whole feature, not half of it:

1. `server/index.js` derives the **delivery table** from the *pruned* server modules: `<pack id>` → the set of channels
   that pack's `server.modules[]` declared. A pack that declares nothing contributes no row, so the table is empty for
   every pack published before this cut and the path is byte for byte what it was.
2. The lobby (`server/lobby.js` `packMsg`) consults that table: `handlePackMsg(playerId, msg)` is called — still after
   the rate bucket and before the relay, still under `callMatch`'s try/catch and its naming log — **only when this
   pack's module declared this channel**. Everything else about §28.14 is unchanged: `true` / `{ consumed: true }`
   consumes the frame, every other return value and a throw relay as before.
3. A channel that only a panel declares (`client.panels[].messages`) is still **sendable and still relayed** — that
   half is §1.9.6's, and this cut does not touch it — but it is not an inlet, so the match never sees it.
4. Failing to receive is a **named warning, not a refusal**: a module that declares `channels` while its `matchClass`
   layer has no `handlePackMsg` method is logged once at load. The method may be installed by the constructor, which no
   static check can see, so refusing would reject a legal pack.

Nothing here changes the relay, the rate bucket, the wire type or `welcome`; `MOD_API_VERSION` does not move (an added
optional field, §28.39 / §28.43 precedent).

Tests: `test/modMatchChannels.test.js` — the shared name regex, the five named refusals, the sorted
"only-when-declared" manifest rule, and the loader carrying `channels` out while a module without it grows no key.
`test/packMatchMsg.test.js` — the delivery cut itself, with a channel that only the panel declares: the frame still
reaches the room and the match is never called (removing the table lookup turns that assertion red).

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

The second half of the same gap. The `welcome` frame (`shared/protocol.js` S2C; assembled in `server/net.js:797` from
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

**一、今天就能做：总伤（零引擎改动）。** 面板本来就订阅得到引擎的 S2C（`public/js/ui/extensions.js:884`
`S2C_TYPES.has(type) → net.on(type, fn)`，**原样透传**），而伤害数字在两条既有帧上：

| 面板读得到的 | 既有 S2C 帧 | 帧里的哪一格 | 粒度 |
|---|---|---|---|
| **每人总伤害** | `m.result`（`shared/protocol.js:780`） | `players[].stats.dmgDealt`（同处还有 `bossDamage` / `healingDone` / `kills` / `leaks` / `perfectRounds`；`server/match/results.js:156-161` 组装，`ui/stats.js` 与 `screens/result.js` 的战绩页读的就是它） | 整场**结算时**一次，按玩家 |
| **实时领袖伤害** | `b.pool`（`shared/protocol.js:786`） | `acked[fieldId]` = 那一场累计计入的领袖伤害（`server/match/match/bossRounds.js:384` `_broadcastPool`「to everyone」，≤ 4 Hz） | 首领 / 隐藏回合，按**场**，≤ 4 Hz |
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
* **唯一带 `dmg` 元组的 S2C 是 `b.ev`**（`shared/protocol.js:788`，元组种类 `EV.DMG` 在同文件 `:823`），
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

面板答不出「这台机器现在用哪套配音」：那个值住在**另一个** store（`public/js/ui/settings.js:50`
`settingsStore`，与 `ctx.me` 读的 `public/js/store.js` 不是同一个），而注入面里没有 store 句柄。
干员详情里的切换口（`public/js/ui/detailPanel.js:333` / `:544-548`）能改它，面板不能 —— 所以补一格**读数**加一格
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
  `public/js/audio.js:1079` / `:1096` 播放的不一致。
* **拿不到就是 `null`**（没注入设置库 / 不成形 / `get()` 抛）：不抛、不编造，面板画空态。
* **不进 `me.snapshot()`**：那三格来自**一次** `store.get()`（「一次取全」才不撕裂），这一格来自另一个 store。

**3. 写口：`ctx.session.setVoiceLang(charId, lang)`。** 它开了**新的一类**（在此之前面板只写得了
`session.setPreload` 那两个入口闸门标志），所以边界写死在代码里（`public/js/ui/extensions.js`
`VOICE_CHAR_ID_RE` 上面那一段注释）：

* **只此一格**：只写 `voiceLangByChar` 的**一个键**，其它设置（音量 / 静音 / 画质 / 文字大小 / 快捷键 /
  工坊外观开关）一个字节都不动；
* **只影响本地**：配音在**播放时**解析（`public/js/audio.js:1082` 的 `voiceLangOf` → `ui/gameLogic/settings.js
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

**问题。** WebSocket 的 `perMessageDeflate` **从前**写死在 `server/http/websocket.js`（`false`；0.2.6 起引擎缺省自己开着，`WS_DEFLATE`）。参考包
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

* **作者侧校验器读的就是这一张表**：`tools/workshop-validate.mjs` 对每条 `routes` 声明调 `coreRouteShadow`，
  mount 表由 `serveDirs({})` + `server/sim` 经 `coreMounts(...)` 造出 —— 与 `server/index.js` 在服务期用的那一份
  同源。三档判词与服务器逐字一致：`exact` / `file` ⇒ `ROUTE_CLASHES_CORE`（**error**，整轮非 0 退出：服务器会把这条
  声明丢掉，校验器不许还给作者一个 VALID）；`reserved` ⇒ `ROUTE_IN_ENGINE_NAMESPACE`（**warning**，今天照常服务，
  只预告将来让位）；`null` ⇒ 不吭声。**校验器里不许再抄一份保留名单**（`test/workshopValidateRoutes.test.js`
  有一条源码级断言钉住这一点，另有一条把三档判词与 `coreRouteShadow` 的返回值逐条对照）。

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

**这一格不是新账，是一个读者。** 伤害早在模拟里逐次命中就记好了：`server/sim/damage.js:424` 写
`source.stats.dmg`，`:371` 写 `battle._perPlayer[ownerId].damageDealt`，`:352` 写 `bossDamage`（单位那本账在
`server/sim/units.js:97` 初始化）。`battleRunner.damage()`（`public/js/battle/runner.js`）只做一件事：**把这些
已经在那儿的数字按面板看得懂的形状抄出来**。

* **不维护第二份累计**：`step()` / `drainEvents()` / `emit` 一行都不动，也**没有**逐 tick / 逐命中的新工作。实测
  代价（`_up/dps-probe-3.mjs`，四个公开 perf spec 前 600 tick、N=30 交替取样）：写元组本体 95（normal）/ 425（boss）
  / 435（hidden）次每 1000 tick，各配置的 p50 差值 ≤ 1.1 ms，全部落在噪声（sd 2–9 ms）内。
* **配的是引擎自己那本账**：逐人那几行照 `Battle._buildResult()` 的写法配对
  （`server/sim/battle/lifecycle.js:218-219`：座位在 `battle.players[]`，账在 `battle._perPlayer[playerId]`，
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
3. **声明了必须进身份哈希**。`identifyPack` 哈希的是归一化清单的 `canonicalJson`（`server/workshop.js:958`），
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

**已做的**：`training` 落在引擎已有的练度开关（`room.loadout.ops`）上；把一名**普通**干员的精锐形态
数值投影给它（投稿 `training` 一段真正想做的那件事：`_a` 拿到 `_b` 的 `stats`/`skills`/`talents`，
258 条 + 19 个召唤物）落在 §28.41 的 `form` 轴上（第 6 刀落地）—— 它是「形态投影」这条新规则，不是数值覆盖通道。

### 28.40 素材加载源（`assets.mirrors[]` + `sources(ctx)`）：让包真的换掉取字节的主机

投稿 `2a031cf0f869`（「CDN 源选择」）的作者在 `note` 里把话说得很直：**做不到改素材加载源**，因为 `assets.json`
里的地址是死的。这一节补上那一格，而它由**两半**组成 —— 拆开任一半都不成立：`pack.json.assets.mirrors[]` 定义
**哪些镜像被允许**，面板模块导出的 `sources(ctx)` 定义**先试哪一条**。

**A 半：`assets.mirrors[]`。** 一个条目就是 `{ id, base, sha256 }`（字段闭集 `ASSETS_MIRROR_FIELDS`，
`ASSETS_MIRROR_UNKNOWN_FIELD`）：

```json
{ "assets": {
  "container": "packs/resources-0.1.0.spresources",
  "manifest": "resource-manifest.json",
  "mirrors": [
    { "id": "fast", "base": "https://作者自己的域名/ak/resources-0.1.0/", "sha256": "<64 位小写 hex>" }
  ] } }
```

形状层（`shared/workshop.js parseAssetsMirrors`）判六条，每一条**点名**：`ASSETS_MIRROR_BAD_SHAPE`（不是非空数组 /
条目不是对象）、`ASSETS_MIRROR_UNKNOWN_FIELD`、`ASSETS_MIRROR_BAD_ID`（小写字母开头、≤ 32 字符）、
`ASSETS_MIRROR_DUPLICATE_ID`、`ASSETS_MIRROR_BAD_BASE`（必须**绝对 `https://`**、有主机、无凭据、无查询、无片段、
**以 `/` 结尾** —— 拼的是 `<base><包内文件名>`，少一个斜杠会拼出一个看起来对、取不到的地址）、
`ASSETS_MIRROR_BAD_DIGEST`、`ASSETS_MIRROR_TOO_MANY`（`ASSETS_MIRROR_MAX` = 4）。声明了 `mirrors` 的包**必须**写
`license`（`ASSETS_MIRROR_NEEDS_LICENSE`）：素材的再分发者是作者，授权问题不因为换了一台主机就消失 —— 与
§28.36 的 `VOICE_CDN_NEEDS_LICENSE` 逐字同一条理由。`mirrors` **只在声明过时才进归一化结果**（与 `skins` /
`voiceCdn` / `variants` 同一条纪律）：没声明它的包哈希逐字节不变。

**A 半为什么只能镜像「本包自己的容器」。** 这一格改的是「**这份容器的字节**从哪台主机取」，不是「整棵 `/assets`
树指向谁」。后者做不到诚实，三条理由写在这里免得反复被问：① `data/assets.json` 只有**清单级**摘要、**没有逐文件
摘要**，一个镜像清单的 sha256 锁得住清单的字节、**锁不住它指向的那些图** —— 那样的「校验」是一句空话；
② 把一整个站点的素材树交给第三方主机，正是「不分发官方素材」那条红线要拦的形态；③ 一个坏镜像的爆炸半径会是
**全站素材**（一坏全坏），而收窄之后它只是**一个包自己的那份容器**。`server/http/static.js` 的 `/assets` 分支
因此一行都没动。

**装载期（`server/workshop.js assetsMirrorIssues`）：比对，不下载。** 每条的 `sha256` 必须等于**刚从包内文件
算出来的**容器摘要（`assetsIssues.digest`）。对不上的那条 **停用**（`ASSETS_MIRROR_DIGEST_MISMATCH`，在
`errors` 里逐条点名、启动日志一行）而**不是拒绝整个包** —— 包本身完整可用，服务端算出来的摘要才是真相。这是
§28.35「宁少不拒」在装载期的同一条姿态。拿不到容器摘要时如实报 `ASSETS_MIRROR_NO_DIGEST`，不假装通过。
**服务端一条网络请求都不发**（与 §28.36 的 `voiceCdn` 相反）：取字节的是客户端，所以这一格没有服务端超时、
没有服务端缓存目录、没有启动期阻塞；一台 CDN 挂掉只影响想用它的人。身份哈希仍然哈希**声明**（含被停用的那条）：
一条镜像某天失效不该静默换掉包身份、让房间摘要跟着漂。

**B 半：`sources(ctx)`。** 与外观提供者（`client.panels[].appearance(ctx)`，§28.28）**逐条同构**：模块导出、
`import` 之后 `mount` 之前注册、进程内**最多一个**（`CLIENT_SOURCES_TAKEN`）、抛错 `CLIENT_SOURCES_THREW`、
形状不对 `CLIENT_SOURCES_BAD_SHAPE`、只提供它而不 `mount` **不是错**。它返回 `{ order(mirrors) }`，`mirrors` 是
**已声明**镜像的只读列表。

**它结构上不可能引入主机名**，这是这一格存在的全部价值：`order()` 只许回那些 id 的一个**排列或子集**。
不是数组、含未声明的 id、含非字符串 ⇒ `CLIENT_SOURCES_BAD_ORDER`，**整条顺序作废**（不半信半疑地采用一半 ——
那会让「哪台先说话」变成没人能复现的事）并回落声明顺序；返回 thenable ⇒ `CLIENT_SOURCES_ASYNC`（这是一条**同步**
读物，与 §28.35 拒 `Promise` 同一条理由）；`null` / `undefined` = 「我没什么可排的」，不是失败。于是「包能改
加载源」与「包不能指名任意主机」同时成立，而后者不是一句承诺：**注册面没有位置写下地址**。

**导入次序（硬性，`public/js/resources/host.js importFromServer`）。** ① 逐条镜像：取清单 → 取容器 →
**先核整包 sha256**（`verify.js verifyContainerBytes`，必须 `checked && ok`）→ 过了才走**既有**的逐文件
SHA-1[0:12] 导入与写缓存；② 任何一步不过 ⇒ **那条镜像作废、换下一条**；③ 全部不行 ⇒ **回落包内那条
`/workshop-resources/…` URL**（容器仍在包里，所以这条回落是**结构性**的）并且**响亮**：`CLIENT_SOURCES_FALLBACK`
一行日志 + 返回值里的 `via: 'pack'` 与 `refusals`（面板据此把降级显示出来）。**绝不静默，也绝不空白。**
`checked: false`（容器大于 `verifyContainerBytes` 的 256 MiB 上限）**等于不能用** —— 镜像是不受信的一方，而
`crypto.subtle` 没有流式接口。所以**如实写在这里**：超过 256 MiB 的容器用不了镜像，那类包只能走包内；不设这条
线就等于「不核摘要也导入」，那是「不能算错」的直接反面。跨源只发生在「取容器与清单」这一步：缓存键与 SW 送出
仍然是**同源站点路径**，所以引擎自带的 SW（§28.13.5）一个字节都没改。

**一键回退。** 设置里新增「工坊素材源」（`settings.workshopSources`，默认 `true`）。关掉 ⇒ `importFromServer`
走的与「这个包没声明 `mirrors`」**完全同一条**路径（连返回值的形状都一样，没有 `via` / `refusals`），镜像那条 URL
**一次都不被请求**。一个包把加载源改坏了，玩家关掉这一格就回到原样。

**默认逐字节不变（四条一起成立）。** ① 不声明 `mirrors` ⇒ 归一化结果里没有这个键、`welcome.modAssets` 里没有
这个字段、`importFromServer` 请求的 URL 与次序与 B3a 逐字相同；② 服务端不新增任何路由（`/workshop-resources/`
是既有那条，本刀不碰 `server/http/routeMount.js` 的保留表）；③ 引擎 SW 的 `service.js` 一行未改（它照旧只从
**已校验**的缓存回答、否则 412、不回源）；④ 索引里那条「这个包没声明 `assets`」的路径（`modAssets` 字段不出现、
不注册 SW）完全不变。

**`MOD_API_VERSION` 不动**（仍是 `1`）：加一格字段是纯增量，抬数字会让所有写 `api: "1.x"` 的老包被判
`MOD_API_INCOMPATIBLE`（§28.5 与 `shared/modSurface.js` 的版本政策）。**不强制 `combat: true`**：判据是**能力**
而不是意图 —— 这一格改的是「哪台主机送**同一份已校验字节**」，改不了谁在玩、装了什么、这一局的结果；容器摘要
本来就在包的内容哈希里（`identifyPack`），房间摘要闸门与 golden 语料一个字都没动。`MOD_SURFACE_FROZEN['1']`
**只加不改**（新表面 `client.sources` 进表，账本那串字面量一个字母都不动）。

<!-- 第 6 刀（干员形态投影）在此后追加：`### 28.41`。上面那段「还没做的」在第 6 刀里已经做了，
     所以 §28.41 开头会点名它；集成时若与本文件尾部的其它刀内容相邻，按小节标题顺序摆即可。 -->

### 28.41 口径轴 `form`：干员形态投影（`_a` 按 `_b` 的战斗职能出战）

**它补上 §28.39 那段「还没做的」。** 投稿 `e4fe4d5cf0a0`（「干员满练mod」）的 `training` 一段真正想要的是这件
事：**把普通干员投影成精锐形态** —— 每条普通形态（`_a`）拿它精锐兄弟（`_b`）的职能。它不是练度开关能表达的：
`shared/potential.js` 的潜能 1–6 与练度 0–3 **都改不了** `phase` / `equipLevel`，也开不出精锐的技能 2 与模组天赋
（`shared/potential.js:29-39`）。所以它是一条**新规则**，走**声明通道**、默认关：§28.39 的轴表加第三条轴
`form`（`official` / `elite`，**缺省 `official`** = 引擎今天的行为）。

**它为什么不是「数值覆盖通道」。** 投稿把这件事实现成安装器：`payload/data/official.json` 里 258 条记录各写一份
绝对数值。**本刀不采纳那些数，而且是刻意不采纳** —— 那套数比引擎今天**低**：投稿给 `chess_char_1_01_a` 的
`atk` 是 497，而引擎自己的 `_b` 是 531（129 条里**一条都不相等**，投稿是官方口径、引擎是满潜能口径）。照搬会
**静默降级** 129 名干员。所以：包只说「这一局用 `form: "elite"`」，**值全部从引擎自己的 `_b` 记录读**
（`shared/formProjection.js`）—— 与 `deploy` 那条口径同一条纪律（§28.39 判据 2）。

**投影什么、不投影什么**（`shared/formProjection.js`）：

* 复制 donor（`_b`）的**全部自有键**，再减掉 `shared/standIn.js` 的 `IDENTITY_FIELDS`（那一份是判据的唯一来源，
  构建期已证明它能重建每一条棋子；本刀**不另开第二份白名单**）。**默认跟随**比手写白名单更不会在新字段上悄悄漏
  投影。
* 身份与价格**都不动**：棋子 id、`tier`、`price`、`sellPrice`、盟约、特质（`garrisonIds`）、`upgradeNum` /
  `upgradeChessId` 仍是 `_a` 那一份。投影过的 `_a` **仍然是 `_a`**（`isGolden: false`、`baseId` / `goldenId` 照旧），
  所以 `baseIdOf` / `goldenIdOf` / 商店 / 合成 都看得见它。
* **`status` 整格留在 `_a`**（`phase` / `level` / `skillLevel` / `equipLevel`）。三条依据：`shared/standIn.js:36-39`
  用 `statusKey(status)` 去 `backups.units[charId].forms` 查补位形态、`:64` 又从它读 `equipLevel`、
  `test/backups.test.js:209` 逐字钉住 `_b` 的 `status`；而且**数据本身不许** —— 129 对里有 **39 对**的 `_b.level`
  **小于** `_a.level`（`1/55` → `2/50` 这种），照搬等于让那块地显示练度掉了。战斗数值不靠它：`stats` / `skill` /
  `talents` / `modules` 是烘好的，`_a.skills[]` 每条的 `level` 与 `_a.skill.level` 都跟着精锐走（投稿对 `_a` 写的
  `status.skillLevel = 7`，在引擎里由技能记录自己表达 —— `skillLevel` 与 `skills[].level` 恒等，`test/data.test.js:453`）。
* **召唤物同一个轴、同一套机制**：`data/tokens.json` 的 `variants[ownerChessId]` 里 owner 键有 `_a` / `_b` 一对的
  召唤物（本季 **19** 个），`_a` 的 owner 变体换成 `_b` 的那一条；没有 `_b` 变体的原样不动（投不了，也不假装投了）。
  只投干员不投召唤物是自相矛盾的（业主裁决 2026-10-13）。

**缺省路径逐字节不变（承诺落在对象身份上）。** 视图（`formView(chess, eliteProjected, { tokens })`）在
`eliteProjected` 为假时 `chess(id)` / `token(id)` 返回**原对象本身**（`===`）。这是这一层最重要的一条承诺的影子：
`DataSource` 的 def 缓存、`Match` 的 `dsCache`、`standIn()` 的 memo、`test/golden/*.json` 的摘要都按对象身份成立。
所以**不需要** `golden:update`：`tools/golden.mjs:106` 构造 `GameData` 时**不传 `variants`**，口径又从
`server/index.js` 的 `workshopMods` → `Match.mods.packs[].variants` → `Match.js` 进 —— 没声明这个轴的路径一个字节
都不动。

**面板与战斗不许分叉。** `Match` 建**一份**视图，`GameData` 与这一局的 `DataSource` 共用（`gamedata.js` 的
`opts.forms` / `simdata.js` 的 `opts.forms`）。`Match.js` 的 `dsCache` 缓存键**并进了 `form` 口径**：同一份 data 的
两个房间，一个声明 `elite`、一个不声明，各拿各的 `DataSource`（共用就是面板与战斗对同一条 `_a` 给出两套数值）。
召唤物的 token 缓存键也把 owner 形态算进去。

**`combat: true` 是硬闸门**：沿用 §28.39 的 `VARIANTS_NEED_COMBAT`（`shared/workshop.js`），**本刀没有新增闸门** ——
判据是「能改结果的口径必须进房间摘要闸门与 golden 语料」，与 `server.meta` / `server.battle` /
`modules[].uses: ["matchClass"]` 同一条线。**不新增协议消息**，`MOD_API_VERSION` 仍是 `1`。

**两条如实披露的后果**（业主裁决 2026-10-13；两条都是**刻意的**，也是这条轴必须标 `combat: true` 的理由）：

1. **1 阶价格拿到精锐形态的数值。** 价格与阶级不动 ⇒ 一枚 1 阶的普通棋子带着精锐的 `atk` / 技能 / 模组天赋上场。
   这是「投影只改职能」的直接后果，**不是 bug**；改它（把 `_a` 的价提到 `_b` 的价）就越出「形态投影」这个声明的
   范围 —— 那是改平衡，属于另一个决定。
2. **`upgradeNum` 不动 ⇒「3 张 `_a` 换 1 张 `_b`」在投影下价值中性。** `_a` 已经带着 `_b` 的数值，合成出来的那一张
   与合成前的一张一样强（合成仍然合法、仍然按既有的 3 张规则走）。同样不是 bug：投影改的是战斗职能，不是合成
   经济；改它同样越出这个声明的范围。

**不过降级是逐条断言的门**：投影后每条记录的 `atk` / `maxHp` / `def` 必须 ≥ 投影前，**干员与召唤物都过**
（`test/form-projection.test.js`）。这道闸是本刀最重要的一条防线 —— 它挡的正是「把投稿那套旧数值倒灌进来」。
（`status.level` 与 owner 变体上的 `level` **不**过这道闸：它们是那个形态的**名义练度标牌**，不是战斗数值，
且 39 对里 `_b.level` 本来就比 `_a.level` 低 —— 拿它当降级判据是假阳性。）

**测试**：`test/form-projection.test.js`（缺省恒等 / 投影真生效且逐条等于引擎 `_b` / 投稿的 497 一个都不许出现 /
身份字段逐个不变 / 两条不降级闸 / 召唤物 / 面板与战斗不分叉）· `test/workshopVariants.test.js`（轴名单与逐轴形状）。








### 28.42 房间目录的公开面：`GET /api/rooms` —— **一个数，不是列表**（投稿 `7ca51de6f346` 的收窄）

**投稿 `7ca51de6f346`（作者 Leiothrix，GPL-3.0-or-later，来源 `NeoPecos/Stronghold-Protocol 2cadc618`）要的是什么**：
C2S `room.list` + `user.activity` 与 S2C `room.list` —— 大厅直接列出**公开合作房间**，每条含房号、房主代号、难度、
真人与 AI 人数、在线及近期操作人数、招募或对局状态，并提供加入 / 观战入口，招募房间优先；`user.activity` 用来
更新「最近操作时间」，避免把后台连接误当活跃玩家。它自己在 `SOURCE.md` 里就写明：这需要引擎提供**受限的列表读面**，
**不要让普通模组直接访问整个 Lobby 内部**。

**业主裁令把它收窄成一个数**：「我们做成不枚举所有全服房间，我们枚举公开房间数，管理员可以查看所有房间数，
这样就行了」。所以本刀**不做**房间列表，也不做 `room.list` / `user.activity` / `lastInputAt` / `inviteOnly` /
`recruitWanted`，更**不预埋**它们；S2C 的 `room.list`、`user.activity` 这类帧**一个都不进** `shared/protocol.js`。

**形状**：`GET | HEAD /api/rooms` ⇒ `200`，body **恰好** `{ "publicRooms": <int> }`。`sendJson` 回答
（自带 `Cache-Control: no-store`），GET/HEAD 之外的动词走既有的 `405` + `Allow: GET, HEAD` 闸。**公开面永远只有
这一个整数字段**：`inMatch` / `players` / `bots` / `maxSeats` 任何一个都不许加 —— 任何一个都能把「数」变成对
某一个房间的**侧写**，那正是这一格被收窄掉的东西。

**「公开」的定义 —— 今天没有这个概念，所以照实说**：引擎今天**没有**「公开 / 私有」这个房间属性
（`room.setInviteOnly` 不存在，本刀不预埋）。因此 `publicRooms` 与 `/healthz` 的 `rooms` **今天恒等**，
两者共用 `Lobby.roomCounts()` 的同一次遍历与同一个 `this.rooms.size`（`server/lobby.js`）。solo 房算数
（与 `stats().rooms` 同口径、零歧义）。`this.rooms` 只装**在册**房间 —— `disposeRoom` 会立刻 `this.rooms.delete`，
所以没有「已销毁但还在数里」的窗口。**`inviteOnly` 落地后，`roomCounts()` 是唯一该改的地方**：把 `publicRooms`
改成排除 `inviteOnly` 的房间即可。

**管理员面：不新建任何东西。** `/healthz` 的 `rooms`（= `rooms.size` = **全部房间数**）**就是**业主要的那个数，
运维口径，无需新端点、**无需任何令牌**。本刀**不引入** `SP_ADMIN_TOKEN` 这类共享管理员秘密 —— 那正是
`server/http/routes.js` 文件头拒绝投稿 `POST /api/account/password` 时给过的同一条理由。

**为什么走 HTTP 而不是协议面**：① 零协议面变更（`shared/protocol.js` 一字不改，`server/net.js` 的 `HEAVY_TYPES`
不加任何东西，`PROTOCOL_VERSION` / `MOD_API_VERSION` **不抬**）；② 与本仓库刚落地的 `/api/records/<CODE>`
只读面无鉴权面同形；③ 将来的 `room.list` 若真要做，HTTP 面与协议面互不干扰。

**隐私边界（要说清）**：只给数 ⇒ 不泄露房号、房主名、人数明细。但 **`n = 1` 时「数」就等于暴露「有一个房间
存在」**，`n = 0` 与 `n >= 1` 的差别本身可推「现在有没有人在玩」—— 这个量级无法再降，除非不给数。而且
`/healthz.rooms` **今天就已经公开同一个数**（默认 `HOST='::'` 是全网卡绑定），所以本刀新增的信息量约等于零；
反过来说，「连数都不能给」这个选项今天已经不存在，要收回得连 `/healthz.rooms` 一起收回（另账）。

**测试**：`test/lobby.test.js` —— body 恰好一个字段、随注册表 +1 / 离开 −1、**隐私哨兵**（建房后响应文本不得含
该房号或房主名）、HEAD 200 无 body、POST 405、以及 `roomCounts()` 与 `stats()` 同源（`publicRooms === total ===
`/healthz` 的 `rooms`）。

### 28.43 `pack.json.behaviour`：行为开关（闭枚举、引擎自烘），**不是安装器**

**要解决的那面墙**：投稿 `ac8c9821f5ba`（「卫戍协议mod-跨版本一键安装包-v1.4.8-适配0.2.4」）把「改一条规则」
做成了**安装器** —— `install.mjs`（43,658 B）按 `files.json` 的 `copy` 清单**整份覆盖** `data/{chess,config,items,
official,skins}.json`、`server/**` 48 个文件（含 `server/sim/**` 22 个）、`public/**` 五十余个与 `payload/tools/**`
13 个，外加一条 `一键跨版本安装.bat`。它自己的 `files.json` 把语义写得很直：**「Nothing is trimmed: a target that
gets the whole file gets the whole feature.」** —— 这一句就是 `docs/WORKSHOP.md` §1.1 对 `official` / `config` /
`meta` / `shared` / `theme` / `serverModules` 六格「**刻意没有通道**」要挡的那个形态，**本节的判断与那六格逐字
一致**：一个能指定任意文件覆盖、或让包直接写数值的包格式**就是安装器**。

**它不是什么，比它是什么更重要**：`behaviour` **不是**一条数值覆盖通道，**不是**一条文件通道，**不是**一条代码
通道。包里写的是「**哪一格开关、哪一档**」，而**动作由引擎构造**（`shared/behaviour.js` 的 `actions(option)`，
值只能来自那一格或引擎自己的常量）。所以这一层**不是**通用 patch 分发器，也永远不可能是 —— 一个包给不出数字，
也给不出键路径。

**形状**：`behaviour: [{ switch, option?, name?, desc? }]`，条目字段**闭集**。`option` 省略 ⇒ 用这一格的
`default`。归一化结果**按开关名排序**（键序是清单字节的一部分，`identifyPack` 哈希的是 `canonicalJson(pack)`）。
**与 `variants` 逐字同构** —— 两张表读起来是同一套东西（`label` / `optionLabels` 中文、`effect` 英文、文件头
i18n-ignore），差别只在**表是另一张**、每格多一个 `actions`。

**为什么另开一格而不是塞进 `VARIANT_AXES`**：两层的**入场券不同**。口径（`variants`，§28.39）是「同一份数据的
另一套表现」，每条轴**必有**「官方那一档」，缺省＝引擎今天的行为，落点是引擎**已经实现**的那套开关；行为开关是
「引擎里本来没有、现在由维护者实现的规则」，它**不要求**有「官方那一档」。判据不同 ⇒ 拒绝码与 `combat` 披露口径
必须分开，而且混进 `VARIANT_AXES` 会把 `variantDataPatch`（§28.39 的唯一执行点，今天只返回一个 `config` 标量）
逼成一个**通用 patch 分发器** —— 那正是本节要拦的形态。**`VARIANT_AXES` 一字不动**。

**它就是 `docs/WORKSHOP.md` §1.1 那句建议的落点**：那条 `giveBondBiasOnly`（改一局的商店出货概率）当时被两路挡
住，文档写下「真要这条特性，正确做法是维护者在引擎里做成一个开关（商店池 + `bondsMeta` 的读取点），然后**任何**
包都能用」。本节把那句话**制度化**：引擎实现一格，任何包声明它。

**六条判据**（判据只有一份：`shared/behaviour.js`，装载器与校验器都调它）：

1. **空表也响亮**（第 4 刀的交付物）。`BEHAVIOUR_SWITCHES` 在第 4 刀落地时**是一张空表**，那是刻意的：那一刀交的
   是「**通道 + 守卫**」本身，**首格与它的引擎实现点一起落**（业主裁决 2026-10-13）。所以当时任何一条 `behaviour`
   声明都被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒** —— 空表不是「不认识的开关一律忽略」，而是**一个都不认识**，
   文案里还写明「本版一个开关都没有，因为没有实现点」。**加一格的门槛**：那一格必须**已经在引擎里有实现点**，
   比 `VARIANT_AXES` 的「只在被一份真实投稿要求时才加轴」更严。**第 8 刀按这条落了前三格**（§28.43.1）：表里
   每一格都有一处具名读取点、一个测试文件与一节文档；`behaviourSwitchIssues(BEHAVIOUR_SWITCHES)` 逐格为 `[]`
   就是那三格「不是塞进去就算」的判据。**站上的实测需求**：空表真的挡过投稿 —— `e3a5d09eb6d3`（跨版本安装包）
   按 `pack.json.behaviour` 声明时拿到 `BEHAVIOUR_UNKNOWN_SWITCH`（文案即「Known switches: none yet …」）。
2. **闭枚举 + 响亮失败**：`BEHAVIOUR_BAD_SHAPE`（不是数组 / 条目不是对象 / `switch` 不是非空字符串 / **未知字段**
   / `name`·`desc` 写坏）· `BEHAVIOUR_UNKNOWN_SWITCH` · `BEHAVIOUR_UNKNOWN_OPTION` ·
   `BEHAVIOUR_BAD_OPTION`（`option` 是 `null` / 数字 / `false` —— 非字符串会被读成「用了缺省」，即**静默不是
   作者写的那个**，与 `VARIANTS_BAD_DEFAULT` 同一条理由）· `BEHAVIOUR_DUPLICATE_SWITCH`。**每一条都是整包拒绝**。
3. **红线逐条落在形状层**：未知字段那一条**具体点名** `module` / `entry` / `file` / `path` / `value` / `key` 这类
   键，理由里写清「一条行为声明只说一个开关与它的一个选项 —— 它永远不带模块、文件、路径或数字」。**没有 `$del`
   语义**：这一层没有「删官方键」的表达能力。
4. **缺省逐字节不变**。不声明 `behaviour` 的包，归一化清单里**不长出这个键**（无条件写 `behaviour: []` 会让
   **所有已发布包**的内容哈希改变，房间的摘要闸门随即误判，§28.2）—— 与 `skins` / `voiceCdn` / `variants` 同一条。
   而**声明了就必须进身份哈希**：只差一个开关的两份包摘要必须不同（同一个摘要下两种对局行为是不允许的）。
5. **必须 `combat: true`**（第五条硬闸门 `BEHAVIOUR_NEEDS_COMBAT`）。位置与 `VARIANTS_NEED_COMBAT` 同序：
   `BAD_COMBAT`（类型）之后、`EMPTY_PACK` 之后。判据是**能力**而不是意图 —— 一格的入场券本就是「它改一条规则」
   （§1.1 的 `shopBias` 就是活例子：它改的是一局的商店出货概率＝改对局结果）。将来若有一格**明确改不了结果**的
   开关（例如纯客户端规则），它**必须不**要求 `combat: true`，并把「不改结果」写进那一格的 `effect`。
6. **不是贡献项**：与 `support` / `playtest` / `variants` 同一个语义 —— 开关选的是引擎已实现的一条规则，不是内容。
   所以一个只带 `behaviour` 的包照旧 `EMPTY_PACK`（文案里点名 `"behaviour" is NOT a contribution`）。

**多包抢同一格**：按既有的「包 id 字典序小的赢」（§28.3，与数据记录 / kit / 图标 / 口径同一条），由
`mergeBehaviourDecls` 合成，输的一方进 `overridden` 供调用方点名报告。

**执行点**：`behaviourActions(decl)` 把归一化声明翻成**引擎具名动作** `{ kind, value }`。表空 ⇒ 动作数组空；选了
缺省档 ⇒ 也是空数组（第 8 刀那三格都照这条）。这一格**不新增协议消息**，也**不动** `Match` / `GameData` 的既有
通路：一格若只涉及一个 `config` 标量，它**复用**口径那条既有通路（`opts.variants` → `gamedata.js`），
**不新开第二套「引擎自烘 patch」先例**；若落在别处，读取点由那一格自己点名（**第 8 刀那三格都是这一类**：
`shopBias` 落在商店池、`prepLoadout` 落在 `Match.setLoadout` 的相位闸门、`morphPairing` 落在三处盟约读取点 ——
`service/match/Match.js` 只多一行 `mergeBehaviourDecls`，与 `variants` 同一个投影点）。
**读取点问的是「哪一档」**（`behaviourValue` / `behaviourIsDefault`），与 `variants` 的 `variantValue` /
`variantIsDefault` 同一个分工；`actions(option)` 是那一格的**声明**（给编辑器、错误文案与守卫读），
**不是**一个通用分发器 —— 这一层永远不是 patch 分发器。

### 28.43.1 第 8 刀：逐格加开关（`shopBias` 起）

| 开关 | 选项 / 缺省 | 引擎侧读取点 | 投稿 |
|---|---|---|---|
| `shopBias` | `official`（缺省）· `bondBias` | `bondBiasPreference`（`server/match/pool.js`）→ `bondBiasBonds`（`server/match/player/economy.js`）→ `PlayerEconomy._rollItemSlot` | `b293e061b38f` |
| `prepLoadout` | `locked`（缺省）· `prep` | `LOADOUT_PHASES` / `loadoutPhasesFor` + `MatchPlatform.setLoadout`（`server/match/match/platform.js`）：`locked` 只有 `INFO_CHECK`（与从前逐字相同），`prep` 另加 `PREP` 且只在这个座位还没准备时；`PREP` 那一次走 `mergeLoadoutEntries`（只覆盖写了的干员） | `8b4e5da55c58` |
| `morphPairing` | `official`（缺省）· `plus` | 判据本体 `grantedBondsByMorph`（`shared/morph.js`），三处读取点**同判**：`pieceBonds`（`server/match/bondsMeta.js`）· `unitBonds`（`server/sim/content/support/index.js`，档位经 `withMorphPairing` 的作用域）· `grantedBonds`（`public/js/ui/gameLogic/bonds.js`，档位经 `roomMods.js` 从 `welcome.mods` 合成）。`official` = 今天的行为（两件起配、全部授予）；`plus` = 一件起配、只取最左那一件。**第 7 段补上槽位那半条**：`morphSlotPolicy`（同一文件）返回 `OFFICIAL_SLOT_POLICY` / `PLUS_SLOT_POLICY`，六处读取点同判：`player/items.js` · `player/acquire.js` · `bot.js` · `invariants.js` · `ui/detailPanel.js` · `ui/gameLogic/placement.js` | `19ea65909cf6` |

**`morphPairing` 的槽位语义（第 7 段，第三格落地时记为「未做」的那半条）**：投稿还要求「不占装备位、每名干员只
一件、第三件顶掉真占格那两件」。这一半落在**装备位**那套既有实现上，所以判据收成 `shared/morph.js` 的
**`morphSlotPolicy(decl)`** —— 一个闭枚举的策略对象：

* `official`（缺省）⇒ **`OFFICIAL_SLOT_POLICY`**，一个**共享的冻结单例**：`isSlotless` 恒假、`slotsUsed` 逐字是
  `items.length`、`slotCap` / `maxItems` 逐字是 `equipPerChess`、`replacedIndex` 就是今天那个「`replaceUid` 找不到
  ⇒ 0（最旧的那件）」。缺省档下六个读取点走的是**与从前同一批算术**（同一次比较、同一个 splice 下标）⇒
  **缺省逐字节不变、没有任何 `golden:update`**，已发布包一个字节不动。`test/morphPairing.test.js` 拿 `===` 钉住
  「缺省输入必须返回这个单例」。
* `plus` ⇒ **`PLUS_SLOT_POLICY`**：它不占位（`slotsUsed` 不数 `canGiveBond` 的那件）、每名干员最多一件
  （`canHold`）、顶替只挑真正占格的那一件（`replacedIndex` 跳过它）、一行最多 `equipPerChess + 1` 件（`maxItems`）。

**`equipPerChess` 本身一字未动**：那两格装备位是官方的，策略只回答「这一行占了几格、能不能再放一件、顶替挑哪
一件」。`slotCap` 与 `maxItems` 是**两件事**，刻意分开：前者是真正占格的上限（两档都 = `equipPerChess`，界面的
`EQUIP n/2` 分母读它），后者是一行最多几件（只有不变量那条读它）。

**`getItem` 的契约（这一格的一格）**：解析器收**一件棋子**（`{ id }`）或一个 id 字符串，回 items 记录 ——
六个读取点统一写成 `(it) => gd.item(typeof it === 'string' ? it : it && it.id)`。第 7 段第一版在这里踩过一次真
bug（`server/match/invariants.js` 写的是收棋子的形状、其余写的是收 id 的，判据只假设一种 ⇒ 不变量把变形同构体
当成占位的普通装备），所以契约写在 `shared/morph.js` 的 `resolveRec` 注释里并由 `test/morphSlots.test.js` 覆盖
（那条 `collectViolations(m)` 断言就是它的回归位）。

**每加一格照这三条做**（这一刀起）：**缺省 = 引擎今天的行为，逐字节不变**（缺省路径与从前同一份代码路径，
所以**没有任何 `golden:update`**，已发布包一个字节不动）；**非缺省档由引擎实现**（包给不出数字、路径、模块，
`effect` 逐字写明它动了什么）；**一格一个测试文件 + 一节文档 + 一处可锚的读取点**
（`test/shopBias.test.js`，`docs/WORKSHOP.md` §1.23，`shared/modSurface.js` 的 `behaviour` 那一格）。
另有 `test/packBehaviour.test.js` 钉整表的形状、闭枚举与「不认识的开关点名拒」。

**诚实边界（缺源件就不做假实现）**：`shopBias` 的原件 `_doc` 还提到「已激活**核心**盟约优先于已激活附加盟约」与
「骑士戒律也接入这套偏向」，其 `payload/data/items.json` 另带 `giveBondBiasOnly`（115 处）与一批 `canGiveBond`
（115 处）—— 那两条的源件不在我们手上，**没做**，也不在 `effect` 里声称做了；这一格**只读 `giveBondId`**，
不读 `giveBondBiasOnly`（我们数据里连这个键都不存在）。`canGiveBond` 是官方记录本来就有的键（变形同构体的标记）。
`test/shopBias.test.js` 把这几条写成源码级断言。

**判据写成「表是入参」的纯函数**：`parseBehaviourDecl(raw, table)` / `behaviourSwitchIssues(table)` /
`behaviourActions(decl, table)` / `mergeBehaviourDecls(packs, table)`，默认值都是真表。理由与
`surfaceLedgerIssues(ids, generation)` 逐字相同：**表是空的**，把判据写死就没有任何测试碰得到「选项名不认识」
「同一个开关写两遍」「缺省写错」这些分支，而一条从来没验过失败分支的守卫和没有守卫是一回事。`normalizePackManifest`
因此多一个**可选** `opts.behaviourSwitches`（默认真表；装载器 / 校验器 / 编辑器一律不传它）。`behaviourSwitchIssues`
把「一格少了 `actions` / `options` / `default` / `optionLabels` / `effect`」也写成可断言的一格守卫 —— 加第一格时
最容易出的事就是「声明了、装上了、什么都没发生」。

**`MOD_API_VERSION` 不动**（仍是 `1`）：`api` 是可选项，没声明 `api` 的包一个字节都不受影响，而**加一格字段不抬
版本**有 §28.39 / §28.33 / `server.modules` 的 `metrics`·`route` 三处先例（`shared/modSurface.js` 的版本政策）。
抬世代只有三种情形：**已有声明改语义** / **新声明复用老引擎已认识且会按旧语义执行的键** / **删改名任何一格**。
本刀是「新键 + 老引擎 `PACK_UNKNOWN_FIELD` **响亮拒**」—— 老引擎不是静默走错，是点名拒绝，所以第三种也不成立。
**「老引擎优雅降级」明确不做**：那会让「写了等于没写」复活；作者该知道的是自己该跑哪一版。

**披露**：`welcome.mods[].behaviour` 与 `variants` **并列投影**（`server/index.js`，**只在声明过时才存在这个键**）；
**不进 `modDigest`**（它只哈希 `[id, hash]` 对，`shared/modIdentity.js`），但**必须进包身份哈希**
（`server/workshop.js` 的 `canonicalJson(pack)`）。漏掉投影 = `Match` 读到 `undefined`、开关**静默不生效**
（§28.39 把这一处记成「这一层最容易做坏的地方」）。

**站侧含义（照实写）**：投稿原件在站点 `flagged/ac8c9821f5ba/`，`meta.json` 的 `flags` 含 `EXECUTABLE`(blocker) /
`NO_PACK_JSON` / `WRAPPED`（全部文件套在 `跨版本安装包/` 一层下 ⇒ 做成兼容包上传必须先**扁平化**）。它**不是**
纯安装器：`payload/packs/fanpack/` 自带一个内容包（`pack.json` 893 B + `records` / `chess` / `tokens` / `variants` +
7 张**自制** PNG），那一半**今天就有通道**（`content` + `kits/` + `art` / `bondIcons` / `itemIcons` + `variants`），
只是**格式不同**（它的 `type: "data"` / `files{}` 会被 `PACK_UNKNOWN_FIELD` 点名拒）。**它从不随包发官方美术**
（`public/assets/**` 由 `install.mjs --assets` 另下），所以那 7 张图是自制的、**不违反**「分发官方素材不行」。

**测试**：`test/packBehaviour.test.js` —— 空表也响亮（真表路径整包拒 + 文案说清「一个都没有」）、五条拒绝码逐条
（合成表）、**越权写入被拒**（`module` / `entry` / `file` / `path` / `value` / `key` / `$del` 全拒）、
`BEHAVIOUR_NEEDS_COMBAT` 与 `BAD_COMBAT` 的先后、`EMPTY_PACK` 优先、缺省不长键、**只差开关的两份包摘要必须不同**
（走装载器同一份 `identifyPack`）、投影那一行真的在 `server/index.js` 里（源码级断言）、以及 `PACK_FIELDS` 的闭集
计数就地延长。**不需要 `golden:update`**：缺省路径一个字节不动。

### 28.43.2 第 8 刀：第四格 `unequip`（装备拆卸）与**新增一条 C2S 意图**的完整落点

投稿 `79de9ff03518`（「装备拆卸mod」）把这件事做成了安装器：`files.json.copy` **整份覆盖** `shared/protocol.js`、
`server/match/match/intents.js`、`server/match/player/items.js` 与六个客户端文件，并自己加了一个
`g.unequip {itemUid}` 意图与 `PlayerState.unequip()`。本刀照 §28.43 收成一格：

| 开关 | 选项 / 缺省 | 引擎侧读取点 | 投稿 |
|---|---|---|---|
| `unequip` | `official`（缺省）· `allow` | `unequipAllowed(decl)`（`server/match/player/items.js`，模块层纯函数）← `PlayerState.unequip` / `PlayerItems.unequip`；客户端另一处读 `unequipAllowed()`（`public/js/ui/gameActions.js`，由 `roomMods.js` 从 `welcome.mods` 合成）决定**画不画**「卸下」按钮 | `79de9ff03518` |

**这是本层第一条「开关 + 新意图」的格子**，所以五处落点在这里点名（将来加意图照抄这份清单）：

1. **协议表**（`shared/protocol.js` 的 `C2S`）：`'g.unequip': { itemUid: isUid }`，与 `g.destroy` / `g.equip.itemUid`
   **同一个 `isUid` 子**。**`PROTOCOL_VERSION` 不动** —— 新增类型不是改已有形状（先例 `records.mine`）：老客户端
   不发它就一切照旧。**不新增 S2C 消息**（结果走既有的 `dirty()` / 私有视图推送）。
2. **意图路由**（`server/match/match/intents.js`）：`case 'g.unequip': return ps.unequip(msg.itemUid);`。
3. **状态机**（`server/match/player/items.js`）：`unequip(itemUid)` —— 与 `destroy` 同一条 `_gate()`；必须
   `kind === 'item'` 且 `area === 'equipped'`。
4. **客户端发送点**（`public/js/ui/gameActions.js`）：意图→音效表 + `unequip: (itemUid) => act('g.unequip', { itemUid })`
   —— 复用既有 `act()`，不另造发送路径。UI 那一半在 `detailPanel.js` 的 `ItemRow`（`onUnequip` 穿透 +
   `screen/game.js` 接线）。
5. **判据读取点**：一格一个模块层纯函数（`unequipAllowed`），于是它是 `shared/modSurface.js` 里 `behaviour`
   那一格可锚的导出名。

**加意图清单（同步点全表 —— ①② 是设计，③④⑤ 是「漏了就红 / 就哑」的机械同步点）**：

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/protocol.js` 的 `C2S` 表（字段 + 判据子） | 传输层的 `validateC2S` 回 `unknown type …` ⇒ 这条意图**根本进不来**（`platform.js` 的 `GAME_TYPES` 从 `C2S` 的键派生） |
| ② | `server/match/match/intents.js` 的 `switch` 分支 | 类型认了、**没人处理**（静默丢弃，客户端一直等到超时） |
| ③ | **`test/match/fuzz.test.js` 的 `randomIntent`** | **全量当场两条红**：它按 `C2S` 表逐个类型造随机载荷，并钉住「造出来的每一条都合法」；新类型没进它的 `switch` 就掉进 `default`（`{t}`，缺字段）⇒ `validateC2S` 回 `bad field …`。补一行 `case`（**断言一字不用动**）之后这条意图才真的进模糊覆盖 —— 第 8 刀第四格 `g.unequip` 就是这么被抓住的 |
| ④ | 客户端**意图→动作映射**（`public/js/ui/gameActions.js` 的音效表 + `act()` 包装） | 类型通了、UI 发不出去（或发出去了没有成功反馈） |
| ⑤ | 若带新文案 ⇒ **i18n 词条**（`public/i18n/*.json`，`node tools/i18n.mjs check --all --strict`） | 新字面量的 msgid 不进包 ⇒ `check` 报 missing。**这是加类型的第一个隐藏成本**（第二个是 ③） |

⇒ ⑤ 的规模要说清：本刀为 `g.unequip` 加了两个词条（按钮文案 + 去掉半句的提示），**四个包都要写**
（en / ja / ko / zh-TW）。基线本来就 ja / ko / zh-TW 各缺 57 条（**既有缺口**，不是本层造成的），但
**新词条必须四个包齐全**，否则缺失数就从基线往上走。

**缺省档逐字节不变**：`unequipAllowed` 为假 ⇒ 回 `ERR.BAD_TARGET` + 文案 `'equipped items are locked'`，
**与 `destroy`（`items.js` 里今天那一句）逐字同一句** ⇒ 一个不声明这一格的房间在 `g.unequip` 上的行为与
「这条意图不存在」等价，**没有任何 `golden:update`**；客户端**一个按钮都不画**（`ItemRow` 的 `canDetach` 要求
`onUnequip` 且 `unequipAllowed()`），`ItemDetail` 那句「配发后无法取下」也**只在 `allow` 档**换成不带那半句的版本
（官方档那句话是对的，`test/unequip.test.js` 用源码级断言钉住它还在，并钉住四个 i18n 包都有两个新词条）。

**原子性（这一格最容易做坏的地方）**：`_detach` 之后 `stow(piece, { allowTemp: true })` 可能返回 `null`
（手牌与临时整备区都满）。那时按**原下标**把它塞回 `holder.items` 并回 `ERR.HAND_FULL` —— 先摘后塞没有回滚的话
装备会**凭空消失**。用 `HAND_FULL` 而不是 `BAD_TARGET`：「没地方放」是一件独立、可行动的错误。

**池不变式照旧**：装备只是从**装备位**移到**手牌 / 临时**，`piece` 与 `uid` 都不变 ⇒ `SharedItemPool.held()`
（遍历 `hand` / `temp` / `board` 以及 `p.items`）前后都数得到它 ⇒ `held` / `cap` / `left` 全不变，不变式
`raw left + Σ held == cap` 一字不动。**这一格没有「归还」这回事**（与 `destroy` / `sell` 不同：那两者才真让池子少一件）。

**刻意的决定：第一版不发内容钩子。** `HOOKS` 那 19 个是**契约面**（进 `META`），而「卸下」用哪一个都不贴切
（不是 `onDestroy`、不是 `onEquip`），**今天也没有任何包需要被通知**。将来真有包需要，**另立一刀**并按 `META`
契约面扩展 —— 写在这里是为了让后人知道这是**决定**，不是漏做。

**测试**：`test/unequip.test.js` —— 真表那一格的形状与两档、`C2S` 登记与 `validateC2S` 的拒绝（**在这里钉
「形状错 ⇒ `BAD_MSG`」**：`validateC2S` 返回原因串、`server/net.js` 的 onFrame 把它折成 `ERR.BAD_MSG`，
`Match.handle` 只认过了它的消息 ⇒ 意图层对形状错回的是 `BAD_TARGET`，测试两层都钉）、缺省档
`g.destroy` 与 `g.unequip` 回**同一句**且一个字节不落地、`allow` 档三分支（手牌 / 临时 / 两者都满 ⇒ 原子回滚 +
`HAND_FULL` 且**下标与失败前相同**）、池快照与 `checkInvariants` 前后一致、`recompute` 后盟约人数真的变了
（用 `test/match/morph-bonds.test.js` 的「变形同构体 + 一件授予盟约的装备」配方，1 → 0）、客户端源码级断言
（发送点 / 缺省 `unequipOn = false` / 按钮判据 / 官方那句提示还在 / 游戏屏接线）。

### 28.43.3 第二格 `prepLoadout` 的**客户端半**：一句写了很久的谎话，与两处同类的写死相位

第 8 刀第二格（§28.43.1）只落了**服务端**那一半：`Match.setLoadout` 读 `LOADOUT_PHASES`，`locked`（缺省）只收
`INFO_CHECK`，`prep` 另收 `PREP`。**客户端那一半一直没落**，而它的缺失形态不是"少一个发送点"，是**客户端在撒谎**：

* 发送链路**整套早就有** —— `public/js/ui/loadoutSync.js` 的 `installLoadoutSync` 早就在发
  `room.loadout { entries, ops }`（500 ms 去抖、面板关闭时立刻冲刷、`WRONG_PHASE`/`ROOM_STARTED` ⇒
  `setState('locked')` + 提示、`room.state.inMatch` 变假时自动解锁重试）；单干员编辑的纯函数也早就有
  （`loadoutModel.setChoice(entries, base, golden, { skill?, module? })`，缺键即删那条 entry，与
  `mergeLoadoutEntries` 的"只覆盖写了的干员"天然对齐）。**所以这一刀不新造任何发送链路、不新增协议消息。**
* 缺的是**客户端自己的相位判据**，而它**写死在两个地方**：
  1. `screens/loadout.js` 的 `locked`（原来："在局中、相位不是 `INFO_CHECK` 就算锁定"，顺手把 `LOBBY` 也排掉）
     ⇒ 画「本局已锁定 · 下一局生效」与详情里那句「修改将在下一局生效」。**实测这个 `locked` 只喂那两处文案、
     不 disable 任何控件** ⇒ 声明了 `prep` 的房间会出现「**服务端收得下、界面却说锁着**」的自相矛盾。
  2. `screens/loadout.js` 的 `shouldAutoClose`（原来简报那一支写死"相位不是 `INFO_CHECK` 就关"）⇒ 玩家刚进
     `PREP`——**正是服务端允许改调配的那一段**——面板被**自动收走**。

**做法**：把那份相位判据收成"一份两档的表 + 一个纯函数"，屏幕只读它、不再自己比相位。
`public/js/ui/loadoutSync.js` 导出 `LOADOUT_CLIENT_PHASES` / `loadoutLockPhases(option)` /
`currentLoadoutLockPhases()` / `setPrepLoadout(option)`；`roomMods.js` 在**同一处**（与 `morphPairing` /
`unequip` 并列）用**同一份合并规则**（`mergeBehaviourDecls` + `behaviourValue`）喂档位。

**两张表的关系**：客户端的 `LOADOUT_CLIENT_PHASES` 与服务端的 `LOADOUT_PHASES` 是**两张表** —— 客户端不能
`import server/**`（导入边界）。这是这一层既有的做法：**客户端副本 + 一个测试把两张表钉在一起**（与
`CLIENT_WRAP_COMPONENTS`↔`MOD_COMPONENT_IDS`、`CLIENT_PANEL_SLOTS`↔`MOD_PANEL_SLOTS` 逐字同一条）。
钉它的是 `test/prepLoadoutClient.test.js` 里那条"逐档逐字相等"。

**缺省逐字节不变**（这一层的设计不变式）：缺省 / 没声明 / 不认识的档位 ⇒ 只含 `INFO_CHECK`。
`locked` 那两处的旧表达式与新判据**逐相位遍历同一个布尔**，`shouldAutoClose` 那一处也**逐相位同判** ⇒
一个不声明这一格的房间，界面一个字节不变，**没有任何 `golden:update`**。

**还没做的那一件（如实披露，见 §28.43.4）**：`PREP` 里**没有入口**能打开干员调配面板 —— `LoadoutButton` 只在
大厅（`from="lobby"`）、房间（`room`）与简报（`briefing`，只活在 `INFO_CHECK`）里出现，`screens/game.js` 里
**一个都没有**。所以在贴一个 `PREP` 入口之前，"服务端开了"与"玩家改得了"之间还差最后一步。

**同类的写死相位（本轮只记录，不改）**：

| 位置 | 形态 | 与某格开关相关？ |
|---|---|---|
| `screens/support.js` 的 `shouldAutoClose` | 与 `loadout.js` 那一处**同形**（相位一离开 `INFO_CHECK` 就收走助战面板） | **无关**：助战**没有**开关，而服务端 `platform.js` 的 `room.support` 同样只在 `INFO_CHECK` 收（`WRONG_PHASE`）⇒ **两边一致，不是缺陷**。将来若有投稿要"休整期换助战"，那就是**第 5 格开关**，两处一起改 |
| `ui/equipReplace.js` 的 `if (equipped.length < 2) return null;` | 客户端把**装备位写死 2**（换装对话框的触发判据） | **第 7 段已按格开关处理**：`equipReplaces`（`ui/gameLogic/placement.js`）改读 `slotPolicy().slotsUsed` / `slotCap`，`ui/equipReplace.js` 只消费它的判决 ⇒ 两档都对得上服务端 |
| `ui/gameLogic/placement.js` 的 `if (targetPiece.items.length < 2) return false;` | 同上（拖拽配发的预判） | **同上，已处理**（判据收在 `equipReplaces` 一处） |
| `ui/detailPanel.js` 的 `EQUIP n/2` 与"最多 2 件"文案 | 纯显示 | **第 7 段已处理**：分子换成 `slotPolicy().slotsUsed`（`plus` 档不数那件不占位的），分母 `slotCap`；`plus` 档另外给那一行画一个「不占装备格」标签（`dtag-slotless`，缺省档不画） |

### 28.43.4 待办（本轮**刻意不做**）：`PREP` 里的干员调配入口

§28.43.3 把客户端的相位判据扶正之后，**"服务端收得下"与"玩家改得了"之间还差最后一步**：`PREP` 里没有入口。

**证据**：`LoadoutButton` 只有三个宿主 —— `screens/lobby.js`（`from="lobby"`）、`screens/room.js`（`from="room"`）、
`screens/briefing.js`（`from="briefing"`，而简报只活在 `INFO_CHECK`）。`screens/game.js`（对局的屏）里**没有**
任何入口；`shouldAutoClose` 的 `lobby`/`room` 那一支又会在对局开始时把面板收走。⇒ 声明 `prepLoadout: "prep"` 的
房间，玩家仍然没有地方点开那个面板。

**为什么不在 §28.43.3 里顺手加**：那是**在对局屏上新增一个可见控件**（不是修一句判据），属于"新渲染分支"，
要单独裁。两个候选形状：

1. **贴一个入口**：`screens/game.js` 加一个 `<LoadoutButton from="game" />`，**只在 `prepLoadoutAllowed()` 且
   `editable` 时画**。便宜且**不需要新 i18n 词条**（`LoadoutButton` 的默认 label 就是既有的 `t('干员调配')`），
   缺省（没声明）⇒ **一个按钮都不画** ⇒ 缺省渲染逐字节不变。
2. **投稿 `8b4e5da55c58` 的 UX**：在详情面板的技能 / 模组段里直接加切换按钮（它那份 `detailPanel.js` 的
   `dloadout-pick`）。更贴近投稿，但要**新 i18n 词条**（「切换为 {name}」「当前技能」…四个包都要写）+ 一个新的
   `prep` 档渲染分支。

**状态**：**未做，记账在此**（业主"站上 8 条全部做"的口径由"记账 + 待办"满足，不让它悄悄丢掉）。做的时候
**必须**遵守 §28.43.1 那三条（缺省 = 引擎今天的行为、非缺省档由引擎实现、一格一个测试文件 + 一节文档）与
§28.43.2 的「加意图清单」（若同时要发送新的东西）。

### 28.44 The upgrade-path table: a second protocol on the same port (implemented)

**The gap, stated as a hard-coded comparison.** `server/http/websocket.js` answered exactly one WebSocket path — the
line was `if (!parts || parts.rawPath !== '/ws') { reject(404, …) }` — because one server ran one game and one
protocol. Everything else about the upgrade was already data (`WS_MAX_PAYLOAD`, `NET_DEFAULTS`, the peer map): the
path was the only routing rule in the file that could not be expressed as configuration. That stops being harmless
the moment a host wants to serve a **self-contained game mode** next to Stronghold: a mode that brings its own
message shapes, its own rooms and — the reason this cell exists — often its own process. Without a table the only
way to get there is editing the pinned comparison, and a fork that edits it owns a merge conflict on the file that
guards its own front door.

**The ruling.** The paths a server answers become a **table the host process registers**, decided from data before
the socket exists:

```js
startServer({ wsLanes: [{ id: 'lobby', path: '/duel/lobby', summary: '…', onUpgrade }] });
```

Four properties, each one closing a way this could quietly go wrong:

1. **The game's `/ws` is not a lane.** It stays where it was, and `validateLanes` refuses a lane that claims it
   (`LANE_RESERVED`). A table therefore *adds* endpoints; it cannot move, rename or shadow the one the client's
   reconnect logic names (`public/js/net.js`), and a server started with no lanes — the default, and the only thing
   `npm start` has — answers byte-for-byte as before: `/ws` accepted, everything else 404.
2. **Exact paths, never a subtree.** `resolveLane` compares the whole `rawPath`, so `/duel` cannot silently take
   over `/duelx`, and a query string or fragment is refused by `isLanePath` rather than being parsed differently in
   two places. One listener (`websocket.js`'s `'upgrade'`) still owns the whole decision, so the order of parse →
   resolve → admit → hand over cannot differ between the game and a lane.
3. **A lane gets no privileges, and is never a fallback.** `Network.admission` runs for a lane exactly as for `/ws`
   — registering a path is not a way to serve more sockets per address (`maxConnectionsPerAddr`) or past a full
   server (`maxConnections`). A lane that throws has its socket closed and is named in the log; it does not fall
   through to `/ws`, because "ask for the mode, land in a match" is the failure this cell exists to prevent.
4. **A bad table fails at boot, naming every problem.** `attachWebSocket` throws with the whole `problems` list
   rather than starting with the lanes it happened to like. This is the silent-revert shape this family has been
   burned by before (an overlay that stops matching, no error, the feature simply gone): an operator who asked for
   `/duel/lobby` and got a permanent 404 is worse off than a server that refused to start.

**What this does *not* open — read this before proposing the next cell.** A lane is registered by **the host process,
from code the operator installed**. Nothing here gives a **pack** a socket, a port, a route or a listener: packs
still get no `fetch`/`WebSocket`, no timers and no child processes (`shared/kitAuthoring.js`, §28.13.1), the static
channels stay `.json`-only (§28.13), and `C2S` is still a closed set a pack cannot extend (`server/net.js`). Letting
a pack declare a lane is a separate ruling with its own surface cell, its own abuse analysis (a lane is a network
listener owned by untrusted code) and its own version policy — it is deliberately not folded into this one.

**Cost and blast radius.** One new file (`server/http/wsLanes.js`), one call site in `server/index.js`
(`lanes: opts.wsLanes`), and the guard plus hand-over in `websocket.js`. Per `docs/MOD-SURFACE.md`'s policy this
adds no pack-facing surface at all, so `MOD_API_VERSION` does not move and no published pack is refused.
Numbering: `main` 到 0.15.1 那一刀写到 **§28.37**（§28.30–§28.37 是「服务端四格能力 + 面板第二批读面」那一批），
**本仓库此后又往后落了若干格，现存最大是 §28.43.4**；而 §28.23（#2）与 §28.26–§28.27（#3）仍在两个待审 PR 手里，
所以这一格往后接 **§28.44**，不插进那条被占用的连号 —— 与 §28.28/29 当年的放法同一条。

Tests: `test/wsLanes.test.js` (8) — the shape layer (`isLanePath`, the five refusals by name, the empty-table
identity, exact-match resolution) and, unlike a pure shape-layer test, **a real `http.Server` with real `ws`
handshakes**: a lane answers its own path while `/ws` still reaches `Network.handleConnection`; a refused admission
never reaches the lane's handler; a throwing lane closes its socket, is named, and does not become a game connection.

### 28.45 The request-path table: a mode's own page and its own POST (implemented)

**The gap, stated as three fates.** `server/http/routes.js` knew exactly three outcomes for a request: 405 for any
method but `GET`/`HEAD`, the engine's own exact paths (`/healthz`, the mods catalogue), and the static files. A
self-contained game mode needs things none of those provide — a page of its own under a namespace, its own assets
behind that namespace, and usually a **POST** endpoint (a report, a receipt). The only way to get them was to edit the
method gate, which is the same trap §28.44 describes for the upgrade path: every fork owns a private copy of the rule
that guards the front door.

**The ruling.** A second table, held by the host process, decided before the response is written:

```js
startServer({ httpLanes: [{ id: 'duel', prefix: '/duel/', methods: ['GET', 'HEAD', 'POST'], onRequest }] });
```

Four properties, and the first one is what makes a *prefix* table safe to have at all:

1. **A lane cannot overlap the engine's URL space, and that is checked against the engine's own constants.**
   `ENGINE_HTTP_RESERVED` is a **union of two imported truths**: `RESERVED_ROUTE_PREFIXES` + `DYNAMIC_ROUTE_PREFIX`
   (`server/http/routeMount.js` — the engine's own top-level namespaces, which §28.35 already keeps as one reusable
   list, `/mod/` `/i18n` `/data.js` `/shared` `/ws` `/healthz` included), and the constants the handlers actually serve:
   `MODS_CATALOG_URL` / `MOD_FILE_PREFIX` (`server/http/mods.js`), `PACKS_URL`
   (`shared/packs.js`), `MEDIA_PREFIX` (`shared/media.js`), `ROOM_DATA_PREFIX` / `WORKSHOP_BATTLE_PREFIX`
   (`server/http/static.js`), the three `WORKSHOP_*_PREFIX` names (`shared/workshop.js`) — plus the literals the
   static handler holds without exporting (`/data/`, `/sim/`, `/assets/`, `/fonts/`, `/workshop-kits/`, the public
   root `/`). Importing instead of re-typing is the point: the reserve list cannot drift away from the
   routes it protects. `/mod/` in particular is the namespace a pack's `host.route()` endpoints live in, so a host
   that claimed it would shadow pack content invisibly. Claiming a folder that actually exists inside `publicDir` is also refused
   (`LANE_SHADOWS_PUBLIC`) — registering `/assets/` would silently steal art the client loads from disk.
2. **The engine's three fates are untouched for every request a lane does not claim.** A lane is consulted after URL
   parsing and before the method gate, so `POST /healthz` is still the 405 it always was (a lane can never own that
   path, rule 1), and an unknown path still ends in the static handler. No lanes — the default, and the only shape a
   plain `npm start` has — is the same table as an empty one.
3. **Only three methods exist here.** `GET`/`HEAD`/`POST` (§28.13's static channels stay `.json`-only; this is not a
   way to smuggle a write API into the game's own surface). Anything else is still the flat 405.
4. **A lane owns its response and its own failures.** It reads any body, sets its own content type; a throw is caught
   by the listener, answers 500 only if nothing was written yet, and is logged **by lane id** — it never falls through
   into the game's static space. The security headers (`common.js`) are set before the lane is asked, so a lane cannot
   drop them. A bad table fails at boot, naming every problem — §28.44's rule, same reason.

**What this does *not* open.** Same boundary as §28.44: a lane is code **the operator installed**, not something a
pack declares. A pack's `routes` stay `.json`-only (§28.13), packs still get no `fetch`/`WebSocket`, no timers, no
child processes (`shared/kitAuthoring.js`), and `C2S` is still the engine's closed set. Whether a pack may register a
lane is a separate ruling — a lane is a network listener handed to untrusted code, and that needs its own abuse
analysis and version policy rather than being folded in here.

**Cost and blast radius.** One new file (`server/http/httpLanes.js`), the table lookup in `routes.js` (which keeps the
single `handleRequest` and therefore the single order of decisions), and one option threaded through `startServer`.
Nothing is added to the pack-facing surface, so `MOD_API_VERSION` does not move and no published pack is refused.
Numbering: `main` 到 0.15.1 那一刀写到 **§28.37**，**本仓库此后又往后落了若干格，本格之前现存最大是 §28.44（姊妹格升级路径表），再往前是 §28.43.4**；
而 §28.23（#2）与 §28.26–§28.27（#3）仍在待审 PR 手里，所以这一格接 **§28.45**，紧挨着它的姊妹格升级路径表
（**§28.44**）—— 两条都不插进那条被占用的连号。

Tests: `test/httpLanes.test.js` (9) — every reserved URL proven unclaimable from the imported list, the
`publicDir` overlap, the method closure and the five refusals by name, then **real `fetch` requests against a real
server**: a lane answers its subtree including POST, `POST /healthz` is still 405, an unclaimed path still reaches the
static handler, and a throwing lane answers a named 500 without reaching the game.


### 28.46 `pack.json.target`：一份清单，两个宿主读得懂（`forge` 缺省 / `stardust` 声明型）

**要解决的问题。** `pack.json` 的顶层键是**闭集**（§28.1 那条最硬的纪律：不认识的键点名拒绝，绝不读过去）。这条纪律对
Forge 自己的包是对的，但对**同一份清单要给两个宿主读**的场景是一个死结：Stardust 宿主认识的键（`type` / `capabilities` /
`englishName` / `authors` / `app`，以及能力自己认领的 `announcements`）在 Forge 这一侧会被 `PACK_UNKNOWN_FIELD` 整包拒。
作者于是被迫维护两份几乎一样的清单 —— 而那正是「同一份 pack.json 两端各自读得懂」要消灭的东西。

**这一格的形状。** `pack.json.target`：`"forge"`（缺省）或 `"stardust"`（`PACK_TARGETS`，闭枚举）。写别的值
`PACK_TARGET_UNKNOWN` 整包拒。

**`forge`（缺省）这一支：一个字节都不动。** 不写 `target` ⇒ 归一化清单里**不长出这个键**（与 `skins` / `variants` /
`behaviour` 同一条「写了才进清单」的纪律）⇒ 包身份哈希（`identifyPack` 的 `canonicalJson(pack)`）、
`/mods/catalog.json`、`PROTOCOL_VERSION` 与 `MOD_API_VERSION` 全部逐字节不变。显式写 `target: "forge"` 是**一条声明**，
它进清单、也进哈希 —— 这是对的：两份行为可能不同的包不该共用一个摘要。

**`stardust` 这一支：本引擎只认识、不装载。** 判定在 `shared/workshop.js` 的形状层（`type` 必须是 `"mod"`、
`capabilities` 是能力 id 列表、闭集例外只对**声明过的能力**放行），装载在 `server/workshop.js`：`target === 'stardust'`
的包进 `foreign` 列表（一行具名 INFO 日志），**不进** `packs`、**不进**数据叠加层、**不进** `/mods/catalog.json`。
它也不需要任何 Forge 贡献项 ⇒ `EMPTY_PACK` 对它不适用。

**三条裁决（本刀的口径）。**

1. **不抬版本**：加一格字段、且缺省路径逐字节不变 ⇒ `MOD_API_VERSION` 仍是 `1`、`PROTOCOL_VERSION` 仍是 `2`。
   先例是 §28.39 / §28.43 / `server.modules` 的 `metrics`·`route`。抬世代的三种情形（已有声明改语义 / 新声明复用
   老引擎会按旧语义执行的键 / 删改名任何一格）一条都不成立。
2. **闭集就地延长**：`PACK_FIELDS` 32 → 33（`test/packBehaviour.test.js` 的计数与 `docs/STANDARD-PACK.md` 同步）。
   副作用要如实说：`PACK_UNKNOWN_FIELD` 的错误文案里**列出全部键**，所以每一个未知键的报错文案都变了 —— 那是文案，
   不是判据。
3. **`stardust` 包的作者可见面（本刀未接线，已由紧随其后的一刀接上）**：§28.46 落地时本引擎只在**启动日志**里
   具名说一句 —— `tools/workshop-validate.mjs` 不读 `loaded.foreign` ⇒ 一个 stardust 包在验证器报告里**完全不出现**
   （既不报错、也不列出）；`tools/workshop-pack.mjs list` 把它打成 `REFUSED（null）`（`packSummary` 没有这一支）。
   那是**已知缺口**，而复刻的正是 §1.1 那条教训（「磁盘上在、编辑器里在、却永远进不了游戏，没有任何报错」），
   所以紧接着的一刀把**三面**都接上了：验证器给它一行具名 `PACK_FOREIGN` warning（外加收尾那句
   `NOTE: N pack(s) target another host ("stardust") …`）、`packSummary` 新增 `foreign` 档且 **`reason` 有值**
   （列表打 `FOREIGN（本引擎不装载：…）`，不再是 `REFUSED（null）`）、编辑器列表行与详情页各一个 `foreign` 分支
   （用 `warn` 而不是「被拒」—— 清单合法、作者没写错任何东西；中英双语）。三面各有契约测试钉住
   （`test/modTarget.test.js` 的 ⑤①–⑤④），**去掉任一面 ⇒ 该面当场红**。

**测试**：`test/modTarget.test.js` —— 缺省逐字节不变（一袋 17 个语料包的摘要**冻结**成字面量，移植前实测）、
`target: "forge"` 下 `type` / `capabilities` 仍被拒、`PACK_TARGET_UNKNOWN` / `STARDUST_TARGET_BAD_TYPE` /
`STARDUST_TARGET_BAD_CAPABILITIES` 逐条、能力认领字段跟着能力走、装载器 `foreign` 具名且不进目录、两个版本号不动。

---

### 28.47 mod registry：一份登记册，装过什么 / 操作者启停过什么

**要解决的问题。** 一个包**在磁盘上**、清单**一字不错**、却什么都没装载 —— 这是本仓库反复判过死刑的结局
（§1.1）。在「管理器」出现之前，包只有「装」与「没装」两种状态，所以没有第三种可能。管理器一旦能**启用 / 禁用**
一个已存在的包，就多出第三种状态：**装了但不装载**。这一格必须（a）有一个**唯一事实**说清它今天是什么状态，
（b）**结果上与装载失败一模一样** —— 没有 hook、没有订阅、没有面板、没有字节进数据叠加层，而（c）文件**留在
磁盘上**，一条 `enable` 就回来。

**唯一事实：`mod-registry.json`（登记册）。** 它在**状态根**（`server/modModules.js` 的 `stateRootFor`，即
`<repo>/var` 或 `SP_STATE_DIR`），与 `server.modules` 写的是同一棵树，**永远不在** `workshop/` 包根里 ——
那里是加载器扫描的地方，一个状态文件放进去会被当成一个包。形状：

```json
{ "version": 1,
  "packs": { "<包 id>": { "state": "enabled" | "disabled",
                          "installedAt": "<ISO 日期>", "source": "<文件名|目录名>", "digest": "<sha256>",
                          "previous": { "digest": "<sha256>", "backup": "<包内相对留底目录>" } } } }
```

CLI、编辑器、服务器读的都是这一个文件，**谁都不留第二份副本**。写入是**原子**的（同目录临时文件 + rename）：
半个登记册比没有登记册更坏。

**方向：不在册 = 启用。** 这一条是故意选的。装一个包就该立刻能用（所有现存的安装方式都依赖这一点），
「禁用」是操作者的一次**明确动作**。反过来的话，这个文件一旦丢了（或换了机器），所有包都会**静默消失** ——
又是一个静默方向。`applyModRegistry` 把被禁用的包在**任何载荷算出来之前**移出集合，所以它与装载失败的包
在结果上不可区分。

**删除的两道闸（本节的硬规矩）。**

1. **ownership —— 只卸载本管理器登记过的包。** 登记册里没有记录的包可能是仓库自带、手工放置或者旧版装的。
   这个管理器**不认识**它，就没有资格处置它；`uninstall` 点名拒绝，要删请手动。
2. **留底 —— 卸载不销毁字节。** 卸载与回滚都是 `fs.renameSync` 把整个包目录挪进
   `<root>/.mod-backups/<id>/uninstall-<时间戳>/`（或 `pre-rollback-<时间戳>/`），**不是 `unlink`**。目录名点开头
   ⇒ `loadWorkshop` 不扫描 ⇒ 它**立刻**"不在"，但一个字节都没丢；手滑、后悔、想查证原包长什么样都有地方找回来，
   CLI 会把留底路径打出来。升级（`import --force`）也走这条路：被顶掉的旧版进 `.mod-backups/`，
   旧摘要随登记进 `previous`，`rollback` 靠它回去。

**三条硬边界（本节的第二组硬规矩）。** ① 只 rename **这个包自己的目录**（`findPackDir(root, id)` 的结果）；
② 引擎文件 / `data/` / `test/golden/` **一律不碰**；③ **越界删除必须被拦，而且要有测试证明**。
第 ③ 条分两层，两层都测：**入口层**是 `findPackDir` 的 `PACK_ID_RE`（`^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`）——
`../../x` / `..` / `a/../../b` / `C:\Windows` 这类写法当场 exit=2 具名拒绝，所以 `path.join` 拿到的永远是一个
纯 slug。但**只测入口是不够的**：登记册里那个**会被拼成路径**的 `previous.backup` 是外部数据，所以
`normalizePackEntry` 是第二层闸 —— 它只接受**包内相对的留底目录**，含 `..` 的、绝对路径的**整格丢掉并具名报出**。
于是「即使 id 合法、即使登记册被人手改过，删除也只落在工坊根之内、只落在那个包自己的目录上」是可以证明的。
证明的方式是**逐字节比对目录树**（`test/modRegistry.test.js` 的三条「越界」测试）：

* 越界① 一棵「像仓库」的树（`data/`、`test/golden/`、`server/` 哨兵 + root 的同级哨兵）里跑一次 `uninstall`：
  包自己的目录走了、留底里有完整的包，而四棵树**逐个哈希不变**，root 的同级目录也**没有多出任何条目**；
* 越界② 手改登记册把 `previous.backup` 指向 `../outside-marker` ⇒ 读的时候那一格就被点名丢掉 ⇒ `rollback`
  只能拒；工坊根之外一字节不变，包还在原位；
* 越界③ `data`（**合法 id**、也确实在工坊根下有一份 `pack.json`，即**过了入口那道闸**）没有安装登记 ⇒
  `uninstall` 拒绝，被拒的目录（含引擎的 `data/gamedata.json`）一字节不变，连 `.mod-backups/` 都不该被建出来。

**与作者可见面的衔接。** 一个被禁用的包在 `tools/workshop-pack.mjs list` 里带 `· DISABLED（不装载）` 后缀 ——
它与 `FOREIGN`（§28.46）那一格**正交**：禁用的包**可以**同时是 `VALID`（清单没问题，是操作者把它关掉了），
所以两个后缀分开说。不说出来就是又一次「在磁盘上、在列表里、却永远进不了游戏、没有报错」。

**不抬版本**：`MOD_API_VERSION` 仍是 `1`、`PROTOCOL_VERSION` 仍是 `2`。这一节**没有**动 `PACK_FIELDS`，
登记册是**操作者的状态**、不是包能声明的字段。

**测试**：`test/modRegistry.test.js`（登记册形状 / 越界与绝对路径的 `previous` 逐条丢掉 / 不在册即启用 /
disabled 具名离开集合 / import 记录 install / `--force` 升级留底 + `rollback` 还原 / uninstall 留底 /
未登记包的 ownership 拒绝 / 原子写不留临时文件 / 上面三条越界证明）。

---

### 28.48 `pack.json.dependencies` / `conflicts`：装载期的跨包裁决

**要解决的问题。** 一个包声明「我依赖 `lib`」「我和 `beta` 互斥」时，这句话**只有在真的装了哪些包之后**才成立。
作者交上来的是一份 `pack.json`，他看不到别人的 `workshop/` 里有什么。所以「缺依赖」不是他写错了，而是
**这台机器上这个组合不成立** —— 这正是**装载期**的判断，形状层判不了它。

**形状（`shared/workshop.js` 的 `parseModRefsDecl`）。** `[{ id, range? }]`：`id` 是**另一个工坊包**的 id
（`PACK_ID_RE` 同一套字符集 —— 一个 `../escape` 在这一层就被点名拒，绝不留到装载期去拼路径），`range` 是那个包
`version` 的区间（`shared/packs.js` 的同一套语法，缺省 = 任意版本）。两条形状纪律：**逐字重复的条目去重**
（输出按 `(id, range)` 排序，归一化确定）；**同一个 id 配两个不同的 range 点名拒绝**
（`*_CONFLICTING_RANGES`）—— 哪个区间算数？作者没说，猜一个就等于替他做了一个会影响装载的决定。
错误码：`DEPENDENCIES_` / `CONFLICTS_` 前缀的 `BAD_SHAPE` / `BAD_ENTRY` / `UNKNOWN_FIELD` / `BAD_ID` /
`BAD_RANGE` / `CONFLICTING_RANGES`。

**与 `content` 白名单无关、不是贡献项。** 两个键都进 `PACK_FIELDS` 闭集（§28.1），都**不在**
`WORKSHOP_CONTENT_FILES` 里，都进 `notContributions` —— 一个只声明依赖的包自己**不带来任何内容**，与
`support` / `playtest` / `variants` / `behaviour` 同一条，照旧 `EMPTY_PACK`（文案里逐字点名它）。
「写了才进归一化结果」照旧：没声明的包哈希逐字节不变（§28.2）。

**五条裁决规则（在 `adjudicatePackGraph`，纯函数、确定性、全部具名）。**

1. **缺失依赖** ⇒ 依赖方被拒（`missing dependency "x"`）；
2. **版本不合** ⇒ 依赖方被拒（`dependency "x" version 1.0.0 does not satisfy ">=2.0.0"`）。
   **依赖包自己没写 `version` 时视为满足** —— 它的 version 是「未声明」，不是「不匹配」。
   机制上：`normalizePackManifest` 把没写 `version` 的包归一化成 `0.0.0`，所以装载期看到的是一个字符串、
   分不出「没写」与「写了 `0.0.0`」，本仓库的口径是把 `0.0.0` 当作「未声明」（`declaredVersion`）。
   ⚠️ **这一条与社区 PR 自带的测试相反**：那条测试断言「未声明 ⇒ `0.0.0` ⇒ `>=2.0.0` 不合 ⇒ 拒」，
   而 PR 自己的文档规则（以及业主裁决）是「未声明 ⇒ 视为满足」。本移植按**规则**实现，并按规则写测试；
   冲突已记进 commit 消息的差异清单，翻回去是一行的事（`declaredVersion` 那一行返回 `target.version` 即可）；
3. **互斥** ⇒ **包 id 大的那个**被拒（`conflicts with "alpha" (declared by "alpha")`）。与既有裁决「同 id 抢占按
   包 id 排序」同一条确定性来源；双方都声明时同一条边只裁决一次，结论一样。带 `range` 时只有**区间匹配**
   （按第 2 条的口径）才互斥；
4. **级联** ⇒ 被拒的依赖让它的依赖方也无法工作，**迭代到不动点**（理由链完整：`depends on "x", which was refused`）。
   一次迭代不够：`top → mid → low → (缺失)` 要迭代三轮才把三个都收进来；
5. **循环** ⇒ 幸存集合里的依赖边成环，**环上全体被拒**（`dependency cycle: a → b → c → a`）。它与级联不同：
   环上每个包自己的依赖都「在」，但这份声明本身是死锁，没有任何一个能先装载。

**为什么是纯函数 + 排序。** 迭代顺序按包 id 排序、输出按 id 排序 ⇒ 同一份输入永远同一份输出，与输入顺序无关；
不改输入。`kept` 就是真正装载的集合，`refused` 由 `server/index.js` 变成具名的启动日志，并**同时进
`excludePacks`** —— 数据叠加层与装载器是同一次裁剪，否则被拒的包会留下一个「谁都不认识的干员」。

**裁剪点的顺序（`server/index.js` 的装配流水线）。** 登记册（§28.47）在最上游，紧接着是这一节的裁决，
二者都排在**任何载荷装载之前**（hooks / meta / server modules / battle / room）。理由与 §28.13 那些裁剪点
同一条：一个「包照旧加载、只是它的效果不在」的结局，会让运维以为自己有一道不存在的闸门。

**不抬版本**：`MOD_API_VERSION` 仍是 `1`、`PROTOCOL_VERSION` 仍是 `2`。闭集就地延长：顶层键 33 → 35
（`test/packBehaviour.test.js` 的计数与 `docs/STANDARD-PACK.md` 同步）。副作用如实说：`PACK_UNKNOWN_FIELD` 的
错误文案里**列出全部键**，所以每一个未知键的报错文案都变了 —— 那是文案，不是判据。**不需要 `golden:update`**：
没写这两个键的包一个字节不动。

**测试**：`test/modDependencies.test.js` —— 形状（去重 / 排序 / 六种点名拒）、归一化纪律（没写就不长键）、
五条规则逐条、级联迭代到不动点、循环具名成链、纯函数（输入不改、顺序无关、拒绝表按 id 排序）。
### 28.49 `trait.grantsBonds`：把「特质 → 盟约成员资格」写成数据

**业主原话**：「我们的 forge 能不能做出游戏内的『特质』效果，即一般是用来**叠加盟约层数**的固有天赋」。

**这一格是什么。** 一条 `chess.json` 记录可以在它的 `trait` 对象上写一格 `"grantsBonds": ["<bondId>", …]`：
**带这条特质的棋子，视为那些盟约的成员**。成员资格就是 `server/match/bondsMeta.js` 数的那一份（`rawCount` 按
`countMode` 数**去重 baseId 集合**，`tierFor` 按 `thresholds` 升序累加），所以 `grantsBonds` 里写一个盟约 ⇒
count +1 ⇒ **层数自然上去**。这是一条**纯数据**通道：不需要模块、不需要 `server.meta`、不需要一行脚本 ——
一个不懂代码的作者也能落这条天赋。

**为什么是「加一格记录字段」而不是「加一条 `behaviour` 开关」。** `behaviour`（§28.43）是**安装器**：选项由引擎
写死、包只能声明「要哪一档」。这里要的是「**记录自己**说它授哪几个盟约」—— 那是**内容**（与记录自己的 `bonds`、
与装备的 `giveBondId` 同类），所以它落在**记录**上、落在 A 层，且**不占** `behaviour` 表。

**一处判据、三处同源（本格真正的价值）。** 成员资格有三个读取点：prep 的 `bondsMeta.pieceBonds`、战斗里的
`support/index.js unitBonds`、客户端的 `gameLogic/bonds.js`。在 §28.43.1 之前，三处**各自**写了一遍「自己的
`bonds` + 装备授予」的合并循环；那正是这条规则历史上最容易分叉的地方（一份改了、另两份没改 ⇒「服务端数了、
卡片没显示」）。本格把两件事都收进 `shared/morph.js`：

* `grantedBondsByTrait(trait, { hasBond })` —— **这一格唯一的判据**（形状、去重、顺序、可选的存在性过滤）；
* `memberBonds(own, { trait, recs, morphed, hasBond })` —— **成员资格的合并本体**（自己的盟约 ∪ 装备授予 ∪
  特质授予）。三处读取点现在各写一行 `memberBonds`，**合并循环只剩一份**
  （`test/morphPairing.test.js` 的源码级断言随之收紧为锚 `memberBonds`）。

客户端的成员资格有**两个**读者 —— 卡片上的盟约 chips（`pieceBondIds`）与盟约弹窗的成员行（`bondMembers` 的授予
判据）。两处都补上了特质那条腿：漏掉后者会得到「服务端数了他、弹窗名单里没有他」。

**一个必须说清的读法。** 特质在 sim 里有**两个**字段：`unit.def.trait` 是 `simdata.js` 投影出来的 **trait 文本
字符串**（`rec.trait.desc`），`unit.def.raw.trait` 才是**记录**。子键只能挂在后者上 —— 读错了不会报错，只会静默地
什么都不授予。

**写歪了会怎样：点名，但不拒包。** `shared/workshop.js` 的 `unknownOverrideKeys` 只比**顶层**键
（`Object.keys`），所以往 `trait` 里加子键**天然通得过装载器**：一个拼错的盟约 id、或一个写歪的形状，会安静地
变成「这条特质什么都不授予」—— 正是 `docs/WORKSHOP.md` §1.1 记着的那类失败（`content` 没声明 `chess` ⇒ 编辑器里
在、磁盘里在、**永远进不了游戏、没有任何报错**）。所以：

* **判据只有一份**：`shared/morph.js` 的 `traitGrantIssues`，两个读者 —— 装载期（`shared/workshop.js` 的
  `traitGrantWarnings` → `report.traitGrants` → `server/data.js` 逐条 `warn`，`workshopSummary` 每包一句）与
  作者侧（`shared/chessAuthoring.js` 的 `validateChessRecord` ⇒ `npm run workshop:validate` 与编辑器，
  `severity: 'warning'`）；
* **三条码**：`TRAIT_GRANT_UNKNOWN_BOND`（本机 `bonds.json` 里没有这个 id，含别的包加进去的盟约）、
  `TRAIT_GRANT_BAD_SHAPE`（不是数组，或数组里有非空字符串以外的东西 —— `"x"` / `42` / `{}` / `[1]` / `[""]` /
  `[null]` 逐种都点名）、`TRAIT_GRANT_EMPTY`（空数组：声明了个寂寞）；
* **不拒包、不改记录**：一条 typo 不该让整包装不上（与 `assets.mirrors` 的「摘要对不上 ⇒ 停用并点名，**不拒包**」
  同一条；`ART_UNKNOWN_ID` / `VOICE_UNKNOWN_OPERATOR` / `ITEM_ICON_UNKNOWN_ITEM` 也都是 warning）。而**读取点**
  另外有一层 `hasBond`：不存在的 id 永远进不了计数 —— 「点名的响亮」与「数据的安全」是两件事，各做各的；
* **没有盟约表就不判存在性**（`bondIds` 不给时只判形状）：宁可不说，也不要乱说。

**缺省逐字节不变。** 官方 266 条记录一条都没有这一格，`grantedBondsByTrait` 在 `trait` 为字符串 / `null` / 缺项 /
形状不对时一律回 `[]`，`memberBonds` 在缺省输入下逐字等于从前那条算式 ⇒ `test/golden/*.json` 不需要
`golden:update`，`MOD_API_VERSION` 仍 = 1、`PROTOCOL_VERSION` 仍 = 2、版本号不动（**加一格字段不抬版本**）。

**Numbering.** 本仓此前最高是 §28.45；§28.46（`pack.json.target`）/ §28.47（mod registry）/ §28.48（依赖与冲突
裁决）由另一条并行线占号 —— 它们与本格一起并入 main，所以本格接 **§28.49**，不插进那串连号。

**Tests.** `test/traitGrants.test.js` —— 缺省不变（官方 266 条逐条）、真生效（`loadWorkshop` + `applyWorkshop` +
`GameData` + `computeBonds`：`egirShip` 2 名 ⇒ tier 0、补上探针棋子 3 名 ⇒ tier 1；4 名 ⇒ tier 1、5 名 ⇒ tier 2）、
三处同源（行为级对照 + 源码级断言）、坏 id / 坏形状逐种点名且计数不动、作者侧校验器的 warning（`spawnSync` 真跑
`tools/workshop-validate.mjs`）。

### 28.50 启用声明 `pack.json.enabled`：**装好 ≠ 生效**

> 来源：上游 PR#8（作者 jingjiangze）的 `shared/enabled.js` + `test/packEnabled.test.js`。上游把这一格编到 **§28.46**，
> 而本仓库的 §28.46 已经是 `pack.json.target`（§28.46–§28.49 已占用），所以本仓库按**下一个空号**落成 **§28.50**；
> 正文、判据与断言逐条对齐后随本刀落地。

**要解决的那面墙**：今天 `loadWorkshop`（`server/workshop.js`）遍历工坊目录，**每一个**能通过
`normalizePackManifest` 与那几道声明闸门的目录都进 `packs`，房间按**服务端装载集合**跑（不是房间自己声明的那一份）。
所以「装好」与「生效」在本节之前**是同一件事**：作者想让一个包暂时不参与，只能把它的 `pack.json` 改坏、或把整个
目录搬出工坊目录 —— 而这两条都是**响亮的失败**（前者进 `errors`、后者作者自己都不知道发生了什么）。本刀要的是
第三态：**包留在原处、字节完好、只是不参与**。

**它不是什么，比它是什么更重要**：`enabled` **不是**一条能力通道 —— 它不打开任何引擎里没有的东西，也**不可能**被
用来打开（包能声明的格子由 `shared/modSurface.js` 的清单与冻结账本决定，与本格无关）。它也不是**安装器的退让**：
安装器那个形态是「整份覆盖引擎文件」（§1.1 那六格挡的东西），本格只让一个**本来就完整可加载**的包不参与，字节一个
都不动。它与**热更新**的关系见下面第六条判据。

**形状**：`pack.json.enabled = true | false`，**只有布尔**。

**六条判据**（判据只有一份：`shared/enabled.js`；装载器调它，校验器与编辑器将来也调它）：

1. **只有布尔**：`"false"` / `0` / `null` / `"true"` 一律 `ENABLED_BAD_SHAPE` **整包拒**。理由与
   `BEHAVIOUR_BAD_OPTION` 逐字相同：一个被 JS 真值表放行的**假布尔**是**静默失效** —— 作者写下的是 `"false"`，
   引擎读到的是「启用了」，而这之间没有任何人会收到一条错误。
2. **缺省 = 引擎今天的行为**：不写 `enabled` 的包与今天**逐字相同**；写了 `"enabled": true` 也**逐字相同**。
   所以**只有 `false` 进归一化清单的 `declared` 数组** —— 无条件写进去会让 `identifyPack` 哈希的
   `canonicalJson(pack)`（`server/workshop.js` step 1）为**所有**已发布包换掉包身份，房间摘要闸门随即误判
   （§28.2 的老账，`variants` / `behaviour` / `skins` 同一条）。写 `true` 的包与没写的包**在数据上必须不可区分**。
3. **跳过必须响亮**：`false` 的包**不进入** `packs`，而是进 `loadWorkshop` 的 `errors`（`ENABLED_FALSE`），
   `loadWorkshop` 的调用方逐条 warn 点名。一个**静默消失**的包比一个报错的包难查得多 —— 这正是「一个用不了的声明
   拒绝整个包」的同一个姿态，只是这里的裁决是**跳过**而不是拒绝（包本身没有坏）。跳过发生在**归一化之后、读任何
   内容文件之前**，所以一个被关掉的包连它声明的 `chess.json` 都不读：为它报「缺文件」是噪声。
4. **不是贡献项**：只带 `"enabled": true` 的包照旧 `EMPTY_PACK`（与 `variants` / `playtest` / `behaviour` 同一条）
   —— 这一格从不贡献内容。
5. **进包身份哈希，不进 `modDigest`**：`enabled: false` 进包身份哈希（因为 `declared` 里有它），但**不进
   `modDigest`**（它只哈希 `[id, hash]` 对，`shared/modIdentity.js`）—— 与 `behaviour` 逐字同一条：一个开关不开
   不改变这一局跑的内容，只改变这一局**有没有**这个包。
6. **不是热更新**：`enabled` 在**装载期读一次**，改它要重启（§28.4 的「No hot reload」不受影响，本节不碰那条
   裁决）。本格与热更新的关系只有一条：它是**重启级**的第三态，不是**运行期**的第三态。

**`MOD_API_VERSION` 不动**（仍是 `1`）：加一格字段不抬版本有 §28.39 / §28.43 / §28.33 与 `server.modules` 的
`metrics`·`route` 多处先例。本刀是「新键 + 老引擎 `PACK_UNKNOWN_FIELD` **响亮拒**」—— 老引擎不是静默走错，是点名
拒绝，所以「新声明复用老引擎已认识且会按旧语义执行的键」也不成立。**「老引擎优雅降级」明确不做**：那会让「写了
等于没写」复活。

**披露（本节明确不做）**：`welcome.mods[]` **不投影** `enabled` —— 一个没进 `packs` 的包对房间**不存在**，客户端
没有任何东西可读。这与 `behaviour` 必须投影的理由（`Match` 要读那一格）正好相反：本格的全部效果都发生在装载期，
装载期之后没有任何读者。

**测试**：`test/packEnabled.test.js` —— 缺省不长键、`true` 也不长键（**两条一起**钉住「数据上不可区分」）、七种
假布尔逐条 `ENABLED_BAD_SHAPE` 且文案点名、`false` 的包不进 `packs` 而进 `errors` 且文案点名（含「怎么把它带回来」）、
被关掉的包不读内容文件、开着但缺文件照旧报缺文件（这一格不放宽任何既有校验）、只带 `true` 的包 `EMPTY_PACK`、
`identifyPack` 摘要三档对照（`false` ≠ 缺席 = `true`，走装载器同一份 `identifyPack`）。
**不需要 `golden:update`**：缺省路径一个字节不动。

### 28.51 口径数据通道：`variants.json`（已有记录的**另一套数值**）

**它补上 §28.39 剩下的那半个缺口。** §28.39 把「哪一套口径」收成闭枚举声明（`pack.json.variants`），并立下判据 2：
**包里没有数值**，值由引擎自己写。那条判据对**官方记录**成立（`data/chess.json` 266 条按 `shared/potential.js`
的 `potDown` 反推），但对**包自己带来的记录**不成立：一个包新增的棋子 / 召唤物是它手写的，引擎没有它们的
「另一套口径」—— `potDown` 只能从满潜**往下降**，一个按官方口径写就的记录没有任何东西能把它抬上去。

投稿 `c26a6ed4c1e7`（卡兹戴尔多功能）的 `payload/packs/fanpack/variants.json` 正是这件事：
`training.chess` **28 条** + `training.tokens` **4 条**，是它自带记录在满练度口径下的数值。它的语义记在自己那份
该投稿自己的 `dataVariants.js`（安装器那一半的 patch 语义）：**patch 格式 `{ [switch]: { [section]: patch } }`，叶子是 `{ $: value }`，
对象递归、数组与其余整块替换；开关打开时合到同名数据节上。**

**它为什么不是 §28.39 判据 2 的例外。** 那一条要挡住的是「包可以覆盖任意数值」（＝把安装器做进引擎）。
本刀开的通道**三条守卫**逐条对上那个危险，而且三条都是**具名整条拒绝**，不是忽略：

1. **不能发明记录**（`VARIANTS_TARGET_MISSING`）：目标 `<文件>:<id>` 必须在**合并后**的数据里已经存在。要新增一条
   记录请走 `content`（新 id）或 `overrides`（官方 id）—— 这一条通道只做「已有记录的另一套数值」。
2. **不能发明字段**（`VARIANTS_UNKNOWN_KEY`）：补丁只能写目标记录**已经有**的键，判据是**同一份**
   `unknownOverrideKeys`（`overrides` 的 `UNKNOWN_OVERRIDE_FIELD` 用的就是它，层级也一样：记录顶层）。
3. **不能发明轴**（`VARIANTS_UNKNOWN_AXIS` / `VARIANTS_UNDECLARED_AXIS`）：表名必须是 `shared/variants.js` 的
   `VARIANT_AXES` 里的轴，**并且这个包必须自己在 `pack.json.variants` 里声明过它**。后半条是**防静默**：
   一张没人声明过的表永远不会被应用，那正是这一层要消灭的失败方向，所以它是拒绝。

**七个码就是这一刀的全部**（`shared/workshop.js` 里出现的每一个 `VARIANTS_*`；闭枚举，加一个都要先改这里）。
数据文件那一半：`VARIANTS_BAD_SHAPE`（形状 —— 不是对象 / 某一层不是对象或为空 / 记录 id 不合法 / 补丁不是非空
对象）、`VARIANTS_UNKNOWN_AXIS`、`VARIANTS_UNKNOWN_FILE`、`VARIANTS_TARGET_MISSING`、`VARIANTS_UNKNOWN_KEY`、
`VARIANTS_UNDECLARED_AXIS`；声明那一半：`VARIANTS_NEED_COMBAT`（声明了轴就必须标 `combat: true`，§28.39）。
声明形状自己的那三个码（`VARIANTS_UNKNOWN_OPTION` / `VARIANTS_BAD_DEFAULT` / `VARIANTS_DUPLICATE_AXIS`）属于
§28.39，不在这一刀里。

**形状**（判据只有一份：`shared/workshop.js` 的 `normalizeVariantDataFile`，与投稿原件**逐层 1:1**）：

```jsonc
{
  "training": {                    // ① 轴名 —— VARIANT_AXES 的键（闭合）
    "chess": {                     // ② 数据文件 —— WORKSHOP_CONTENT_FILES 的名字（闭合，且不许是 variants 自己）
      "chess_char_9_01_a": {       // ③ 记录 id —— 装载期必须已在合并后的数据里
        "stats": { "atk": 676 } } } } }   // ④ 字段级补丁 —— 只许写目标记录已有的键
```

**它怎么落地**（`shared/workshop.js` 的 `applyVariantDataPatches`，`applyWorkshop` 里**唯一**的执行点）：

* `variants` 是 `WORKSHOP_CONTENT_FILES` 的第 15 个名字，所以整条既有机件**零改动**就到位：`content` 白名单、
  `identifyPack` 内容哈希（只差口径数值的两份包摘要必须不同）、`EMPTY_PACK`（口径数值**是**贡献项：它真的
  往对局里带了数值）、编辑器的通用枚举、`tools/workshop-pack.mjs` 的通用读取。**不是**一个新的 `pack.json`
  顶层键 —— 见 `PACK_FIELDS` 的「加字段的规矩」，加顶层键要同时给编辑器界面。
* 目标容器按 `OVERLAY_TARGET_BY_FILE`（与 `content` 同一张表：`units` → `backups.units`，其余同名），路径上
  **逐层浅复制**，所以 `data/` 的冻结对象一个字节都不动，路径之外的同层兄弟原样留着。
* 补丁走**同一份** `mergeRecord`（字段级：对象递归、`OVERRIDE_REPLACE_KEYS` 与数组整块替换、
  `OVERRIDE_KEYED_LISTS` 按身份键合）—— 一条判据只有一份实现。
* **生效条件**：该轴在 `mergeVariantDecls`（既有规则：**包 id 字典序小的赢**，§28.3）里落到**这个包**头上。
  别的包赢了同一个轴 ⇒ 这张表**不应用**，但**具名**记进 `report.variantPatches`（`status: 'overridden'`，
  与 `mergeVariantDecls.overridden` 同一条「输的一方必须看到一行字」的纪律）；启动日志里「写进去的」与
  「被抢掉的」分开数（`workshopSummary`）。
* **必须在所有包的内容都并完之后**（目标可以是另一个包贡献的记录），**在 `linkWorkshopStages` 之前**
  （那一步读 `stages` 记录之间的引用，补丁改的正是那些记录）。

**披露（本节明确不做）**：本通道在**装载期**生效，口径条件由 `pack.json.variants` 的声明给出。它**不接管**
运行时「玩家 `room.loadout.ops` 练度开关」—— `training` 轴今天的行为与 `variantDataPatch()`
（`shared/variants.js:228`）一字未改。这不是缩水：包自带记录的满练度数值引擎**结构上**推不出来，而官方记录的
数值仍然由 `shared/potential.js` 给；把包自带数值塞进运行时练度开关，等于让包的数值去覆盖玩家自己的设置。

**两处如实写下的边界**（都实测过，见下）：

* 投稿原件的 patch 语义是**深层字段合并**（它自己的 `applyPatch`），引擎的 `mergeRecord` 对
  `OVERRIDE_REPLACE_KEYS`（含 `skill` / `modules`）是**整块替换**。所以「按本通道装进标准包」这一步必须把
  那些分支写成**完整值**：实测直接把半份 `skill` 交上去，合并后丢 `skillType` / `spType` / `initSp`，
  `workshop-validate` 报 6 个 `BAD_ENUM` / `BAD_NUMBER`。这是**表示层**换算，数值一个不动。
* `mergeRecord` 对 `talents` 按 `index` **合**（`OVERRIDE_KEYED_LISTS`），作者没写的 `potMin` / `potBelow`
  官方潜能链会**留**在合并结果里 —— 引擎刻意如此（「作者没写的字段必须留着」）。判据因此落在「作者写下的
  每一个值都在」，而不是「合并结果逐字节等于作者的数组」。

**测试**：`test/workshopVariantsData.test.js`（形状与闭枚举逐码、三条守卫各自具名、字段级而非整块、
`tokens` 的 owner 变体同一条路、缺省逐字节不变、进内容哈希、落盘 → `loadWorkshop` → `loadData` 端到端），
以及就地翻转的 `test/workshopVariants.test.js`（`content:["variants"]` 从「点名拒」变成合法；
**不认识的条目仍点名拒**，例子改用仍然没有通道的 `config`）。`test/packAssets.test.js` 里 `FOUR_KEYS` 那一条
一个字没动。
**不需要 `golden:update`**：不声明 `variants.json` 的包与不装包的两条路径，数据逐字节相同、记录是同一个对象。


### 28.52 调用预算 `pack.json.callBudget`：每局每插件的次数上限（沙箱档的运行时保护）

**这一格补的缺口是「闸门 ≠ 上限」。** 我们只有 `combat: true` 这一道**闸门** —— 它回答「这个包能不能改对局
结果」，那是一句**意图声明**。它回答不了「它这一局能跑多久、能被调多少次」。于是一个诚实声明了 `combat: true`
的包（或者一个每 tick 触发一次、每次又挂一批计时器的回调）可以把整局拖住：上游的做法是每局每插件一个次数
上限（缺省 8000），耗尽即回滚该回调、撤掉它的计时器与标记 buff、记一笔点名到插件 id 的错。本格就是那件事。

**与 module 档并存，不替换它**（业主口径；`docs/MOD-SURFACE.md` 的「刻意不是表面的东西」一节同理）：**module 档
保留现状**（内容文件 + kit 白名单 + `server.meta` / `server.battle` 全能力），沙箱档**新增运行时保护**。所以预算
**按档启用**：**只有声明了 `pack.json.callBudget` 的包才建账**（见下面的「怎么启用」）。没声明的包一行都不多跑。

**形状**（判据只有一份：`shared/callBudget.js` 的 `parseCallBudgetDecl`）：

```jsonc
"callBudget": { "max": 400 }   // 可省略 max（= 引擎缺省 8000）；只能比 8000 小
```

四个码：`CALL_BUDGET_BAD_SHAPE`（不是一个对象）、`CALL_BUDGET_UNKNOWN_FIELD`（闭集外的键）、
`CALL_BUDGET_BAD_MAX`（不是 ≥ 1 的整数 —— 字符串 `"8000"` 也在这里被拒，真值表放行就是静默失效）、
`CALL_BUDGET_TOO_HIGH`（**比缺省值大**）。

**只许收紧、不许放宽**：`max > PACK_CALL_BUDGET_DEFAULT` 是**点名拒绝**，文案里把理由说出来 ——「一个能把上限
调高的声明等于没有上限」；作者真的需要更多，说明他要的是**没有上限**，那件事在这一格里不存在（不写 `callBudget`
就是留在 module 档）。这一条也是这一格不必要求 `combat: true` 的原因：与 `variants` / `behaviour` 那两条
`*_NEEDS_COMBAT` 的区别是**方向** —— 那两格**授予能力**（所以必须声明意图），这一格**只收紧**，它永远不能让一个
包变得更有能力，要求 `combat: true` 只会把诚实的内容包挡在沙箱档外面。

**它必须进内容摘要。** `callBudget` 是 `pack.json` 的顶层键（`PACK_FIELDS`），且**只在声明过时才进**归一化清单
（与 `variants` / `behaviour` 逐字同形）—— 后半条是硬性的：给每个包补一个 `callBudget: { max: 8000 }` 会让
**所有已发布包的内容哈希全变**，而哈希是房间身份与 W-D 对齐的依据（§28.2）。进了清单就有两件事同时成立：
**不声明 ⇒ 逐字节等于今天**；**两份只差预算的包是两个身份**（一个会截断回调、一个不截，共用摘要就等于房间闸门
放行两种玩法）。**不是贡献项**：只带 `callBudget` 的包照旧 `EMPTY_PACK`（文案里点名它）。

**运行时落在哪：`server/sim/battle/hooks.js` —— 两端**同一段字节**。** 这是这一格最容易做坏的地方。计数与回滚
不能一端一份：两端若在**不同的调用次数**上回滚，之后的状态就分叉了，而「同一份摘要 ⇒ 同一份行为」正是这个中间层
存在的理由。所以规则（缺省值、什么算一次、回滚记什么错）住在 `shared/callBudget.js`（`PACK_CALL_BUDGET_DEFAULT`
只有这一份、`packCallAllowed` 是那条唯一的规则），而**记账与回滚**住在 `BattleHooks` —— `server/sim` 在 Node 与
浏览器里跑的是同一段字节。两个刻意的形状选择：

* **只盖 `pack` 字段，不动 `owner`。** 既有的 `owner` 语义（`offOwner(unit)` 撤掉一个干员的全部 hook 与计时器、
  `professions.js` 的 `{ owner: unit }`、`spec.js` 的 `owner: 'lpMeter'`）一个字节都不改；预算账记在**另一个字段**上。
  `install(battle)` 在 `_withPackScope(packId, …)` 里跑，所以这一趟挂上的 hook / 计时器 / buff 都带上 `pack`；
  在一个包的 hook 里**再**注册的回调也归它（作用域会传下去）—— 否则「在被限的回调里再挂一批回调」就是自造第二本账。
* **回滚复用 `offOwner` 那一套清扫**（键从 `owner` 换成 `pack`），撤掉它全部 hook 与计时器、撤掉它**标的** buff
  （`makeBuff` / `addBuff` 上的 `pack` 字段就是「标记 buff」，缺省 `null` = 引擎 / 官方内容，永远不受影响），
  然后记一笔 `plugin:<包id>` 的错（进 `battle.errors`，日志一行 `[sim] plugin:<id> …`）。撤 buff 时**不跑
  `onRemove`**：正在拆的就是这个包自己的东西，让它在回滚途中再跑一轮只是给它一次机会。

**`kits/*.js` 的逐单位回调也在同一本账上。** 一个包的战斗行为有两半：`server.battle` 的 `install(battle)`，与
`kits/<id>.js` 的 `install(battle, unit)` / `talents[].install` —— 后者才是「每 tick 触发一次、每次又挂一批计时器」
最自然的落点，所以它必须归账。kit 函数表（`Battle opts.kits` / `tokenKits`）本身**不带所属包**，于是**归属**与
**生效上限**分两张表随 `Battle opts` 走（`kitOwners` / `tokenKitOwners` / `kitBudgets`，只在这一局真的有包时才有
这几个键）：

* 归属在 `server/sim/content/index.js` `setupUnitKit` **选中那个 kit 的那一行**按**对象身份**记进一张 `WeakMap`
  （`kitPackOf`）—— 不给 `Kit` 加字段（那是**包自己返回的对象**，加字段就是改包的返回值、也会漏进 `kitShape` 之类的
  比对），也不在别处按 `def` 重算一遍（那就是第二份「哪个 kit 胜出」：`kitKeyOf` 的键顺序 + mode 分支 + 命中后返回
  假值时的回退）。键顺序与 `kitOf` 共用同一份 `kitKeyOf`，`kitOf` 的行为逐字不变。
* **注册点在 `server/sim/battle/players.js` `_setupUnit`**，不在 `setupUnitKit` 里那次**构造**调用：包通常在
  `install` 里挂钩子，只把构造调用包进作用域是**空转**（通道通了没人用）。那两行把包喂进**已有的**
  `_safe(fn, label, owner, pack)`（`pack ?? this._packScope`，并在回调期间设 `_packScope`），于是 `talents[].install` /
  `kit.install` 里挂的 hook / 计时器 / buff 自然盖上 `pack`，与 `install(battle)` 那一半落进同一本账。调用方直接递进来
  的 kit（包在回调里 `_setupUnit(t, kit)` 生成的召唤物）留 `null`，作用域落到**当前**那个包上 —— 那是我们要的。

**只带 `kits/`、没有 `server.battle` 的包也建账。** 开账不只发生在 installer 那一趟（`server/sim/content/index.js`
的 `installers` 循环只覆盖声明了 `server.battle` 的包），所以「包 id → 生效 max」还随**同一份 kit 模块清单**交出去：
`server/workshop.js loadWorkshopKits` 把生效值挂到 kit 模块条目上（`callBudget`，与 `workshopBattle` 那份逐字同形）
并交出一张 `budgets` 表，服务端按它开账、浏览器那半 `public/js/battle/runner.js loadSpecKits` 从**同一份清单**上读
**同一个数字**（它不自己算一次），**没有新造 wire 字段**。「包 → 生效 max」只有一份实现
（`shared/callBudget.js` 的 `effectivePackCallBudget`），两个装载器都读它。同理，spec 的投影必须把这个键带过线：
`buildBattleSpec` 的 `workshopKits` / `workshopBattle` 两份清单都要写 `callBudget` —— 漏一份，浏览器那半就建不了账
而服务端复算那半会回滚，两端在**不同**的调用次数上停（`loadSpecBattleInstallers` 读的就是它）。

记账的口径：`max` 是**可用次数**（第 `max` 次仍放行，第 `max + 1` 次不放行并触发回滚）；计数**按插件聚合**
（hook、`after` / `every` 排的计时器、标了记号的 buff 的 `onTick` / `onExpire` 同一本账）。

**探测不进建房路径。** 判决「这个包用不用得上预算」发生在**装载期一次**：`server/battlePack.js`
`loadBattleInstallers` 读 `effectivePackCallBudget(pack)`，把生效值**同时**挂到 `installers[]`（服务端真函数）与
`modules[]`（送到浏览器那份 URL 清单）；`server/workshop.js loadWorkshopKits` 对 `kits/` 那一半做同一件事
（见上一条）。浏览器那一半 `public/js/battle/runner.js loadSpecBattleInstallers` / `loadSpecKits`
原样带进 `createBattleFromSpec` —— **两端唯一的差别就是「谁去 import」，预算不在这条差别里**。
`server/lobby.js`（`room.create` / 房间建立流程）里一个字都没有，判据用源码反射钉死：上游实测过「探测期大厅暂停」。
为什么不必再探一次：那一刻的声明已经进了包的内容哈希（上面那一条），同 hash ⇒ 同字节 ⇒ 同预算。

**怎么启用（本刀只做机制，不改任何现存包）**：给某个包的 `pack.json` 加一行 `"callBudget": { "max": 8000 }`
（或更小）—— 它就从 module 档进了沙箱档。哪些包进沙箱档由**站的声明**决定，本刀不替站侧决定。

**测试**：`test/callBudget.test.js`（形状与唯一常量、缺省下内容哈希仍是改动前那个字面量、超预算回滚四件套、
两端同一个数字与同一次调用上回滚且预算路径**无端特有分支**、`server/lobby.js` 里没有探测；**kit 那一半**：
不声明预算时 kit 回调逐字节等于今天（改动前跑出来的基线字面量）、超预算时它的逐单位回调被回滚、`owner` 语义
一字节不改、只带 `kits/` 的包也建账且浏览器从同一份清单上读到同一个数字、三张表真的被转发进 `Battle opts`）。
**不需要 `golden:update`**：不声明 `callBudget` 的包归一化清单不长键、`BattleHooks` 的记账对没有账的回调立刻放行，
所以不装包与不声明预算两条路径的**战果逐字节相同**（实测见交付说明）。

### 28.53 房间同意 + 服主 pin：把「信任」从作者自觉挪到**每名真人的表态**与**字节**上

我们的信任原来压在「审查 + 作者自觉」上：`checkModSet`（§28.9）让客户端回一个**进程集合**的摘要，回了就放行。
那是一个**握手**（客户端证明它读到了服务器装着哪些包），不是**表态** —— 一位博士可以在一句提示都没看到的情况下
进到一个跑别人写的战斗逻辑的房间里。这一节补两件事，**都不换掉既有守卫**，是在它们旁边加一道：

**① 每名真人须同意。** 新的错误码 `MOD_CONSENT_REQUIRED`（`shared/constants.js`），C2S `room.join` 多一格
**可选**的 `consent: true`（`shared/protocol.js`）。判据两处：进房（占**玩家座位**之前，所以没同意的人**进不去**，
不是「进来了只能看着」）与开局（`room.start`，所以集合中途改过之后**没有人重新 join** 也拦得住）。同意的内容是
**一份字节指纹**：`seat.modConsent === room.modSet.digest` 才算同意过 —— 集合一变，摘要就不同，同意自动作废
（`setRoomMods` 里还会显式清空一次，那是第二层保险）。比「同意过一次就一直算」诚实：他当初同意的是另一份字节。

三条边界是**判断**不是漏判，与既有那些判据**逐字同一条口径**：

* **房主不受它约束**：`room.create` 报出的 `modIds` 就是他在钉这一份字节（`create` 据此把房主的座位写成
  `modConsent = digest`）。要求一个人对自己刚钉下的东西再点一次同意，不增加任何信息。
* **AI 座位不算**：`addBot` 建出来的座位天生 `ready: true`，而 AI 从不对齐任何字节、也没有客户端 —— 与
  `roomModsRefusal` 只数 `!seat.isBot` 是同一条口径。
* **观战者不算**：他们不走 `join`、不占玩家座位、不参与开局门槛（`activeHumans`）。他们不跑这一房的内容。

**② 服主 pin = 房间的字节指纹。** pin 不是一个新的对象：**`room.modSet.digest` 就是它**（`modSetOf` 算的
`[id, hash]` 排序对 sha256，§28.2）。「指纹变了」只有两种形态，两种都复用**早就在这台机器上**的那两道守卫：

| 漂移 | 判据（`shared/modIdentity.js modSetDrift`） | 复用哪个码 |
|---|---|---|
| 包没了 | `missing: [id]` | `MOD_UNKNOWN`（「本服务器没有这个包」本来就是这件事） |
| 包被换了（同 id、另一 hash） | `changed: [{ id, was, now }]` | `MOD_SET_LOCKED` + 一句说真话的 detail |

判决点两个：`server/lobby.js` 的 `join` 与 `start`（都走 `modPinRefusal`）。**没有第二套「pin 对象」**，也没有
第二个算摘要的地方 —— `modSetDrift` 住在 `shared/modIdentity.js`，与算摘要的代码同一个文件、同一条 `[id, hash]`
口径。没声明集合的房间（`room.modSet === null`）在这两个判决点都是第一行早退。

**加了哪一格、没抬什么版本。** `consent` 是**加性可选字段**，所以 `PROTOCOL_VERSION` **不抬**（先例：`records.mine`）。
抬版本的判据是「推送帧的**形状**变了、旧页面会读错」；这里变的是 **C2S**，而且老客户端一个字节都不发 —— 它的
`room.join` 与今天逐字节相同，服务器只在目标房间**声明了集合**时才会回它一句能照着改的 `MOD_CONSENT_REQUIRED`。
理由写在 `shared/protocol.js` 那一格，与提交信息里同一段。

**客户端那条链路。** 「拒绝 ⇒ 照 `detail` 问一次 ⇒ 带 `consent: true` 重发」三处入口（大厅按密钥加入、房间里从
观战入座、`?room=` 深链自动入座）**共用同一处**决定「重发什么」（`public/js/roomMods.js` 的
`consentRetryPayload`）；屏幕只负责**问**（`confirmDialog`）。为什么它必须是一处：三处各写一遍就是三个会漂的真相，
而漂的方向是某一处悄悄不带 `consent` 重发 —— 那等于把同意退化成一次自动重试。同一条 `room.join` 也是**已经坐在
里面的人重新表态**的通道（幂等分支会补上同意），所以他不必退出再进。

**测试**：`test/roomConsent.test.js`（未同意进不去 / 不能开始、同意后照常、两种漂移各点各的包、不声明集合的房间
`room.state` 不带 `mods` 且 join 只要 `{ code }`，以及**跑真 Net + 真 roomMods 打真服务器**的那条重发链路）；
`test/modIdentityWire.test.js` 与 `test/roomModSet.test.js` 的 `$optional` 断言按新形状**故意改写**，
`test/roomKeep.test.js` 与 `test/roomModSet.test.js` 里进「声明了集合的房」的夹具 join 显式带上 `consent: true`。
**不声明模组的房间逐字节等于今天**（那条没有第二个答案）。

---

### 28.54 `pack.json.matchKinds`：第二种对局的声明面（管理器不认玩法名）

**要解决的问题**：§28.14 的 `matchClass` 是**唯一**能碰到对局的挂载点，而它的检查只有「返回值是个函数」——
一个包装器原则上可以把 `Match` 换成任何行为完全不同的类。今天真要做这件事的包（另一种玩法，不是塔防的
一套数值）只能靠「这个包被装进了房间」这一句隐式信号来表达「这一局归我算」。隐式信号在两个方向上都是坏的：
装了包、但这一局不是我的玩法时，包装器仍然要跑；反过来，作者写了「我这包提供 3v3 足球」这句话，管理器里
**没有任何一格存得下它**，于是它既不进摘要、也不进编辑器、也没有人判它。这一格把那句话写成数据。

**这一格给什么**：`pack.json.matchKinds = [{ id, seats?: { min, max }, label? }]`。它是**声明与协商面**，
不是分派表 —— 管理器不认玩法名，判定住在包自己的模块里（`host.matchKinds()` 交出冻结的只读数据）。四条判据：

1. **必须有接收人**：合法的 `matchKinds` 要求本包至少有一个 `server.modules` 条目挂 `matchClass`
   （`MATCHKINDS_NEED_MATCH_CLASS`）。形状照 §28.23 的 `MODULES_CHANNELS_NEED_MATCH` —— 一句没有执行者的话
   点名拒，而不是让它哑着通过。`combat: true` **不在这里重复判**：有 `matchClass` 就必须认 `combat`，那是
   §28.14 已经拦住的一条线，再写一遍就是永远不会命中的死格子（这一点由测试钉住，见下）。
2. **只在写出来时才进归一化结果**（与 `variants` / `behaviour` / `callBudget` 逐字同一条纪律）：`identifyPack`
   哈希的就是这份归一化清单的 `canonicalJson`，所以给每个包都加一个 `matchKinds: []` 会把**所有已发布包的摘要**
   改掉。它又**必须**进摘要：这一格决定「这一局由谁算什么」，两份只差种类声明的包共用同一个摘要，房间摘要闸门
   就放行两种行为（§28.2）。
3. **种类 id 排序，不按书写顺序**：两份书写顺序不同的清单必须是同一份字节（与 `requires` / `registers` 同一条）。
   id 的字符集**与包通道共用**（`MATCH_KIND_ID_RE` = `PACK_CHANNEL_RE` 那一套 `^[a-z][a-z0-9_-]{0,63}$`）——
   两条通道说的是同一件事（作者起的、有界的名字），不该各定一套拼法。
   ⚠️ 这一条不是美化：排序决定的是摘要，**书写顺序能改摘要就是摘要闸门能被绕过**。
4. **有界**：每包最多 4 种（`MAX_PACK_MATCH_KINDS`），座位 1..12（`MATCH_KIND_SEATS_MAX` —— 比宿主最大房间还宽的
   「玩法」没人能组局），`label` ≤ 60 且是**作者可见**文本（编辑器/清单里的名字），因此**不占 i18n 词条**：
   它不经过 `t()`，不是玩家界面串（§28.15 那条「给作者读的规则说明不进语言包」的同一条口径）。

**包装器怎么用（这一节最需要写下来的部分，因为坑不在形状层）**：`MatchClass` 是**进程级一次**包装的
（`server/index.js` 在装载时把类换掉一次，之后所有房间都用同一份），所以包装器**不能**按房间换类 —— 只能在
子类的构造里判「这一局是不是我的」，命中就返回自己的实现，否则**必须原样把 Base 交回**。判得着的数据只有两样：

* `opts.mods.packs[].id`（房间自己的 mod 集合，由 `room.create.modIds` 经 `server/lobby.js` 的
  `resolveRoomModSet` 解析进来）；
* 开局之后的包通道投递（`handlePackMsg`，§28.23）—— 适合「同一批包里选具体哪一种 kind」。

**`opts.mods` 里读不到 `variants`**：房间自己声明集合时 `resolveRoomModSet` 重建条目只留
`{id,hash,layer,combat,api}`（§28.47 的那半边），所以把 kind 藏进口径轴是行不通的 —— 这也是本格不提供
「轴」而只提供「种类清单」的原因。

**这一格明确不给的东西**：不新增 `C2S` 意图、不动 `PROTOCOL_VERSION` / `MOD_API_VERSION`、不开新的消息类型。
玩法自己的输入走既有的 `pack.msg`（≤4096 B / 每会话 5 每秒 / burst 20 / ≤8 条通道，§28.23），下行复用
`m.public` 的自定义顶层键。结局仍要按既有形状产出：`m.result` + `onEnd(summary)`，且 `summary.players`
非空数组才写战绩，塔防专属读数缺失按 0 降级、不抛。客户端那半边今天能用的最大挂载面是 `client.panels` 的
**10** 个槽（`root.overlays` 是全屏层，§28.8）。

**判据与证据**：`test/modMatchKinds.test.js`（合法形状与排序稳定性、未声明时逐字节不变、`MATCHKINDS_*`
每条拒绝码逐条走、**以及「`combat` 这一格不该重复判」那条可执行的注记** —— 它断言的是
`MODULES_NEED_COMBAT` 先命中，而不是我自己的码命中）、`test/packBehaviour.test.js` 的 `PACK_FIELDS` 闭集计数
（**37 → 38**：那 38 是两条线各自加的一格 —— 我们的 `callBudget`（§28.52）与这一格 —— 相加而来，
**不是**「数字一样取一边」）、`test/modSurface.test.js` 的锚点。

**节号说明（我方口径）**：本节内容吸收自下游 fork，在那里编号是 §28.52；它与我方既有的 §28.52
（`callBudget`）撞号，所以按「我们是上游、编号以我方为准」排到我方现有最大号之后，定为 **§28.54**。
代码与文档里对它的引用一律按**能力**归一到 §28.54，不做机械的号段平移。

---

### 28.55 `client.screens`：整屏替换（路由闭枚举 = 引擎真的有的那四个）

**要解决的问题**：§28.8 的面板槽位是**插进引擎已经渲染的组件**里的十格，它换不掉那一屏本身。第三方界面包
（整套大厅 / 房间 / 对局界面）要落地，只有两条路：改本体拥有的 `public/js/screens/*.js`，或者由引擎提供一个
「这一屏由包出」的注册面。这一格选后者，并且**闭枚举只收引擎真的存在的路由**。

**为什么只有四条**：路由的真相在 `public/js/store.js` 的 `selectRoute` 与 `public/js/main.js` 的 `SCREENS`，
两处都只有 `title | lobby | room | game`。结算与干员调配是**路由内部**的视图（`selectRoute` 只看
`match.public.phase` 与 `room.inMatch`），不是路由。所以 `CLIENT_SCREEN_ROUTES` 与客户端的
`MOD_SCREEN_ROUTES` 都是这四条 —— 加一条 `result` 或 `loadout` 就是造一个永远不会命中的死声明，
正是本层到处在拒的那一类（两份名单必须同源，由 `test/modClientScreens.test.js` 钉住，与 §28.8 那两张表同一条纪律）。

**形状**：`client.screens[] = { id, route, module, order?, styles?, data?, messages? }`。字段与面板**共用判据**：
`module` 必须是包内相对 `.js`、`styles` 同一条装载期判据（`server/workshop.js panelModuleIssues` 现在同时收
panels 与 screens），`data` / `messages` 走同一批闭枚举；`id` 与面板**共用一个包内命名空间**
（`CLIENT_SCREEN_DUPLICATE_ID`），一条路由在一个包里只能有一份（`CLIENT_SCREEN_DUPLICATE_ROUTE`）。
服务端把两类声明合成同一份线表，屏条目落成 `{ kind: 'screen', route, slot: 'root.overlays' }` ——
`slot` 保留是为了让客户端只有一条分派路径，不是因为屏真的挂在那个容器上。

**身份**：`identifyPack` 把 `client.screens[].module` 与 `styles[]` 的源码字节算进摘要（与面板逐字同一条理由：
不算进去，两份不同的整屏就能共用同一个摘要，而那份摘要声称「同一份界面」）。没声明 `screens` 的包摘要
**逐字节不变** —— 归一化清单里只在写出来时才有这个键（`variants` / `behaviour` 同一条纪律）。

**运行时的失败方向**（`public/js/ui/extensions.js`）：装载在常规面板之后调和（`flush` 末尾一次
`syncActiveScreen`），宿主原生界面**在任何一步失败时都保持可见** —— 样式装不上、`import` 失败、模块没导出
`mountScreen`/`default`、`mountScreen` 抛错，四种都拉黑该 key 并点名，不做「白屏但看起来成功了」。卸载是对称的：
还原 `data-mod-screen-*` 的前值、逐订阅回收、只有当前活跃条目才撤基样式。路由所有权按
`order / pack / id` 确定性裁决，输的一方点名拒。

**移动端口径**：这一格**没有写死像素、也没有桌面视口假设**。路由是**语义名闭枚举**，本身不含任何尺寸；
全屏宿主用 `position: fixed` + `inset: 0`（四边贴合视口，不是固定宽高）与 `overflow: auto`，背景取
`var(--screen-background, …)` 让宿主主题说话；基样式只有一条 `display: none`，同样是布局无关的。
唯一一个魔数是 `zIndex`（它不是尺寸、也不假设桌面）。所以这一格在移动端可用，移植时不必改。

**来源分支里有一格是坏的（合并时抓到，记在这里免得再踩）**：`title` 路由的 `enter(rawName)` 那行，作者把控制码
写成了 **caret 记法的字面文本**（`^@-^_`），源码里没有真控制字符 ⇒ 字符类变成 U+005E 到 U+0040 的**反向区间**，
整个模块连 `node --check` 都过不去。合并时按显然的意图改成 `[\u0000-\u001f\u007f-\u009f]`（C0 控制码、DEL、
C1 控制码）。`#` 与零宽字符的合法性归**服务端**判 —— 前端不是鉴权边界。

⚠ **同一份来源文件里还有第二处 caret 记法没被修**：`isPanelId` 的字符类写成 `[\s^@-^_]`，那是一个**合法但语义错**
的正则（`@-^` 是反向区间）—— 它会拒掉所有含**大写字母或下划线**的面板 id。合并时**保留我方正确的
`[\s\u0000-\u001f]`**，不吸收那一处。

**这一格与 §28.54 的分工**：§28.54 管「这一局由谁算」（服务端对局的种类），这一格管「这一屏由谁画」。两者互不
依赖：换屏不换协议，换种类不开新消息类型。
**不需要 `golden:update`**：这一格完全不进模拟。

**判据与证据**：`test/modClientScreens.test.js`（路由闭枚举、两份名单同源、每条拒绝码逐条走、
以及「没声明 `screens` 的包归一化结果里不长这个键」）、`test/modClientPanels.test.js`（面板那半未受影响）、
`test/modSurface.test.js` 的锚点。

**节号说明（我方口径）**：本节内容吸收自下游 fork，在那里编号是 §28.53；按「我们是上游、编号以我方为准」
排到我方现有最大号之后，定为 **§28.55**。代码与文档里对它的引用一律按**能力**归一到 §28.55，
不做机械的号段平移。

---

### 28.56 `server.modules[].lane`：包自带一条 WebSocket 通道（宿主开、按声明开、替它记账）

**要解决的问题**：§28.44 把升级路径做成了一张表，但那张表**只有宿主进程自己**能登记 —— 文件头逐字写着
「这一格不是给内容包开端口或跑自己的服务器的通道」。于是一个自带玩法的包（另一种对局、另一种协议、自己的
房间语义）今天只有两条路：把权威塞进宿主的 `Match`（§28.54 那条），或者在宿主之外再跑一个进程（那就是运维
多一个进程、多一套 TLS/域名/准入，不是 mod）。这一格开第三条：**包声明一条路径，宿主替它开**。

**结构性保证一个字没改**：包仍然拿不到监听套接字、新端口、定时器或子进程。改的是「谁能登记一条 lane」和
「登记要走什么判据」。lane 的 `onUpgrade(req, socket, head, ctx)` 签名与 §28.44 那张表的行**逐字相同**（外加
`ctx.lane` 这条行自己的 `{ id, path, summary }`），所以宿主那一侧的准入、背压、心跳透传、消息顺序、按名字
记日志的口径全都沿用现成的，没有第二条实现。

**为什么必须「活表 + 惰性查处理器」**：`server/index.js` 在 `:188` 装载服务端模块、在 `:432` 才把
`opts.wsLanes` 交给 `attachWebSocket`，而模块源码是异步 import 的。所以两步分开：

* **路径按声明同步认领**（`server/modLanes.js claimPackLane`，在 import 之前）—— 保证快照那一刻路径一定在表里；
* **处理器 import 完成后挂上**（`host.lane(fn)` → `attachPackLaneHandler`）。

两条各自的失败方向都是响的：没挂上就升级 ⇒ `ctx.reject(503, 'pack lane not ready')` 并按名字记一条 warn；
认领失败（坏语法 / 抢 `/ws` / 与别的模块撞同一条路径 / 一个模块认领两条 / 表满）⇒ **整包在装载期被拒并点名**，
照 §28.44 那句「一条安静地从不应答的 lane 比没有 boot 更糟」。

**判据只有一份**：路径语法与保留名不在这个包里再抄一遍 —— `claimPackLane` 直接调 `server/http/wsLanes.js` 的
`isLanePath` / `LANE_RESERVED` / `MAX_WS_LANES`。形状层（`shared/workshop.js`）只管另一件事：**命名空间**。
路径必须落在 `/mod-ws/<本包id>` 或其子路径（`MODULES_LANE_BAD_NAMESPACE`）。这一条只需要包 id，不需要语法，
所以两处判据不重叠、也不互相抄。限额（每进程 lane 总数、每模块一条）是宿主的表预算，**不许**作者声明 ——
所以 `lane` 的闭字段只有 `{ path, summary? }`。

**形状层的四条互拒**：`lane` 而无 `uses:['lane']` ⇒ `MODULES_LANE_UNDECLARED`；挂了 `lane` 而无路径 ⇒
`MODULES_LANE_NEEDS_PATH`；路径不是字符串 / 空白 summary / 未知字段 ⇒ `MODULES_LANE_BAD_PATH` /
`MODULES_LANE_BAD_SUMMARY` / `MODULES_BAD_LANE`。`lane` 与 `summary` **只在声明时**才进归一化清单 ⇒ 没用它
的包摘要逐字节不变；用了就进摘要（同一份房间摘要必须对应同一份会被连上的路径，§28.2 同一条）。

**闭枚举的性质（这一格与 §28.54 / §28.55 不是同一种加法）**：它是**往允许集合里增成员** ——
`SERVER_MODULE_USES` **6 → 7**（末尾 + `lane`）、`SERVER_MODULE_FIELDS` **5 → 6**（+ `lane`），另新引入一个只属于
它的字段闭枚举 `MODULE_LANE_FIELDS = ['path','summary']`。对**在册老包零影响**：不写 `lane` ⇒ 既不触碰那个新
枚举、也不进归一化清单。`MOD_API_VERSION` **不动**（加一格不抬世代，抬了只会把写了 `api: "1.x"` 的老包判成
`MOD_API_INCOMPATIBLE`）。

**判据（闭枚举扩张必须带的那一条）**：**不声明 `lane` 的老包，`normalizePackManifest` 的输出与改动前
`deepEqual`** —— `test/modPackLane.test.js` 把整条 `server.modules[]` 条目钉成完整期望值，
另断言 `SERVER_MODULE_USES` 的**逐字**取值（末尾就是 `lane`）。

**入口**：`server/modServer.js` 把 `packLaneTable()` 交给 `startServer({ wsLanes })`。它存在的全部理由就是
**不改 `server/index.js`** —— 那是游戏本体拥有的路径，而 `index.js` 已经有 `opts.wsLanes` 这个现成入口，
能不改就不改（本体路径的判据是「越线必须留证据，不是『不许』」）。不认 lane 的部署照旧 `node server/index.js`，
行为与字节都不变；要换入口只改启动命令（`docs/DEPLOY-SERVER.md`），启动时多打一行 `[mod-lane] ...` 让运维能确认
这个进程到底开了哪几条包通道，而不是靠猜。

**同一入口还带进了热装载 —— 它只交付「安全的那一半」**：`server/modServer.js` 的第二个能力是工坊目录的
变更监听 + 精确 diff + 可选受监督重启（`server/modHotReload.js`）。**这一格不承诺「原地换包」**：本引擎的装配
是一次性的（`startServer()` 在 `listen` 之前把工坊、钩子、服务端模块、战斗、房间、数据叠加层全部烘进对象里），
真正原地换包要先把那段装配抽成可重入的 `applyWorkshop()` —— 那是另一件事，写在 `server/modHotReload.js` 的文件头
里免得后人误读。所以缺省 `SP_HOT_RELOAD` 未设 ⇒ `report`（**只报告、不动服务**），要生效用 `restart` 交给外部
supervisor 拉起；**缺省路径的行为与字节零变化**，且任何异常一律只记日志（一个坏包绝不能让服务器变成起不来）。

**这一格与 §28.54 / §28.55 的分工**：§28.54 换「这一局由谁算」，§28.55 换「这一屏由谁画」，这一格给「这一种
玩法自己怎么说话」。三者互不依赖，也都**不新增 `C2S` 意图、不动 `PROTOCOL_VERSION` / `MOD_API_VERSION`**。
**不需要 `golden:update`**：不进模拟。

**移动端 / 移植口径**：这一格是**纯服务端协议面** —— 它不渲染任何界面，因此**没有像素、没有视口假设**，
也不引入平台特有依赖（`server/modLanes.js` 只 import 宿主自己的 `server/http/wsLanes.js`）。客户端要连这条
通道，用的是同一个 `WebSocket` 构造与同一条已声明的路径，移动端与桌面端走的是同一段代码。

**判据与证据**：`test/modPackLane.test.js`（闭枚举逐字取值、形状层每条拒绝码逐条走、以及「纯的那半」——
认领 / 撞车 / 限额 / 处理器还没就位时 503 / 处理器就位后转发并多带 `ctx.lane`）、
`test/mod-hot-reload.test.js`（防抖合并、精确 diff、坏包不炸、`restart` 只在 `mode=restart` 时调用）、
`test/wsLanes.test.js`（§28.44 那份语法判据没被改）、`test/modSurface.test.js` 的锚点。

**⚠️ 来源分支的四处错标（合并时抓到，记在这里免得再踩）**：成员树的 `shared/workshop.js` 有**四处**把 lane 的
设计稿节号写成 **§28.53**（那是 `client.screens` 的号）—— 分别是 `MODULE_LANE_FIELDS` 的文档注释、形状层
`lane` 那一段、归一化清单那一段、以及命名空间闸门那一段。合并时**按能力归一到 §28.56**，不做机械的号段平移
（机械 +2 会得到 §28.55，那是 client.screens 的号 —— 正好错位）。同一次合并里还抓到 `public/js/ui/extensions.js`
的 `isPanelId` 也把控制码写成 caret 记法（见 §28.55 末尾那条），**未吸收**。

**节号说明（我方口径）**：本节内容吸收自下游 fork，在那里编号是 §28.54；按「我们是上游、编号以我方为准」
排到我方现有最大号之后，定为 **§28.56**。代码与文档里对它的引用一律按**能力**归一到 §28.56。

---

### 28.57 `server.room.hold`：空席房间的回收裁决（谁同意把这一局留着）

**要解决的问题**：§28.20 那一层的契约是**观察与声明**，它改不了对局 —— 这一条到今天仍然成立。但它旁边有一件
事确实不在这一层里，而在大厅里：真人全部退出、而对局还在跑（等重连、或等「志愿者冻结」里那些还没回来的队友）时，
宿主默认直接把房间销毁 —— `server/lobby.js` 的两处 `if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty')`。
一个自带玩法的包（§28.54 那种）要「人走空了但这一局不作废」，就必须能参与**这一个**决定。这一格只开这一个决定权，
别的什么都没开。

**默认路径与从前逐字相同**：没有任何包登记 ⇒ `holdDecision()` 返回 `{ hold: false, until: 0 }` ⇒ `reapEmptyRoom`
落回原来那一行 `disposeRoom(room, 'empty')`。一个包都没声明 `server.room` 时，进程里连一张表都不建（与 §28.16
「干净安装与从前逐字节相同」同一条不变量）。

**申请必须显式**：只有 `pack.json.server.room.hold = true` 的包能调 `room.canHold(fn)`；没声明就调 ⇒
`ROOM_HOLD_UNDECLARED` 点名（**不是**静默收下 —— 静默收下就是「写了等于没写」那一类）。`hold` **只在写出来时**
才进归一化清单，所以没用它的那些包摘要逐字节不变；写出来就进摘要（同一份房间摘要必须对应同一份回收语义，§28.2 同一条）。

**能力判据 ⇒ 这一格要 `combat: true`**：§28.20 明说房间钩子不是 combat 闸门，因为它的契约里没有任何一条能改对局。
`hold` 破的就是那条前提 —— 它能决定一局会不会因为「没真人了」而被回收掉，那是对局结果的一部分。所以按 §28.14 /
§28.54 同一条纪律要求包声明 `combat: true`（`ROOM_HOLD_NEEDS_COMBAT`，闸门在 `normalizePackManifest`，因为它要读
包级声明）。判据仍然是**能力**而不是意图：`isOverridableContentFile` 那套「谁能改数值谁进摘要」的口径在这里换成
「谁能决定回收谁进 combat 闸门」。

**包决定「留不留」，宿主决定「留多久」**：`ROOM_HOLD_MAX_MS = 15 分钟` 是宿主侧的硬时限（**具名常量，不是魔法数** ——
它是一条对外承诺的上界，散在代码里就没人能改对），谓词返回的 `until` 越界一律夹回来
（`Math.min(until, now() + ROOM_HOLD_MAX_MS)`，也夹不早于当前时刻）。多包语义是 **OR**（谁申请留就留），时限取**最早**
的那一票 —— 最早到点就该重新判一次，而不是让一个包把房间锁满 15 分钟。到点重新判时若已空 ⇒ 销毁，若有人回来了 ⇒
什么都不做（加入路径本来就会广播状态）。

**失败方向全是响的**：谓词抛异常 ⇒ 这一票作废并 `ROOM_HOOK_THREW` 点名（别的包照算，与 §28.20 逐钩子 try/catch
同一个口径）；谓词返回 `{hold:true}` 以外的一切 ⇒ 视为不留。裁决表按**房间码**存，`disposeRoom` 里 `releaseRoomHolds(code)`
与定时器一起收回 —— 房间码会被复用，留着条目就是让下一个同码房间继承上一个的裁决（§28.20 对钩子表逐字相同的理由）。
定时器 `unref()`：一个等重连的房间不该把进程吊住（与 `startGrace` 同一个口径）。

**为什么这里动 `server/lobby.js`**：回收那句话住在大厅，没有别的挂载点 —— `server.modules` 的 `boot` 拿不到房间
生命周期，而 `server.room` 的观察面按契约不能改对局。改法是最小替换：两处 `disposeRoom(room,'empty')` ⇒
`reapEmptyRoom(room)`，后者在没人申请时**就是**原来那一行；`disposeRoom` 只多了「清定时器 + 收表」。
⚠ **这一格是本批唯一动到房间生命周期的地方**，所以它的验收**必须真起一次服务器**，并与房间相关的既有测试一起跑
（`test/roomModSet.test.js` / `test/roomKeep.test.js` / `test/lobby*.test.js` / `test/roomModIndependence.test.js`），
确认它与房间 mod 集合 / 同意路径（`ERR.MOD_SET_LOCKED` / `MOD_CONSENT_REQUIRED`）**共存** —— 这两条判据都住在
房间生命周期上，而这一格正好在同一个生命周期点上插了一次裁决。

**不新增 `C2S`、不动协议号、不进模拟** ⇒ 不需要 `golden:update`；房间对客户端的形状一字未动（留置期间对成员来说，
它还是那个等着重连的房间）。判据在 `test/modRoomHold.test.js`（形状层 4 条 + 聚合语义 5 条，含「不声明 `hold` 的包
归一化结果**逐字节不变**」）与 `test/modSurface.test.js` 的锚点。

**节号说明（我方口径）**：本节内容吸收自下游 fork，在那里编号是 §28.55；按「我们是上游、编号以我方为准」
排到我方现有最大号之后，定为 **§28.57**。代码与文档里对它的引用一律按**能力**归一到 §28.57。

⚠ **来源分支那一格的两段引用没有带进来**：成员把这一格登记在 `.github/overlay.json` 的 `bodyPaths` 里，由
`.github/game-overlap-check.mjs` 逐条核对。那两个文件是**他们那条分支**的受控例外机制，我方树里没有 ——
带进来就是指向不存在文件的悬空引用。我方这一格的判据落在 `test/modRoomHold.test.js` 与
`test/roomModSet.test.js` / `test/roomKeep.test.js` 那一组房间测试上。
