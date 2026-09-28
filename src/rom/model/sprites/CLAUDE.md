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

  **`sprites/behaviors/` does not hold a movement simulator today.** The
  ten `MovementBehavior` subclasses that used to live here
  (`KoopaWalkBehavior`, `HopFlameBehavior`, `BouncingKoopaBehavior`,
  `FlyingLeftKoopaBehavior`, `SinusoidalParaKoopaBehavior`,
  `ThwimpBounceBehavior`, `RipVanFishBehavior`, `BlurpBehavior`,
  `SumoBrotherBehavior`, `FlyingBlockBehavior`) each ported one sprite's
  physics for the sprite-overlay drawings removed in
  `docs/sprites/sprite-overlay-removal.md`. Once that removal shipped, no
  Appearance called any of their methods, so they were reached only from
  their own tests - dead code, not a paused feature. They were deleted
  (issue #409) rather than kept for issue #321's emulator-based rebuild,
  because #321 replaces them with emulator-derived state, not with a
  restored static port; see that document's update for the inventory.
  `simulate.ts`, the shared stepping primitives those ten classes used,
  was deleted with them - it had no reader outside the dead classes.

  What's left in `behaviors/` is genuinely live: `SuperKoopaBehavior`
  ($71-73) exposes `dropsFeather` for the cape-flash render, and
  `LineBrownPlatBehavior` ($62) exposes `xShiftPx` for the platform's
  direction-dependent draw offset. Both are called directly from their
  Appearance's `render()`, not through the dead pattern above. If a new
  sprite genuinely needs a movement simulator, write it fresh against the
  emulator-based approach #321 is building, not by resurrecting this
  layer's shape.

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
3. If the sprite needs a value an Appearance will actually call at
   render time (see `SuperKoopaBehavior.dropsFeather`,
   `LineBrownPlatBehavior.xShiftPx`), add a concrete class in
   `sprites/behaviors/` extending `MovementBehavior` (or implementing
   `SpriteBehavior` directly, if it doesn't need the shared metadata
   fields). Do not add a class for physics nothing calls - that is
   exactly the dead-simulator shape removed in issue #409. `simulate.ts`
   (the shared per-frame stepping primitives) was deleted with the last
   simulator that used it; recreate it only once a real caller needs it,
   citing the ASM lines it steps.
4. If the sprite needs a new visual (new animation frame dispatch,
   a new identity annotation), either add a branch to an existing
   Appearance or write a new `Appearance` subclass.
5. Register the sprite id in `behaviors/BehaviorFactory.ts`'s
   `buildMovementBehavior` dispatch and in `SpriteFactory` /
   `rehydrate` for the Appearance. An id with no behavior class falls
   through to the `default` case, which returns the plain metadata
   object - that's correct for most sprites; only register a class when
   step 3 gave it one.

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
behavior. Neither adapter has a production caller today - their last
callers (`KoopaWalkBehavior` and others; `BouncingKoopaBehavior` and
`WingedGoombaBehavior`) were deleted as dead code in issue #409 - but both
are kept and tested, since the next behavior that needs sprite-perspective
floor/wall detection is the expected consumer, not a reason to delete the
adapter.

## Current Behaviors

| Class                    | Sprites   | What it exposes                                    |
| ------------------------ | --------- | --------------------------------------------------- |
| `SuperKoopaBehavior`     | $71-$73   | `dropsFeather(x)` - cape-flash render state          |
| `LineBrownPlatBehavior`  | $62       | `xShiftPx(direction)` - direction-dependent draw offset |

Both are called directly from their Appearance's `render()`. Neither is a
movement simulator: they expose a small, ROM-derived value an Appearance
reads every frame, not a physics port. `RipVanFishBehavior.ts` also
survives, but only as the `RIP_VAN_FISH_DETECT_HALF_PX` constant -
`RipVanFishAppearance` imports it directly for pose selection; the class
that used to wrap it had no reader and was deleted with the ten dead
simulators (see "Core pattern" above).

Every other sprite id falls through `BehaviorFactory`'s `default` case to
the plain metadata object (`kind`, `displayName`, `spawns`, `isGenerator`,
`reactRangeDy`) - correct for any sprite whose Appearance doesn't call a
behavior method.

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
