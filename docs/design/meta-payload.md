# DESIGN §29 — The match meta payload: a pack's server-side match logic

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

This section is the **second B-layer payload class**. §28 defines B as *hooks and kits*: `kits/<chessId>.js` gives one
operator a battle kit. A kit cannot touch the **match**: it never fires on `onRoundStart`, it cannot add bond layers, it
cannot react to a shop refresh. A real community mod's whole "personality" lives in exactly that space — its
`bonds/custom.js` (331 lines) and `garrisons/custom.js` (336 lines) register 19 hooks' worth of conditional effects
("damage enemies that are stunned", "at 6 distinct members give the whole team attack speed", "on every N kills add a
layer") through `registry.bond(id, handler)` / `registerMeta(registry)`. None of that can be expressed in data, and
§28.11's list of what is deliberately left out did not include it — it was simply not designed yet. This is that
design, and its A 段 (the declaration) is implemented; the B 段 (the runtime assembly) is named at the end.

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

### 29.4 What is implemented now, and what B 段 adds

**A 段 (this cut, `feat/012-meta-payload`)** — declaration only, nothing executes it:

| piece | where |
|---|---|
| `server.meta` shape, refusals, `registers` normalisation (sorted) | `shared/workshop.js parseMetaDecl` / `metaKeyIssue` |
| `META_NEEDS_COMBAT` | `shared/workshop.js normalizePackManifest` |
| `server` accepts two members; `server: {}` is refused (`SERVER_EMPTY_MEMBER`) | `shared/workshop.js parseServerDecl` |
| contribution semantics: a pack that declares only `server.meta` is a legal pack | `shared/workshop.js` (`EMPTY_PACK` list) |
| load-time file judgement (module present, readable, `.mjs`, inside the pack) | `server/workshop.js metaIssues`, wired into `loadWorkshop`'s gate |
| the module's **bytes** enter the content hash | `server/workshop.js identifyPack` |
| `MetaRegistry.fork()` | `server/match/effectsMeta.js` |

**B 段** (next cut) adds the things only an import can answer, on the startup assembly path, exactly as §28.13.3's
last box does for `server.preDispatch`:

- `server/match/metaPack.js`: `loadPackMeta(loaded)` imports each declared module and keeps
  `registerMeta(registry)`; a module that fails to import, exports no `registerMeta`, or registers an **undeclared
  key** (the guarded registry) refuses **that pack for the match**, named;
- `Lobby` builds the per-room registry from the room's declared set (W-A's `Room.modSet`) and passes it to
  `MatchClass` through the existing `opts.registry`;
- a **static determinism scan** of the module source, with the same rules and refusal wording as `kitAuthoring`
  (§28.4): no `Math.random`, no clocks, no dependency on unordered iteration. A meta module runs inside a match, so it
  is bound by the same rules as the engine it plugs into;
- the acceptance case is the real thing: port the community mod's `bonds/custom.js` (331 lines) into
  `meta/bonds.mjs` and assert that "6 distinct members → team attack speed" actually fires, that a room that does not
  declare the pack plays byte-identically to 0.12.0-minus-this-cut, and that a `registers` list missing one key refuses
  the match by name.
