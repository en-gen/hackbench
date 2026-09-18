# Sprite rendering + movement architecture

## Core pattern

A `Sprite` is `id + (x, y) + Appearance + Behavior`:

- **Appearance** owns **what the sprite looks like**. Pixel rendering
  (`render(ctx, target, x, y, behavior)`) lives here, as does the
  optional annotation hook
  (`renderOverlay?(ctx, x, y, isActive, getL1, cols, rows, behavior)`).
  Appearances are free to compose whatever drawing makes sense for their
  sprite; there is no one-size-fits-all annotation schema.
- **Behavior** owns **how the sprite moves**.
  It never draws. It exposes *typed methods* an Appearance may call
  (`computePatrolRange`, `simulateBounds`, `computeBouncePath`,
  `computeFadeCorridor`, `computeSineBounds`, etc.). The behavior is the
  single source of truth for any ASM-derived physics.

  **No Appearance calls any of them today.** Those eleven methods had
  their only non-behavior callers inside the removed sprite overlays, so
  they are now reached only from their own tests. Doc comments across
  `behaviors/` still describe "the overlay" as their live consumer; read
  those as "the consumer this was built for, currently absent". The
  methods and their tests are deliberately untouched - they are issue
  #321's scope, not this layer's. Inventory in
  `docs/sprite-overlay-removal.md`.

The renderer is still dumb: `SmwMap` walks the sprite list and calls
`sprite.render()` / `sprite.renderOverlay()`. No per-sprite-id switches
in the map, factory, or webview.

## When to add a new sprite family

1. Read the handler in the SMW disassembly (`C:\Projects\SMWDisX`).
   Branch-by-branch, take notes of every speed table, timer, bit, and
   collision call.
2. Write a test file in `test/suite/unit/` that enumerates every ASM
   branch as a test case, with a `// ASM: bank_NN.asm:LINE — label`
   comment for each. Use the `buildSolidity` fixture for synthetic L1
   grids (string-grid → `{solidH, solidV, cols, rows, getL1}`).
3. Add a concrete class in `sprites/behaviors/` extending
   `MovementBehavior`. Subclasses have exactly one job: port the ASM.
   Share `simulate.ts` primitives (`signed8`, `applyGravity`,
   `simulateUntilStable`) and solidity callbacks from
   `MovementBehavior.ts`.
4. If the sprite needs a new visual (new animation frame dispatch,
   a new identity annotation), either add a branch to an existing
   Appearance or write a new `Appearance` subclass.
5. Register the sprite id in `behaviors/BehaviorFactory.ts`'s
   `buildMovementBehavior` dispatch and in `SpriteFactory` /
   `rehydrate` for the Appearance.

## Sprite annotations

`renderOverlay` is the Canvas2D annotation hook on `SpriteAppearance`.
It has **no implementations on `develop` today**: every path, movement,
trajectory, patrol, orbit and detection-zone annotation was removed,
along with the shared `overlays/primitives.ts` drawing vocabulary they
used. See `docs/sprite-overlay-removal.md` for the inventory and the
restore procedure.

The hook is kept deliberately. It is the extension point for **identity
annotations**: drawings that tell the user what a sprite IS when its
static appearance does not say so. Do not delete it as dead code.

The distinction that decides whether a new annotation belongs here:

- **Motion annotations** depict movement the editor cannot really
  simulate (patrol corridors, jump arcs, orbit circles, fall paths).
  These were removed and should not come back through the side door.
- **Identity annotations** disambiguate an ambiguous resting pose.
  These are wanted.

## L1 collision semantics

An annotation consumes `getL1(col, row)`, which returns either `null` or
`{id, actsLike, isPriority, collision}`. `SmwMap.renderSpriteOverlays`
filters the closure (locked by
`test/suite/unit/model/SmwMapSpriteOverlays.test.ts`):

- Priority-1 decorative tiles (all four subtiles `priority=true`)
  return `null` — foreground grass, backdrop tubes, forest columns are
  passable. See `isPriorityDecorative` in `OverlayContext.ts`.
- Wall / floor solidity is `actsLike & 0xFF` in `$11..$6D`
  (`isActsLikeHorizSolid`). Vertical adds the tileset-gated
  `$C4..$C9` window for "solid from above" tiles
  (`isActsLikeVertSolid`).

The behaviors call `solidityFromL1(getL1)` to unpack those rules into
`solidH(c, r) / solidV(c, r)` booleans. Don't reimplement this in each
behavior.

## Current Behaviors

| Class                          | Sprites              | ASM source                                |
| ------------------------------ | -------------------- | ----------------------------------------- |
| `HopFlameBehavior`             | $1D                  | `HoppingFlame` bank_01.asm:2187           |
| `KoopaWalkBehavior`            | $04/$05/$06/$07/$0C, future $0F/$11/$13 | `Spr0to13Main` bank_01.asm:1659 |
| `BouncingKoopaBehavior`        | $09                  | `GreenParaKoopa` branch bank_01.asm:1848  |
| `FlyingLeftKoopaBehavior`      | $08                  | `GreenParaKoopa` branch bank_01.asm:1835  |
| `SinusoidalParaKoopaBehavior`  | $0A, $0B             | `RedVertParaKoopa` bank_01.asm:1881       |

All behaviors share `simulate.ts` skeleton (`simulateUntilStable`,
`applyGravity`, `signed8`) + the `solidH`/`solidV` callback contract.

## Factory pattern

`SpriteFactory` (extension host) and `rehydrate.buildBehavior` (webview)
both delegate to the single `buildMovementBehavior(id, meta)` dispatch
in `behaviors/BehaviorFactory.ts`. This gives:

- **One source of truth** for "which behavior does sprite X use?".
- **No prototype-reattach** — classes are constructed fresh on each
  side; `instanceof` checks work identically.
- **Editor-ready** — when users reassign a sprite's behavior at runtime,
  this registry becomes the UI-facing name→class map.

Adding a new Behavior class means registering an id in that one file.
Don't duplicate the dispatch in both SpriteFactory and rehydrate.

## What NOT to put in a Behavior

- Canvas2D calls. Behaviors never draw.
- Sprite-specific visual data (part offsets, palette rows, char nums).
  That's the Appearance's job.
- Randomness. Simulators run in worst-case mode by default so results
  are deterministic; if a sprite has per-instance randomness, expose it
  as a config on the Behavior and pick the worst case at the call site.

## What NOT to put in an Appearance

- Collision logic. Call the Behavior. If the collision is "trivially
  inline" (a single one-line check), consider whether it belongs on the
  Behavior anyway — consistency beats convenience.
- ASM magic numbers. They belong in Behaviors next to the port. An
  Appearance shouldn't know about `$B0` or `DATA_018CBA`.

## Test conventions

- One `*.test.ts` per Behavior.
- Top-of-file comment sketches the "test tree" — what branches and
  values each describe block covers.
- Each `it(...)` names the ASM branch it locks.
- Use `buildSolidity` for synthetic L1 grids. Never load a ROM byte in
  a test.
- Never hardcode an amplitude/range that the simulator would produce;
  let the simulator run and let the test assert a reasonable range.
