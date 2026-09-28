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
  It never draws. When a sprite family needs ASM-derived physics, that
  physics lives on a typed method an Appearance calls - the behavior is
  the single source of truth for it, never the Appearance.

  `sprites/behaviors/` does not hold a movement simulator today: eleven
  dead `MovementBehavior` subclasses (a physics port with no Appearance
  caller, reached only from their own tests) were deleted in issue #409.
  See `docs/sprites/sprite-overlay-removal.md`'s update section for the
  full inventory and what survived.

The renderer is still dumb: `SmwMap` walks the sprite list and calls
`sprite.render()` / `sprite.renderOverlay()`. No per-sprite-id switches
in the map, factory, or webview.

### The third pass: `renderAboveL1`

`SpriteAppearance.renderAboveL1?(target, x, y, behavior, mapStore)` is an
optional SECOND pixel pass. `SmwMap.render` runs it after the layer-1
priority tiles and before layer 3, so what it draws cannot be buried by
terrain. It is a `RenderTarget` pass, not a Canvas2D one, so it can blit
real tile pixels.

It is the seam for **editor annotations**: extra artwork whose job is to
tell the user what a sprite IS when its authored pose does not. $4D Monty
Mole rests as a pile of rubble, so the editor ghosts its emerged pose
above the mound.

It is **not** a fix for buried sprites. That was the original stated
motivation and it is false: 176 `$4D`/`$4E` instances across four ROMs
were checked and none is occluded by an L1 priority subtile
(`docs/sprites/sprite-4d-monty-mole.md`). The pass earns its keep by making an
annotation's legibility independent of the cell contents, not by
rescuing anything shipped.

Rules:

- Never a second animation timer. Draw something static, or drive it from
  the same state `render` reads - but do not run a clock of your own.
- Signal that it is an annotation, not a second sprite: pass an `alpha`
  to `blit8x8` (0.5 is the house ghost value, same as
  `InvisibleBlockRevealBehavior`).
- Put the annotation INSIDE `hitRect` when it is the recognisable
  artwork. A user who clicks what they can see must get the sprite, not
  a fall-through to the L1 tile behind it. It stays an annotation because
  it has no identity of its own - `Sprite.pickAt` returns the one sprite.
- It does not replace `render`. The in-place pose stays correct and
  authoritative.

## When to add a new sprite family

1. Read the handler in the SMW disassembly (`C:\Projects\SMWDisX`).
   Branch-by-branch, take notes of every speed table, timer, bit, and
   collision call.
2. Write a test file in `test/suite/unit/` that enumerates every ASM
   branch as a test case, with a `// ASM: bank_NN.asm:LINE — label`
   comment for each. Use the `buildSolidity` fixture for synthetic L1
   grids (string-grid → `{solidH, solidV, cols, rows, getL1}`).
3. If the value an Appearance needs at render time is a pure function of
   its arguments (no ROM-parsed or per-instance state), write it as a
   plain function next to the Appearance - see `xShiftPx` in
   `LineBrownPlatAppearance.ts`. Only add a class in `sprites/behaviors/`
   when the value depends on state a plain function can't carry (see
   `SuperKoopaBehavior.dropsFeather`, which needs the sprite's own id).
   Do not add a class for physics nothing calls - that is exactly the
   dead-simulator shape removed in issue #409. `simulate.ts` (the shared
   per-frame stepping primitives) was deleted with the last simulator
   that used it; recreate it only once a real caller needs it, citing the
   ASM lines it steps.
4. If the sprite needs a new visual (new animation frame dispatch,
   a new identity annotation), either add a branch to an existing
   Appearance or write a new `Appearance` subclass.
5. Only if step 3 gave the sprite a behavior class, register its id in
   `behaviors/BehaviorFactory.ts`'s `buildMovementBehavior` dispatch and
   in `SpriteFactory` / `rehydrate` for the Appearance. Every other id -
   including one whose Appearance needs a plain function, not a class -
   falls through to the `default` case, which returns the shared metadata
   object; don't register a class just to reach that same object.

## Sprite annotations

`renderOverlay` is the Canvas2D annotation hook on `SpriteAppearance`.
It has **no implementations on `develop` today**: every path, movement,
trajectory, patrol, orbit and detection-zone annotation was removed,
along with the shared `overlays/primitives.ts` drawing vocabulary they
used. See `docs/sprites/sprite-overlay-removal.md` for the inventory and the
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

`solidityFromL1(getL1)` (`MovementBehavior.ts`) and `spriteCollisionFromL1`
(`SpriteCollision.ts`) unpack those rules into `solidH(c, r) / solidV(c, r)`
booleans and richer per-cell predicates. Don't reimplement this in a new
behavior. Neither has a production caller today - see
`docs/sprites/sprite-overlay-removal.md`'s update section for why they're
kept anyway; whether that's still right is flagged as a separate,
not-yet-filed follow-up (unrelated to issue #418 below).

## Current Behaviors

| Class                | Sprites | What it exposes                             |
| --------------------- | ------- | -------------------------------------------- |
| `SuperKoopaBehavior`  | $71-$73 | `dropsFeather(x)` - cape-flash render state  |

The only concrete class left in `sprites/behaviors/`. Every other sprite
id - including $62 (`LineBrownPlatAppearance` now imports a plain
`xShiftPx` function instead) and $3D (`RipVanFishAppearance` imports the
`RIP_VAN_FISH_DETECT_HALF_PX` constant directly) - falls through
`BehaviorFactory`'s `default` case to the shared metadata object (`kind`,
`displayName`, `spawns`, `isGenerator`, `reactRangeDy`).

Issue #418 tracks turning `SuperKoopaBehavior` into a plain function the
same way, and then deleting `MovementBehavior`, `BehaviorFactory`, and
this directory once nothing needs a class for it.

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
- Randomness. A future simulator should run in worst-case mode by default
  so results are deterministic; if a sprite has per-instance randomness,
  expose it as a config on the Behavior and pick the worst case at the
  call site.

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
- If a future Behavior simulates physics, never hardcode an
  amplitude/range the simulator would produce; let the simulator run and
  let the test assert a reasonable range instead.
