# DESIGN §29 — The match meta payload: a pack's server-side match logic

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

This section is the **second B-layer payload class**. §28 defines B as *hooks and kits*: `kits/<chessId>.js` gives one
operator a battle kit. A kit cannot touch the **match**: it never fires on `onRoundStart`, it cannot add bond layers, it
cannot react to a shop refresh. A real community mod's whole "personality" lives in exactly that space — its
`bonds/custom.js` (331 lines) and `garrisons/custom.js` (336 lines) register 19 hooks' worth of conditional effects
("damage enemies that are stunned", "at 6 distinct members give the whole team attack speed", "on every N kills add a
layer") through `registry.bond(id, handler)` / `registerMeta(registry)`. None of that can be expressed in data, and
§28.11's list of what is deliberately left out did not include it — it was simply not designed yet. This is that
design, and both cuts are implemented (§29.4 lists every piece and the two places where the shipped behaviour is
deliberately softer than this section's first draft).

## 29. The declaration, and the three decisions it carries

```jsonc
"combat": true,                                  // required — see decision 2
"server": {
  "meta": {
    "module": "meta/bonds.mjs",                  // pack-relative, must be .mjs (the server loads it, the browser never does)
    "registers": ["bond:kazdelShip", "bond:rhodesShip", "garrison:custom_*"]
  }
}
```

The module contract is **the same shape official content uses** (`server/sim/content/bonds.js` and friends):

```js
export function registerMeta(registry) {
  registry.bond('kazdelShip', { onRoundStart(ctx, ev) { /* … */ } });
}
```

Same shape on purpose: the engine already has one way to say "here are my match handlers"
(`registerAllMeta(registry)` walks the content modules), and inventing a second one would create the second truth this
repository keeps refusing. `registerMeta(registry)` is called **once per match**, on a registry that belongs to that
match only (decision 3).

### 29.1 Decision 1 — `registers` is a whitelist, not documentation

`MetaRegistry.register` replaces any earlier handler for the same key: **the last writer wins**. Official content is
registered first (§28.13's ordering rule does not reach here — `createRegistry` runs `registerBuiltins` then
`registerAllMeta`), so a pack that registers `bond:yanShip` would silently replace the engine's own handler for an
official bond. That is the same class of failure this whole design keeps naming — the pack "works", the official bond
stops working, and nothing says so.

So the declaration lists **every key the pack may register**, and the runtime hands the module a **guarded registry**:
registering a key that is not on the list throws, and the assembly failure refuses **that pack for that match**
(§29.4). Two shapes are allowed per entry:

| entry | matches |
|---|---|
| `bond:kazdelShip` | exactly that key |
| `garrison:custom_*` | one **trailing** `*` = prefix match (the 13 `custom_*` garrison effect keys a real mod adds) |

A `*` anywhere else is refused (`META_BAD_KEY`), and so is a character the registry's own `KEY_RE`
(`^(garrison|band|bond|item|choice|effect|global):[A-Za-z0-9_\-.:#]+$`) would not accept — the shape layer must not
pass something the runtime is going to throw on. Two readers, one judgement: `META_KEY_CLASSES` in
`shared/workshop.js` is pinned against `MetaRegistry`'s seven key methods by reflection in `test/packMeta.test.js`, so
adding a key class in the engine without teaching the shape layer fails a test instead of producing a key no author can
write.

### 29.2 Decision 2 — `server.meta` requires `combat: true`, and it is a hard gate

The owner's ruling (2026-10-10) is that injected server logic must not be a *source* of result differences unless it
declares `combat: true` — at which point it enters the room digest gate, the "everyone runs the same set" requirement
and the golden corpus. A meta handler **is** match logic: it changes what happens on a round. So a pack that declares
`server.meta` and not `combat: true` is refused **whole** (`META_NEEDS_COMBAT`), in the shape layer, next to the
existing type check for `combat`.

Why hard rather than a warning: with a warning, "a pack that does not declare `combat` cannot change a match result"
degrades from a structural guarantee into a promise, and §28.13.1's fourth decision (the frozen eight-key hook surface)
was written precisely to keep it structural. A pack that cannot state that its logic changes results must not ship
server-side match logic.

### 29.3 Decision 3 — the registry is forked per match; there is no global set/restore

`getDefaultRegistry()` is **process-wide**, and `Match` already accepts `opts.registry`
(`server/match/Match.js:252`). A pack must not write into the process-wide registry: two matches running at once would
both see the union of every room's handlers, and the ordering would depend on which room started first. That is the
"set a global before the match and restore it after" shape the owner forbade by name, and it is wrong even
single-threaded (an interrupted match never restores).

So `MetaRegistry.fork()` (`server/match/effectsMeta.js`) copies the registry and the pack's handlers are registered
into the copy only. Handler **objects** are shared by the copy; a handler that needs room-specific state closes over it
instead of mutating the shared object. When no pack declares `server.meta`, no fork is made and `Match` behaves byte for
byte as before — the same "declared, or nothing changed" rule §28.13 uses for the other four capability groups.

### 29.4 What is implemented now

Both cuts are in. **A 段** (`feat/012-meta-payload`) is the declaration; **B 段** is the runtime assembly.

| piece | where |
|---|---|
| `server.meta` shape, refusals, `registers` normalisation (sorted) | `shared/workshop.js parseMetaDecl` / `metaKeyIssue` |
| `META_NEEDS_COMBAT` | `shared/workshop.js normalizePackManifest` |
| `server` accepts two members; `server: {}` is refused (`SERVER_EMPTY_MEMBER`) | `shared/workshop.js parseServerDecl` |
| contribution semantics: a pack that declares only `server.meta` is a legal pack | `shared/workshop.js` (`EMPTY_PACK` list) |
| load-time file judgement (module present, readable, `.mjs`, inside the pack) | `server/workshop.js metaIssues`, wired into `loadWorkshop`'s gate |
| the module's **bytes** enter the content hash | `server/workshop.js identifyPack` |
| `MetaRegistry.fork()` | `server/match/effectsMeta.js` |
| the static determinism scan, **before any import** | `server/match/metaPack.js metaSourceIssues` (shares `shared/kitAuthoring.js`'s `stripComments` / `mentionsIdentifier` with the kit rules) |
| `loadMetaModules`: import (URL carries the pack hash), require `registerMeta`, refuse a module that fails either | `server/match/metaPack.js`, called from `server/index.js` and merged into the **same prune point** as `server.preDispatch` (`dropUnavailablePreDispatchPacks`) |
| the guarded registry: a declared-only whitelist, read-through reads, `unregister` limited to its own keys, and the frozen `registry.api` | `server/match/metaPack.js GuardedMetaRegistry` |
| per-pack **trial copy**: a pack that throws part-way is rolled back whole — including the entries it left in the room's ownership map | `server/match/metaPack.js buildRoomRegistry` |
| two packs claiming one key: the smaller pack id holds it, the loser is named (`META_KEY_TAKEN`) | the same function (DESIGN §28.3's rule, applied to the registry) |
| the per-room registry reaching the match | `server/lobby.js startMatch` → `Match`'s existing `opts.registry`; **absent when no pack declares `server.meta`**, so a clean install forks nothing |
| acceptance | `test/packMetaWiring.test.js` (real server + real `Match`: the handler dispatches, the process-wide registry gains no key, an unloadable pack leaves the loaded set) and `test/packMetaFanpack.test.js` (the community mod's prep half ported verbatim — milestone step, once-per-step counter, grant, toast — driven through a real match) |

**Two deliberate softenings against this section's original wording**, both recorded here rather than in a comment:

- The room's declared set (`Room.modSet`, W-A) does **not** yet decide which meta packs run: every loaded `server.meta`
  pack is assembled into every room, exactly like the content layer, until W-B makes the room's set the one the
  simulation runs. Half-applying it (meta honours the set, content does not) would make "declared set" mean two
  different things on two layers.
- An **assembly-time** failure (a key outside `registers`) rolls that pack back and names it, but the match **still
  starts**. The stricter reading ("that pack's match does not start") was written before the rollback existed: it would
  let one pack make a whole room unplayable for everyone in it. Load-time failures still drop the pack entirely, which
  is where the strict reading belongs.
