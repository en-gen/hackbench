# Removal of sprite path and movement overlays

Commit: `d1d6bcd` on `chore/remove-path-movement-overlays`, based on
`870fa29`. Corrected by a later commit on the same branch after an
adversarial review found several claims here asserted past their
evidence; the sections that changed say what the earlier draft got
wrong, because someone may have already read it.

## What this is

Sprite appearances used to draw Canvas2D annotations on top of the sprite
artwork: patrol corridors, jump arcs, orbit circles, fall paths, swim
bands, detection zones. Clicking a sprite toggled its annotation on.

All of that content is gone. The hook it hung off is not.

## Why

The annotations depicted motion the editor cannot really simulate. Each
one was a static guess at a dynamic system, and keeping them honest meant
carrying a second, parallel physics port next to the real one: a 96-line
frame-by-frame simulator for one fish, a 61-line wall-follow tracer for
one beetle, a path integrator for one platform. That machinery read like
ROM derivation but only ever fed a drawing.

The target architecture is a generic table-driven sprite engine plus the
ability to annotate special sprites. Annotation stays. Motion annotation
goes.

### The distinction that matters

Keep this boundary in mind before adding anything back:

- **Motion annotations** depict movement over time: patrol ranges, jump
  heights, trajectories, orbits, fall columns, detection zones that only
  matter because the sprite will move when triggered. These were removed.
- **Identity annotations** say what a sprite IS when its static resting
  pose does not. A Monty Mole at rest is an anonymous pile of dirt; an
  annotation that shows the mole inside it tells the user something the
  pixels cannot. These are wanted, and more are expected.

## Relationship to issue #321

Issue #321 records the earlier decision to remove sprite MOVEMENT
SIMULATION and restore it in a later milestone. That is the
`src/rom/model/sprites/behaviors/` layer: `KoopaWalkBehavior`,
`HopFlameBehavior`, `SumoBrotherBehavior` and friends, which port the ASM
physics.

This change is the layer above it, and is deliberately narrower. Every
class in `sprites/behaviors/`, every `compute*` method on them and every
behavior test survives untouched, and all eleven of the solidity-taking
methods are now reached only from their own tests (listed below). That is
useful input for #321 but is not resolved here.

Order does not matter between the two: this change compiles and passes
with the behavior layer present, and #321 can proceed afterwards.

### "It removes the drawings, not the simulations" is only half true

An earlier draft of this document said exactly that. It holds for the
sprites whose physics was already factored into a `Behavior`. It is false
for the ones whose physics only ever existed inside the overlay.
`BehaviorFactory.buildMovementBehavior` dispatches ids `$00`-`$07`,
`$08`-`$0C`, `$0F`, `$10`, `$1D`, `$27`, `$30`, `$32`, `$3D`, `$62`,
`$71`-`$73`, `$83`/`$84`, `$9A` and `$C2`, and nothing else.

Every sprite that lost an overlay, and what remains of its ROM work:

| Sprite | Appearance | Behavior port | ROM derivation after this commit |
|---|---|---|---|
| `$04`-`$07`, `$0F` | `Koopa` | `KoopaWalkBehavior` | in the behavior |
| `$08`, `$09`, `$0A`, `$0B`, `$10` | `WingedSprite` | `FlyingLeftKoopa` / `BouncingKoopa` / `SinusoidalParaKoopa` / `WingedGoomba` | in the behaviors |
| `$1D` | `HopFlame` | `HopFlameBehavior` | in the behavior |
| `$27` | `Thwimp` | `ThwimpBounceBehavior` | in the behavior |
| `$30`, `$32` | `DryBones` | `KoopaWalkBehavior` | in the behavior |
| `$3D` | `RipVanFish` | `RipVanFishBehavior` | in the behavior, plus the kept detect half-width and Z trajectory |
| `$9A` | `SumoBrother` | `SumoBrotherBehavior` | in the behavior |
| `$C2` | `Blurp` | `BlurpBehavior` | in the behavior |
| `$26` | `Thwomp` | **none** | kept in the appearance: `InitThwomp` anchor, alert and aggressive ranges, face-tile swap |
| `$9E` | `BallAndChain` | **none** | kept in the appearance: `InitBallNChain` radius, chain and sphere OAM layout |
| `$AC`/`$AD` | `WoodSpike` | **none** | kept in the appearance: `WoodSpikeGfx` tables, state machine, extend direction |
| `$15`/`$16` | `CheepCheep` | **none** | **gone** |
| `$18` | `JumpingFish` | **none** | **gone** |
| `$2E` | `SpikeTop` | **none** | **gone** except the animation cadence |
| `$47` | `SwimJumpFish` | **none** | **gone** except the handler line |
| `$4D`/`$4E` | `MontyMole` | **none** | **gone**; PR #326 brings back a different and larger derivation |
| `$4F` | `JumpingPiranha` | **none** | **gone**; the `InitPiranha` centering survives in `SpriteTileLoader.ts` |
| `$9C` | `HammerBroPlatform` | **none** | **gone** except the handler line |
| `$B7`/`$B8` | `CarrotTopLift` | **none** | **gone** |

For the eight rows marked "gone" the port and the drawing were the same
code, so rebuilding them is not the cheap job the #321 framing implies:
their research was never in the behavior layer to begin with.

That cost lands only on someone who REBUILDS. `git revert d1d6bcd`
restores every one of those lines byte-identically, verified below, so
the restore path is unaffected.

The measurement: 13 distinct `bank_NN.asm:line` citations and 16 distinct
`CODE_` / `DATA_` labels were removed from `src/` by this commit and now
appear nowhere in `src/`, `test/` or `docs/`. Counted by extracting every
citation token from the commit's removed `src/` lines and grepping the
worktree at `366e8c7` for each one. The ones worth keeping are
transcribed under "ROM evidence that went with the overlays" below.

## Merge with `feature/monty-mole-render` (PR #326)

Branch `feature/monty-mole-render`, open as PR #326, is not on this base.
It adds:

- a NEW annotation mechanism, `SpriteAppearance.renderAboveL1?()`, a
  pixel pass (the Canvas2D `OverlayContext` cannot blit tile pixels), and
- a `$4D` detection-zone `renderOverlay`.

This branch removes the `$4D` detection-zone `renderOverlay` (it lived in
`MontyMoleAppearance`) and every other `renderOverlay` implementation.

### What git actually does

Measured, not predicted: `git merge-tree --write-tree` run in both branch
orders on 2026-09-18, one machine, against base `870fa29`. Both orders
give the identical result, two conflicts:

```
CONFLICT (content): src/rom/model/sprites/appearances/MontyMoleAppearance.ts
CONFLICT (modify/delete): test/suite/unit/model/AppearanceGuards.test.ts
    deleted in chore/remove-path-movement-overlays and modified in
    feature/monty-mole-render.
    Version feature/monty-mole-render left in tree.
```

An earlier draft of this document claimed that merging PR #326 second
would "silently reintroduce one detection-zone overlay" and that "git
will not flag it". Both halves are wrong.

**Git flags it, and nothing is reintroduced.** The conflict in
`MontyMoleAppearance.ts` is confined to the file header, everything above
`export class MontyMoleAppearance`. The class body auto-merges cleanly:
`renderAboveL1` in, `renderOverlay` out, because the deleted method and
the added one sit far enough apart for the merge to resolve. The
conflicted blob contains zero occurrences of `renderOverlay`, and so does
the rest of the merged `src/` tree apart from the unrelated
`TileBehavior.renderOverlay` implementations and the kept declarations.

**The dangerous conflict is the one an earlier draft never mentioned.**
`AppearanceGuards.test.ts` is a modify/delete, and git leaves PR #326's
version in the tree: about 250 lines of `renderOverlay` describes for
Blurp, JumpingFish, JumpingPiranha, MontyMole, CarrotTopLift, CheepCheep,
HopFlame and Koopa. None of those classes has the method after this
branch. Resolve the header hunk, observe that no `renderOverlay`
survives, conclude the warning is handled, and you ship a red suite and a
failing `tsc` from a file that never showed you a conflict marker.

### Resolution

1. `src/rom/model/sprites/appearances/MontyMoleAppearance.ts`: take PR
   #326's side of the header hunk, then drop from it the three things the
   auto-merged body no longer uses:
   - `import { COLORS, drawOverlayRect } from '../../overlays/primitives'`.
     This branch deletes that module, so keeping the import is an
     unresolvable one, not merely a dead one.
   - `import type { GetL1Tile, OverlayContext } from '../../OverlayContext'`.
   - the `DETECT_HALF` constant, which was the `$4D` zone half-width.

   Keep everything else PR #326 adds: the `SpriteTileTables`, `Char`,
   `partsHitRect` / `HitRect`, `RenderTarget`, `MapStore`,
   `SpriteBehavior` and `ROM_FRAMES_PER_TICK` imports, and the `MOLE_*`
   and `EMERGED_*` exports. Leave the auto-merged body alone.

   Do NOT take this branch's side of that hunk wholesale. This branch's
   header is two imports long, because the class under it is a 13-line
   constructor; against PR #326's body it drops every symbol the ghost
   pose needs. That is a loud compile error rather than a silent loss,
   but it is still the wrong resolution.

2. `git rm test/suite/unit/model/AppearanceGuards.test.ts`. Every describe
   in it covers a `renderOverlay` that no longer exists, and nothing in it
   covers `renderAboveL1`; PR #326 carries its own tests for that.

The OUTCOME the earlier draft recommended was right: keep `renderAboveL1`
and the mole indicator, which is an identity annotation by the definition
above, and drop the `$4D` detection zone, which is not. Only its account
of how you get there was wrong.

### Which one should merge first

**PR #326 first, then this branch.** Standing alone, this branch is a real
regression for `$4D`/`$4E`: `MontyMoleAppearance` becomes a 13-line
constructor with no annotation at all, so a Monty Mole in the editor is an
anonymous mound with nothing saying a mole lives in it. This document
resolves that by pointing at an unmerged branch, which is a dependency,
not an argument. #326 being open strengthens the position but does not
remove the dependency.

The reverse order also works and costs nothing extra, because the
conflicts and the resolution above are identical either way. It just
leaves `$4D` unannotated on `develop` for however long #326 takes.

## What was kept, and why

| Kept | Why |
|---|---|
| All appearance rendering | Tiles, positions, flips, palettes, animation frames. Never in scope. |
| `SpriteAppearance.renderOverlay?()` | The annotation extension point. See below. |
| `SmwMap.renderSpriteOverlays()` and its `getL1` closure | Same. Without it the hook cannot fire. Now covered directly by `test/suite/unit/model/SmwMapSpriteOverlays.test.ts`. |
| Webview click-to-toggle (`spriteOverlayKeyAt`, `toggleSpriteOverlay`, `activeSpriteOverlays`) | Same. Without it nothing can set `isActive`. |
| Tile and Map16 behavior overlays (`InvisibleBlockRevealBehavior`, `VineSourceBehavior`, `StarOneUpVineBlockBehavior`, `KeyCoinBalloonKoopaBlockBehavior`, `PaletteOrBehavior`) | Different hook (`TileBehavior.renderOverlay`), explicitly out of scope. |
| `drawSurfaces` / `drawWalls` / L2 and L3 range overlays | Tile-collision debug overlays in the webview, not sprite annotations. |
| `src/rom/model/OverlayContext.ts` | Still the type the hook is declared against, and `isPriorityDecorative` / the acts-like predicates are used by `SmwMap`, `SurfacePath` and the webview overlays. |
| All of `sprites/behaviors/` | Issue #321's scope. |
| `ThwompAppearance`'s `ALERT_PX` / `AGGRESSIVE_PX` | Read by `render()` for the face-tile swap, so they are appearance data. Only the zone DRAWING went. |
| `RipVanFishAppearance`'s `RIP_VAN_FISH_DETECT_HALF_PX` and `Z_TRAJECTORY` | Both read by `render()`: the wake square picks the pose, the Z trajectory places real sprite pixels. |
| `CarrotTopLiftAppearance.spriteId`, `CheepCheepAppearance.vertical` | Variant identity, still constructed by the factory. |

### The empty hook is deliberate

`renderOverlay` now has **zero implementations**. That is intentional and
is noted in three places so a future reader does not tidy it away:

- the JSDoc on `SpriteAppearance.renderOverlay`
- `src/rom/model/CLAUDE.md`
- `src/rom/model/sprites/CLAUDE.md`

Nothing else on this branch provides the annotation capability, so
removing the hook would have cost the capability, not just the code. The
cost of restoring it later would have been the hook declaration on two
interfaces, the `Sprite.renderOverlay` forwarder, the `SmwMap` pre-pass
with its priority-filtered `getL1` closure, and the webview hit-test and
toggle-set plumbing. That is not a one-line change, which is why it
stayed.

### The kept hook has an oracle

Keeping a capability is a claim, and until the review of this branch the
claim had nothing behind it. `SmwMap.renderSpriteOverlays` had never been
tested directly. Before the removal its shape was exercised incidentally
by 19 `renderOverlay` implementations plus `AppearanceGuards.test.ts`;
afterwards, nothing touched it, so gutting or deleting the pre-pass would
have left the suite green.

`test/suite/unit/model/SmwMapSpriteOverlays.test.ts` is the oracle. A stub
appearance implements the hook and records what the pre-pass hands it: the
dispatch (one call per implementing sprite, hookless sprites skipped
without stopping the walk), the forwarded origin, behavior, `mapStore` and
level dimensions, the `isActive` decision, and the priority-filtered
`getL1` closure including the acts-like fallback, the all-four-subtiles
priority rule and the per-tile collision passthrough.

Proven able to fail, on one machine, vitest 4.1.5. Seven planted defects,
each killed by the test that targets it:

| Mutation | Result |
|---|---|
| `renderSpriteOverlays` body replaced with `return` | 11 of 11 failed |
| key format changed to `id_x_y` | 1 failed (format lock) |
| `isPriority` forced to `false` | 1 failed |
| acts-like fallback `?? id` changed to `?? 0` | 1 failed |
| `collision` dropped from the cell | 1 failed |
| `isActive` forced to `true` | 2 failed |
| `cols` and `rows` swapped at the call site | 1 failed |

The key-format agreement needed a small source change to be testable at
all. `SmwMap.renderSpriteOverlays` and the webview's `spriteOverlayKeyAt`
each built the `"id:x,y"` string by hand, and nothing could catch them
drifting apart; a drift would mean clicks setting a key that rendering
never reads, with no error anywhere. Both now call one exported
`spriteOverlayKey(sprite)` in `sprites/Sprite.ts`, and the test pins its
literal output. `EditorStoreActions.test.ts` used `'spr_32_48'`, a shape
neither side has ever produced; the store takes any string, so that test
could not have caught a divergence and now at least does not advertise a
fictional format.

## Inventory

Totals: **4834 lines deleted, 157 inserted** across 42 files.

### Support modules deleted outright

| File | Lines |
|---|---|
| `src/rom/model/overlays/primitives.ts` | 506 |
| `src/rom/model/overlays/patrolPath.ts` | 177 |

`primitives.ts` was the shared drawing vocabulary (`drawCorridor`,
`drawBounceArc`, `drawSineBand`, `drawFadeCorridor`, `drawFallL`,
`drawArrowHead`, `drawApexLine`, `drawSpawnDrop`, `drawVertLane`,
`drawOverlayRect`, `findSolidBoundary`, the `COLORS` palette).
`patrolPath.ts` was the shared ground-walker corridor renderer. Both had
zero consumers outside the removed `renderOverlay` bodies.

### Appearance classes

`del` counts are lines removed from that file by this commit.

| File | del | What went |
|---|---|---|
| `SwimJumpFishAppearance.ts` | 219 | `renderOverlay` plus the 96-line frame-by-frame `tick()` physics simulator, `FISH_PATH` (600 simulated frames) and `FISH_BOUNDS` |
| `WingedSpriteAppearance.ts` | 179 | `renderOverlay` (6-way `instanceof` dispatch over behaviors) plus the `strokeDashedPolyline` helper |
| `SumoBrotherAppearance.ts` | 170 | `renderOverlay` plus the 48-line `drawFlameFootprint` and the `surfaceYAt` interpolator |
| `SpikeTopAppearance.ts` | 157 | `renderOverlay` plus the 61-line wall-follow tracer (`tracePatrolPath`, `solidForWallFollow`, the four 8-direction tables, `MAX_PATH_STEPS`) |
| `CheepCheepAppearance.ts` | 107 | `renderOverlay` (swim-corridor wall scan) and `ENDCAP_HALF` |
| `CarrotTopLiftAppearance.ts` | 97 | `renderOverlay` (diagonal path) and `TRAVEL_PX` / `CAP_HALF` |
| `HammerBroPlatformAppearance.ts` | 88 | `renderOverlay` plus the 34-line `PLATFORM_PATH` integrator and `PLATFORM_BOUNDS` |
| `ThwompAppearance.ts` | 83 | `renderOverlay` (alert/aggressive zones, fall column, blocker-row scan) |
| `HopFlameAppearance.ts` | 77 | `renderOverlay` (bounce envelope, ground band, apex line) |
| `JumpingPiranhaAppearance.ts` | 74 | `renderOverlay` and `JUMP_H` / `BODY_HALF` |
| `BallAndChainAppearance.ts` | 64 | `renderOverlay` (orbit circle, direction arrows) and `RADIUS_PX` |
| `JumpingFishAppearance.ts` | 62 | `renderOverlay` and `JUMP_H` / `ENDCAP_HALF` |
| `BlurpAppearance.ts` | 58 | `renderOverlay` (swim line, arrowhead) |
| `ThwimpAppearance.ts` | 53 | `renderOverlay` (spawn drop, first-hop arc) |
| `MontyMoleAppearance.ts` | 48 | `renderOverlay` (detection band) and `DETECT_HALF` |
| `KoopaAppearance.ts` | 43 | `renderOverlay` (delegated to `drawPatrolPath`) |
| `RipVanFishAppearance.ts` | 40 | `renderOverlay` (wake-zone rect). Pose selection and Z trail kept. |
| `WoodSpikeAppearance.ts` | 34 | `renderOverlay` (extension column, apex line) |
| `DryBonesAppearance.ts` | 21 | `renderOverlay` (delegated to `drawPatrolPath`) |
| `SpriteAppearance.ts` | 13 | Overlay-specific JSDoc, replaced with the extension-point note |
| `StaticSpriteAppearance.ts` | 2 | Comment wording only; the optional-member declaration stays |

Of the roughly 254 lines of overlay-only MODULE-LEVEL code flagged in the
brief, the four largest blocks were found and removed where predicted:
the `SwimJumpFish` simulator, the `SpikeTop` tracer, the `SumoBrother`
flame drawer, the `HammerBroPlatform` integrator. Smaller module-level
constants went from `CheepCheep`, `CarrotTopLift`, `JumpingFish`,
`JumpingPiranha`, `MontyMole` and `BallAndChain`.

### Supporting edits

| File | Change |
|---|---|
| `src/rom/model/SpriteFactory.ts` | Comment no longer points at `ThwompAppearance.renderOverlay` |
| `src/rom/model/sprites/MovementBehavior.ts` | `solidityFromL1` JSDoc no longer claims appearances call it |
| `src/rom/model/sprites/behaviors/BlurpBehavior.ts` | Dropped `BLURP_FADE_LENGTH_PX`, an editor-preview-only constant with no remaining reader. The three ROM-derived Blurp constants stay. |
| `src/rom/model/CLAUDE.md` | Appearance table, `marioSpawnX` consumer list, `renderOverlay` section. The `marioSpawnX` row was rewritten WRONG by this commit and corrected afterwards: see below. |
| `src/rom/model/sprites/CLAUDE.md` | Replaced the overlay drawing-vocabulary section with the annotation boundary |

### Tests

Five files deleted, nine trimmed. **168 tests removed**: 2387 passed
before, 2219 after.

| File | Fate | del |
|---|---|---|
| `test/suite/unit/overlayPrimitives.test.ts` | deleted | 471 |
| `test/suite/unit/model/patrolPath.test.ts` | deleted | 328 |
| `test/suite/unit/model/AppearanceGuards.test.ts` | deleted | 250 |
| `test/suite/unit/model/SumoBrotherAppearance.test.ts` | deleted | 215 |
| `test/suite/unit/model/CheepCheepAppearance.test.ts` | deleted | 131 |
| `test/suite/unit/model/SpikeTopAppearance.test.ts` | trimmed | 310 |
| `test/suite/unit/model/WingedSpriteAppearance.test.ts` | trimmed | 195 |
| `test/suite/unit/model/SwimJumpFishAppearance.test.ts` | trimmed | 146 |
| `test/suite/unit/model/ThwimpAppearance.test.ts` | trimmed | 104 |
| `test/suite/unit/model/BallAndChainAppearance.test.ts` | trimmed | 103 |
| `test/suite/unit/model/DryBonesAppearance.test.ts` | trimmed | 58 |
| `test/suite/unit/model/ThwompAppearance.test.ts` | trimmed | 56 |
| `test/suite/unit/model/RipVanFishAppearance.test.ts` | trimmed | 24 |
| `test/suite/unit/model/HammerBroPlatformAppearance.test.ts` | trimmed | 21 |

Three of the five deletions are appearance-named (`AppearanceGuards`,
`SumoBrotherAppearance`, `CheepCheepAppearance`) and contained only
`renderOverlay` describes. The other two (`overlayPrimitives`,
`patrolPath`) are the tests for the two deleted support modules. The
trimmed files kept every `fromTables`, `render`, `hitRect`,
`tickAnimation` and factory test. No appearance test was lost.

`SwimJumpFishAppearance.test.ts` is the one judgement call: its remaining
test only asserts the inherited default hit rect, because the class it
covered is now a bare `StaticSpriteAppearance` subclass. It was kept
rather than deleted so the file survives a revert cleanly.

`SpriteLifecycle.test.ts` still covers `Sprite.renderOverlay`'s
optional-chaining branches, which is the right place for that now that no
appearance implements the hook.

## Corrections to this document and to the commit message

Found by the adversarial review of this branch and fixed by the commit
that added this section. The merge-order, issue-#321 and behavior-method
corrections are inline in those sections above.

### `mapStore.marioSpawnX` is dead, and this commit's own doc edit hid it

This commit rewrote the `mapStore` consumer table in
`src/rom/model/CLAUDE.md` to say `marioSpawnX` is consumed by
"`SpriteFactory` facing decisions (`ChuckAppearance.facesMario`,
`DryBonesAppearance.fromTables`)". Those two read `marioStartPx`, the
parse-time argument `SpriteFactory` is handed, not the reactive store
field. `mapStore.marioSpawnX` has **zero readers in `src/`** at
`366e8c7`: all five were removed `renderOverlay` bodies. The comment at
`MapBuilder.ts:133` was stale for the same reason.

Both are corrected on this branch. The field itself is kept, because
`MapPayload` serialises it and an identity annotation that depends on
Mario's spawn side would need it live, but the docs no longer claim it
has readers.

### Two count errors

- Commit `d1d6bcd`'s message says "20 renderOverlay implementations".
  There were **19**. Twenty files under `sprites/appearances/` contained
  the string at `870fa29`; the twentieth is
  `StaticSpriteAppearance.renderOverlay?()`, an optional-member
  declaration that exists so subclasses can use `override`, not an
  implementation. The inventory table above lists the 19 correctly. The
  commit message cannot be amended, so this note is the correction.
- The sentence about deleted test files said "the four deleted
  appearance-named files". Three of the five deletions are
  appearance-named; the other two are the overlay support modules' own
  tests. Corrected in place above.

## ROM evidence that went with the overlays

Transcribed here rather than back into the source, per the standing
preference that derived ROM knowledge lives in docs and not in large
inline comment blocks. All of it is recoverable with
`git show d1d6bcd`; the point of writing it down is that nobody will
think to look.

### `$2E` Spike Top: the direction the appearance hardcodes

`SpikeTopAppearance.fromTables` hardcodes `flipX: false, flipY: false`,
and its JSDoc still says "Direction defaults to 0 (`DATA_02BCC7[0]=$00`
so no flip)". The lines that justified the word "defaults", and recorded
what the other case is, went with the overlay. Re-traced in `SMWDisX` at
`366e8c7`:

- `InitSpikeTop` (`bank_01.asm:602`) calls `SubHorizPos`
  (`bank_01.asm:6124`), which returns `Y = 0` when Mario is to the RIGHT
  of the sprite and `Y = 1` when he is to the LEFT.
- It then runs `TYA : EOR #$01 : ASL A` four times, so A is `$10` for
  Mario-right and `$00` for Mario-left, and the fall-through at
  `CODE_01841D` stores that in `SpriteMisc151C,X`.
- `CODE_01840E` (`bank_01.asm:620`) runs
  `LDA SpriteMisc151C,X : EOR #$10 : STA : LSR A : LSR A : STA SpriteTableC2,X`.
  Mario to the RIGHT gives `SpriteTableC2 = 0`. Mario to the LEFT gives
  `SpriteTableC2 = 4`.
- `WallFollowersMain` (`bank_02.asm:8057`) indexes the OBJ attribute
  table by that value: `ORA.W DATA_02BCC7,Y` at `bank_02.asm:8089`, with
  `DATA_02BCC7` at `bank_02.asm:8051` reading
  `db $00,$C0,$C0,$00,$40,$80,$80,$40` then
  `db $80,$C0,$40,$00,$C0,$80,$00,$40`. Index 0 is `$00`, no flip; index
  4 is `$40`, the OBJ X-flip bit. The tilemap index for the same Y
  (`ADC.W DATA_02BCB7,Y`, `bank_02.asm:8085`) is `$00` in both cases, so
  only the flip differs.

The consequence nothing in the tree records today: direction is not
always 0. A Spike Top spawning with Mario to its LEFT starts at direction
4 and the game draws it X-flipped, so the hardcoded `flipX: false` is the
wrong pose for that placement. "Defaults to 0" reads like a derived
constant; it is a static-editor approximation.

It is fixable without a behavior port, from the same `marioStartPx`
argument `SpriteFactory` already uses for `$30`/`$32` Dry Bones and the
Chucks. Not done here: this branch removes things, and a rendering change
wants its own PR and its own test.

### `$AC`/`$AD` Wood Spike: where the sharp tip sits in the tip tile

`WoodSpikeAppearance` records which tiles are V-flipped (`WoodSpikeGfxProp`
bit 7, `bank_03.asm:2669`) and where the body sits, but not the
consequence the removed overlay depended on. With V-flip, `$AC`'s sharp
point is at the BOTTOM of its 16x16 tip tile, so the tip is at `y + 16`.
`$AD` has no flip and its point is at the TOP, at `y`. Any future
annotation that anchors on the tip needs that, and it is not derivable
from the part offsets alone.

### `$4F` Jumping Piranha Plant

Two separate things went, and only one is a real loss.

The body-centering note is duplication loss: `dx` spans 8 to 24 and the
centre is `spawn_x + 16`, from `InitPiranha`'s `+8` X adjustment at
`bank_01.asm:880`. `SpriteTileLoader.ts` still carries it on the `$4F`
entry, so nothing is lost outright.

The jump-height derivation is a genuine loss. `JumpingPiranhaMain` into
`CODE_02E0CD` (`bank_02.asm:12804`) is a three-state machine indexed by
`SpriteTableC2`: `CODE_02E13C` dwells in the pipe until `SpriteMisc1540`
expires, then sets Y speed `$C0`; `CODE_02E159` rises, adding `#$02` per
frame from `$C0` to `$F0` over 24 frames, worth about 62 px;
`CODE_02E177` applies `EffFrame & $03` gravity from `$F0` to 0 over 64
frames, worth about 34 px. Those sum to the 96 px `JUMP_H` the overlay
drew. None of `CODE_02E0CD`, `CODE_02E13C`, `CODE_02E159` or
`CODE_02E177` appears anywhere in `src/`, `test/` or `docs/` now.

### The rest

The other citations that no longer appear anywhere in the tree:

| Sprite | Labels lost |
|---|---|
| `$15`/`$16` CheepCheep | `CODE_01B0A7` (`bank_01.asm:6555`, `:6606`) |
| `$18` JumpingFish | `DATA_01B1B1` jump speeds, `DATA_019030` gravity index, `bank_01.asm:6743` |
| `$2E` SpikeTop | `DATA_02BC8F` / `DATA_02BC9F` wall-follow forward and probe speeds, `bank_02.asm:8065` |
| `$47` SwimJumpFish | `CODE_02E74E`, `CODE_02E77C`, `CODE_02E788`, `CODE_02E7A4`, `DATA_02E74C`. The handler line `CODE_02E727` survives in the appearance header. |
| `$4D`/`$4E` MontyMole | `CODE_01E2E0` (`bank_01.asm:13340`), `CODE_01E305`. PR #326 supplies its own, larger derivation for this sprite. |
| `$9C` HammerBroPlatform | `CODE_02DB5C` (`bank_02.asm:12149`) |
| `$B7`/`$B8` CarrotTopLift | `bank_03.asm:1535`, `:1554`, `:1556`, and `SubSprYPosNoGrvty` at `bank_01.asm:5927` |

None of them is load bearing for anything that renders today. They are
listed so a future rebuild knows the research existed and where it was.

## Restore procedure (verified)

One commit, so one revert, no ordering trap:

```bash
git revert d1d6bcd
```

This was actually run twice, both times in this worktree, one machine.

**From `366e8c7`, with only `d1d6bcd` and the original doc on top:**

| Check | Result |
|---|---|
| `git diff --stat 870fa29 HEAD` after the revert | empty: tree byte-identical to the pre-removal base |
| `src/rom/model/overlays/` | both files back |
| appearance files containing `renderOverlay` | 20, as before |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 144 files passed, 2 skipped; 2387 tests passed, 8 skipped |

**Re-run from `5a56ca5`, the corrections commit, which is the current
branch tip.** That commit edits seven files `d1d6bcd` also touched, so
this is the "a later commit got there first" case:

| Check | Result |
|---|---|
| conflicts | 2, both Markdown prose: `src/rom/model/CLAUDE.md` and `src/rom/model/sprites/CLAUDE.md` |
| conflicts in code | none. `SpriteFactory.ts`, `MovementBehavior.ts`, `SpikeTopAppearance.ts`, `WoodSpikeAppearance.ts` and `SpikeTopAppearance.test.ts` all auto-merged |
| resolution | take the restored side of all three hunks; the removal-era prose is what the revert is trying to bring back |
| `git diff --stat 870fa29 HEAD` after the revert | only this document, the corrections commit's own files, and the new hook test. No overlay code differs from `870fa29`. |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 145 files passed, 2 skipped; 2398 tests passed, 8 skipped |

2398 is 2387 plus the 11 tests in `SmwMapSpriteOverlays.test.ts`, which
is not reverted and keeps passing with the overlays back.

Two wrinkles the first run did not surface, both cheap and both worth
knowing before you start:

- **The pre-commit hook rejects the revert.** Rule 2 of
  `tools/scripts/check-staged-content.sh` blocks em-dashes in ADDED
  lines, and restored lines are added lines. `overlays/primitives.ts`,
  `overlays/patrolPath.ts`, `SpriteAppearance.ts`, `sprites/CLAUDE.md`
  and several appearances all trip it. Verified directly by staging the
  restored `primitives.ts` alone and running the script: BLOCKED, exit 1.
  Use `git commit --no-verify` and say in the PR that the reason is a
  revert of pre-rule content.
- **Two prose notes need deleting by hand.** The corrections commit added
  a paragraph to `sprites/CLAUDE.md` saying no Appearance calls the
  behavior methods, and changed a `// Consumes:` example in
  `src/rom/model/CLAUDE.md` off `mapStore.marioSpawnX`. Both become false
  the moment the overlays are back. They survive the revert because they
  are not part of `d1d6bcd`.

Beyond that the conflict surface stays small and mechanical: every hunk
either restores a whole `renderOverlay` method or a whole module-level
block, and the two deleted support modules restore as new files with no
conflict possible.

This document is NOT reverted by that command, because it is committed
separately. That is intentional: after a restore it becomes the record of
why the overlays once went away.

## Post-removal observations

### Classes that could now collapse to `StaticSpriteAppearance`

Not done in this change, deliberately. Each of these is now a bare
subclass that adds nothing to `StaticSpriteAppearance`:

| Class | Sprites | Adds |
|---|---|---|
| `BlurpAppearance` | $C2 | nothing |
| `HopFlameAppearance` | $1D | nothing |
| `JumpingFishAppearance` | $18 | nothing |
| `JumpingPiranhaAppearance` | $4F | nothing |
| `KoopaAppearance` | $04-$07, $0F | nothing |
| `MontyMoleAppearance` | $4D/$4E | nothing |
| `SwimJumpFishAppearance` | $47 | nothing |

Two of the nine named in the brief do NOT collapse:

- `CheepCheepAppearance` keeps a `vertical` flag distinguishing $15 from
  $16.
- `CarrotTopLiftAppearance` keeps `spriteId` distinguishing $B7 from $B8.

Collapsing the seven is a follow-up, not free: each is named in
`AppearanceFactory`, `SpriteFactory`, `rehydrate.ts` and the serialize
round-trip tests. `MontyMoleAppearance` in particular should NOT be
collapsed: PR #326 gives it a `renderAboveL1` implementation, a
`fromParts` factory and a three-argument constructor.

### Removed overlays that were arguably doing identity work

Worth considering for the annotation layer rather than for restoration as
path overlays:

- **`$4D`/`$4E` Monty Mole detection band.** The clearest case. The
  sprite's resting appearance is a pile of dirt; anything that says "a
  mole lives here" is identity work. The 192 px band itself is motion
  (where the mole triggers), but the need it served is identity, and
  `feature/monty-mole-render`'s translucent mole answers it better.
- **`$3D` Rip Van Fish wake square.** Partly identity: a sleeping fish
  reads as a decoration until you know it wakes. Note the appearance
  already carries the identity half without any annotation, because
  hovering swaps to the chasing pose and the Z snore trail renders as
  real sprite pixels.
- **`$26` Thwomp alert/aggressive zones.** Mostly motion, but the
  appearance keeps the identity half for free: the face-tile swap at
  +-36 px still fires from cursor proximity.
- **`$AC`/`$AD` Wood Spike extension column.** Arguably identity, in that
  a retracted spike hides how far it reaches. The appearance already
  animates the extension, so the information is present over time.

The rest ($04-$07 patrols, $09/$10 bounce arcs, $47 swim/jump, $9C
platform ellipse, $9E orbit, $2E wall-follow, $9A lightning) are pure
motion with no identity component.

### Behavior methods with no caller in `src/`

Verified by grep over `src/` at `366e8c7`: each of these had its only
caller inside a removed `renderOverlay`, and **all eleven now have zero
call sites anywhere in `src/`**. Every remaining match is either the
declaration itself or prose in a doc comment. They are reached only from
their own tests.

An earlier draft hedged this with "a few are still called from inside the
behavior layer (`computeBouncePath` from `computeBouncePolyline`,
`simulateBounds` from `simulate.ts`)". Neither example holds:
`BouncingKoopaBehavior.computeBouncePolyline` (`BouncingKoopaBehavior.ts:161`)
calls `simulateCyclePolyline`, and `simulate.ts:12` is a comment. Since
this list feeds the #321 decision, understating how dead these are is the
wrong direction to be wrong.

They are input for issue #321, not defects of this change:

- `KoopaWalkBehavior.computePatrolRange`
- `HopFlameBehavior.simulateBounds`, `.computeBouncePath`
- `ThwimpBounceBehavior.computeBouncePath`
- `SumoBrotherBehavior.getPatrolRange`, `.getLightningFall`, `.getClusterFireXs`
- `BouncingKoopaBehavior.computeBouncePolyline`
- `WingedGoombaBehavior.computeBouncePolyline`
- `FlyingLeftKoopaBehavior.computeFadeCorridor`
- `SinusoidalParaKoopaBehavior.computeSineBounds`
- `FlyingBlockBehavior.computePath`
- `BlurpBehavior.swimDirection`

`SurfacePath` was reached from `src/` through the behaviors above; its
only caller now is the reference-only `src/webview/mapEditor/overlays/
drawSurfaces.ts` (via `buildSurfacePath` directly - `drawSurfaces` never
called `solidityFromL1` / `spriteCollisionFromL1`, contrary to what an
earlier draft of this section implied). `solidityFromL1` and
`spriteCollisionFromL1` were reached only through the behaviors above;
see the update below for what that means once those behaviors are gone.

## Update 2026-09-28: the behaviors/ layer was deleted (issue #409)

This section's own inventory, above, undercut its "kept for #321" framing
without saying so: the eleven behavior methods it lists had zero callers
outside their own tests *at the time this document was written*, not
after some later drift - the overlays that used to call them were the
ones removed in #328; nothing has called them since. Issue #409 acted on
that finding and deleted the classes, rather than carrying them forward
into #321 (the emulator-based rebuild) as working-but-unused code.

Eleven classes removed outright, source and tests: `KoopaWalkBehavior`,
`HopFlameBehavior`, `BouncingKoopaBehavior`, `FlyingLeftKoopaBehavior`,
`SinusoidalParaKoopaBehavior`, `ThwimpBounceBehavior`, `BlurpBehavior`,
`SumoBrotherBehavior`, `FlyingBlockBehavior`, `WingedGoombaBehavior`, and
`RipVanFishBehavior`, plus the `simulate.ts` stepping primitives the first
ten shared. That is every class this document names above.

**`RipVanFishBehavior` was not on the original eleven-method list, and
turned out to be a mixed case.** The class itself (a `detectHalfPx`
getter wrapping `RIP_VAN_FISH_DETECT_HALF_PX`) had the same zero-caller
shape as the other ten and was deleted. The constant it wrapped did not:
`RipVanFishAppearance.render` reads `RIP_VAN_FISH_DETECT_HALF_PX` directly
to pick the sleeping-versus-chasing pose from cursor proximity - exactly
the "appearance data, not movement simulation" distinction this document
draws in the Rip Van Fish row of the inventory table above. The constant
survives, re-exported from the same file path; only the class shell is
gone.

**Two sprites this document's inventory never examined turned out to be
genuinely live.** `SuperKoopaBehavior` ($71-$73) and `LineBrownPlatBehavior`
($62) both predate this document (2026-04-24, `f3ec4ec2` and `04436106`) -
they were simply never in scope for the overlay-removal audit above, not
added afterward. `SuperKoopaBehavior.dropsFeather(x)` drives the
cape-flash render in `SuperKoopaAppearance`, and `LineBrownPlatBehavior`'s
`xShiftPx(direction)` set the direction-dependent draw offset in
`LineBrownPlatAppearance`. Both call sites are ordinary per-frame render
logic, not the removed overlay pattern - proof that "reached only from
behaviors/" needs checking per class, not assumed for a whole directory
an audit didn't actually cover.

`SuperKoopaBehavior` stays (`dropsFeather` is its only method and is
live). `LineBrownPlatBehavior` did not: `xShiftPx` is a pure function of
its `direction` argument with no ROM-parsed state, so it moved to a plain
function next to `LineBrownPlatAppearance`, and `BehaviorFactory`'s
`case 0x62` was dropped - it produced an object identical to what the
`default` case already returns for every field any live caller reads.
`SuperKoopaBehavior.isSwooping()`, an unused sibling method next to the
live `dropsFeather`, was deleted the same way as the eleven above: no
caller anywhere outside its own test.

**Sprite-perspective `TileCollision` fields have a live reader today, and
it is not `SmwMap.renderSpriteOverlays`.** `renderSpriteOverlays`'s
`getL1` closure only feeds the sprite-annotation `renderOverlay` hook,
which has zero implementations (see "Sprite annotations" below) - it
currently feeds nothing live. The actual live readers of
`tile.collision.floor` are in `SpriteFactory.ts`: line 402 picks the
Super Koopa's airborne-vs-grounded pose, and line 931 (inside
`thwompReactRangeDy`) scans for the floor row below a Thwomp. Neither
goes through `solidityFromL1` or `spriteCollisionFromL1` - both read
`tile.collision.floor` directly off the parsed L1 tile.

`solidityFromL1` (`MovementBehavior.ts`) and `spriteCollisionFromL1`
(`SpriteCollision.ts`) lost their only production callers with this
deletion (`KoopaWalkBehavior` and others; `BouncingKoopaBehavior` and
`WingedGoombaBehavior`, respectively) and are exercised only by their own
tests today. Kept rather than deleted, since they are small,
independently-useful predicate bundles, not simulations - but that call
was made without a deep look at whether keeping them is actually right,
which is why it is a separately-flagged follow-up rather than a decision
made here.

With `LineBrownPlatBehavior` gone, `MovementBehavior` has zero concrete
subclasses left in `src/`. `SuperKoopaBehavior` is the only class still
registered in `BehaviorFactory`, and its one live method
(`dropsFeather(x)`) is exactly as pure a function of its arguments as
`xShiftPx` was - it just wasn't converted in this change, to keep the
diff reviewable. **Follow-up (issue #418):** turn `SuperKoopaBehavior`
into a plain function next to `SuperKoopaAppearance`, the same move made
here for `LineBrownPlatBehavior`, and then delete `MovementBehavior`,
`BehaviorFactory`, and the now-empty `sprites/behaviors/` directory - at
that point nothing needs a `SpriteBehavior` subclass for anything beyond
the shared metadata object `BehaviorFactory`'s `default` case already
returns.

See `src/rom/model/sprites/CLAUDE.md` for the current (post-deletion)
description of the `behaviors/` layer.
