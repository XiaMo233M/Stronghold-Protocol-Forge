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
| **B** server logic | hooks and kits: the code of `workshop/<pack>/kits/<chessId>.js` (`server/workshop.js:350` `loadWorkshopKits`) | **the server only** — this is new | only through the hooks it registers, and only after a declared intent passes deterministic verification |
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

**What participates in the hash.** Not "the directory": a manifest of `(relative path, byte length, sha256)` pairs,
sorted by path, over exactly the bytes the loader reads and the browser will be served:

1. `pack.json` — hashed **after** `normalizePackManifest` (`shared/workshop.js:303`), so the hash covers the pack's
   effective declaration (normalized `overrides`, `content`, icon tables, `art`, `support`, `voices`), not its
   whitespace. Two spellings of the same pack then hash the same, and a declaration the loader silently dropped
   (`shared/workshop.js:315-317` filters a malformed `overrides` entry in silence today) cannot hide behind the hash.
2. every declared content file, after `normalizeContentFile` — the same normalized records the loader merges.
3. every `kits/*.js` **source text, byte for byte** (the module the server imports and the browser fetches by URL,
   `server/workshop.js:309`, `public/js/battle/runner.js:136`).
4. every file under `<pack>/assets/**` — the media the `/workshop-assets` route serves
   (`server/http/workshop.js:112-142`).

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
* **A declared path wins over a core file at the same path, on purpose** — the path is part of the pack's identity and
  an author who declares `/data/resource-manifest.json` means it. The load-bearing half of that decision is the
  converse: a declared route whose file is missing answers **404** instead of silently falling through to the
  same-named core file (that is why the route stays in the map, with a warning naming the missing file).
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
  declares it" is the owner's ruling. `boot` / `shutdown` / `healthz` cannot, and do not need it. The layer derivation
  counts such a pack as **B**, while `combat`'s *derived* value still looks only at `kits/`.

**Where it is enforced.** The declaration is `shared/workshop.js parseServerModulesDecl` (shape, closed enums, caps:
8 modules per pack, ids unique, `entry` a pack-relative `.mjs`); the file's presence is judged in the load gate
(`server/workshop.js serverModuleIssues`); the import, the `registerServer(host)` export and the mount points themselves
are judged on the startup path (`server/modModules.js`), and a module that fails **takes its whole pack out of the loaded
set** — the same prune point `server.preDispatch` and `server.meta` use. Module bytes enter the content hash, exactly
like `kits/`, panel modules and meta modules.

**Two deliberate asymmetries, recorded rather than implied:**

- **Server modules are process-wide, not per-room.** `boot` / `shutdown` are process events by nature, and so is
  `/healthz`. `matchClass` wraps the class the *Lobby* hands to every match. So unlike `server.meta`, a room's declared
  set does not select them — a server-module pack is a property of the installation, which is what the three real
  modules are.
- **No network hook, and no arbitrary mount points.** The ruling's third requirement (declarative lifecycle mounts)
  is met with four named places; anything else a server-side mod wants today still has to be an engine feature. That is
  a deliberate limit of the first cut, not an oversight: four mounts were what the three files actually needed.

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
