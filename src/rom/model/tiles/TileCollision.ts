/**
 * Per-tile collision classification - STRICTLY derived from SMW's
 * disassembly. Exposes BOTH sprite-perspective and Mario-perspective
 * fields so consumers can pick the view that matches their query:
 *
 *   - Sprite-perspective consumers read the sprite fields: they need to
 *     match `CODE_01928E` / `CODE_0192C9` behavior at runtime. Today that
 *     is the `sprites/behaviors/` simulators (via `solidityFromL1`) and
 *     `SmwMap.renderSpriteOverlays`'s `getL1` closure. The sprite overlays
 *     that used to be the visible consumer (KoopaWalk patrol, HopFlame
 *     bounce, CheepCheep arc) were removed; see
 *     `docs/sprites/sprite-overlay-removal.md`.
 *   - Editor overlays ("Show surfaces", "Show walls") read the Mario
 *     fields - the designer wants to see what the player experiences.
 *
 * Both perspectives are still needed: dropping the sprite fields would
 * make the behavior simulators wrong, not just less decorated.
 *
 * ------------------------------------------------------------------
 * Sprite-perspective fields
 * ------------------------------------------------------------------
 *
 *   floor       Top face is landable by sprites. `CODE_01933B`
 *               (bank_01.asm:2705) reached from landing path
 *               `CODE_0192C9` Y=2 via `CODE_019310`. Covers the FULL
 *               CODE_01933B path - all four branches:
 *                 <$11    semi-solid via `CODE_0193B0` sub-pixel gate
 *                         (mushroom platforms, vines, ropes).
 *                 $11-$6D full solid.
 *                 $6E-$D7 slope-angle table `CODE_00FA19`, called
 *                         unconditionally for the entire range (no
 *                         DATA_00EAC1 gate - that table is buoyancy only).
 *                 >=$D8   solid.
 *               `floor` alone is the authoritative "sprite-landable"
 *               predicate; `slopeTable` is no longer needed for this.
 *
 *   ceiling     Bottom face is bonkable by sprites. `CODE_0192C9` Y=3
 *               (bank_01.asm:2659-2668):
 *                 $11-$6D full solid.
 *                 $C4-$C9 tileset-gated window (disabled for tilesets
 *                         0/7 per bank_05.asm:323).
 *               Everything else: not solid from below.
 *
 *   wall        Horizontal collision - sprite approaching from either
 *               side is blocked. `CODE_01928E` (bank_01.asm:2613-2635).
 *               Low byte $11-$6D, excluding coin / vine / empty per
 *               `DATA_00F05C` / `CODE_00F17F` block-behavior filter.
 *
 * ------------------------------------------------------------------
 * Mario-perspective fields
 * ------------------------------------------------------------------
 *
 * A Mario-surface is a tile that ALWAYS stops Mario's movement
 * regardless of tileset or state. Tileset-dependent and pure
 * pass-through tiles are excluded via `isMarioStandable`; spike ($2F)
 * is INCLUDED since the sprite-range collision arrests Mario's
 * velocity universally (the `HurtMario` damage side-effect is
 * orthogonal to whether he stands on the tile).
 *
 * Derivation (no Mario-physics dispatch - static subset):
 *   marioFloor   = (floor || slopeTable) && isMarioStandable(low)
 *   marioCeiling =  ceiling              && isMarioStandable(low)
 *   marioWall    =  wall                 && isMarioStandable(low)
 *
 * `marioFloor` includes slope tiles (Mario lands at slope angle via
 * `CODE_00FA19`), while sprite-side `floor` does not - slopes route
 * through a separate dispatch at the sprite layer. See
 * `isMarioStandable` in `BlockBehaviorLoader.ts` for the ASM-cited
 * exclusion list.
 *
 * ------------------------------------------------------------------
 * Slope membership
 * ------------------------------------------------------------------
 *
 *   slopeTable  `DATA_00EAC1` membership (bank_00.asm:11946) via
 *               `CODE_00F04D` (bank_00.asm:12730-12741). 26-entry
 *               table used by the **sprite buoyancy check**
 *               (`CODE_019211`, bank_01.asm:2555) - not the landing
 *               path. The landing path (`CODE_01933B`) does not consult
 *               this table. Field retained for reference; Phase 4 will
 *               remove it once all consumers migrate to `floor`.
 *
 *   slope       Mario-side slope surface profile from
 *               `resolveSlope` in `src/rom/SlopeResolver.ts`. Present
 *               when the tile's acts-like low byte is in `$6E..$D7`
 *               and the per-tileset `SlopesPtr`-indexed map yields a
 *               valid slope index (`CODE_00ED86`, bank_00.asm:12334).
 *               Absent for non-slope tiles. The 16-byte `heights`
 *               array is the ROM's `DATA_00E632` surface profile
 *               consumed by the "Show surfaces" overlay to draw a
 *               pixel-accurate diagonal polyline.
 *
 * All boolean fields default `false` for tiles built without a
 * classification pass (test fixtures / pre-rehydration cells); `slope`
 * defaults `undefined`.
 *
 * See `COLLISION.md` (this directory) for the design rationale,
 * consumer guide, and phase roadmap.
 */
import type { SlopeInfo } from '../../SlopeResolver'

export interface TileCollision {
  // Sprite perspective - matches `CODE_01928E` / `CODE_0192C9`.
  readonly floor: boolean
  readonly ceiling: boolean
  readonly wall: boolean

  // Mario perspective - "tiles that always stop Mario's movement".
  readonly marioFloor: boolean
  readonly marioCeiling: boolean
  readonly marioWall: boolean

  // DATA_00EAC1 membership - sprite buoyancy table (CODE_019211 water check),
  // NOT the landing table. Kept for reference; use `floor` for landability.
  readonly slopeTable: boolean

  // Mario-side slope surface profile (CODE_00ED86 / DATA_00E632).
  readonly slope?: SlopeInfo
}

export const NO_COLLISION: TileCollision = {
  floor: false,
  ceiling: false,
  wall: false,
  marioFloor: false,
  marioCeiling: false,
  marioWall: false,
  slopeTable: false,
}
