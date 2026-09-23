// Consumes: (none directly - palette via mapStore, char pixels via Char.getPixels)

import type { SpriteTileTables } from '../../../SpriteTileLoader'
import { SPRITE_ANIM_FRAME_STRIDE as TICK_ROM_FRAMES } from '../../../timing'
import type { Char } from '../../chars/Char'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $4D/$4E Monty Mole - two-frame emerging pose and an emerged-pose ghost
 * annotation. The detection-zone overlay that used to live here was
 * removed with the path and movement overlays; see
 * docs/sprites/sprite-overlay-removal.md.
 *
 * Full ROM derivation, measured evidence scopes, and the two judgement
 * calls (why the ghost gets its own render pass, why the cadence constant
 * is 7.5) live in docs/sprites/sprite-4d-monty-mole.md. Handler `MontyMole`,
 * bank_01.asm:13330.
 */

const OBJ_CHAR_BASE = 0x400

/**
 * `SubSprGfx2Entry1` sets the OBJ size bit (bank_01.asm:4179-4181), so
 * big-tile N covers [N, N+1, N+$10, N+$11].
 */
const CORNER_OFFSET = [0x00, 0x01, 0x10, 0x11] as const
const SUB_DX = [0, 8, 0, 8] as const
const SUB_DY = [0, 0, 8, 8] as const

function bigTileParts(
  chars: Map<number, Char>,
  baseTile: number,
  palette: number,
  charHigh: number,
  placeholder: Char,
): SpritePart[] {
  return [0, 1, 2, 3].map(c => ({
    char:
      chars.get(OBJ_CHAR_BASE + charHigh + ((baseTile + CORNER_OFFSET[c]) & 0x1ff)) ?? placeholder,
    palette,
    flipX: false,
    flipY: false,
    dx: SUB_DX[c],
    dy: SUB_DY[c],
  }))
}

/** SpriteMisc1602 per animation frame - DATA_01E35F (bank_01.asm:13407). */
export const MOLE_TILE_FRAMES = [0x01, 0x02] as const
/** _5 (GeneralSprGfxProp group) per animation frame - DATA_01E361 (bank_01.asm:13410). */
export const MOLE_PROP_GROUPS = [0x00, 0x05] as const

/**
 * Emerged pose index: state 2, `CODE_01E37F` (bank_01.asm:13426-13429),
 * drawn through `SubSprGfx2Entry1`, which indexes SprTilemap by
 * SpriteMisc1602 with no shift (bank_01.asm:4154-4159).
 *
 * Vanilla resolves it to big-tile $86. Which of the four emerged frames
 * best identifies the sprite was a human visual judgement by the user,
 * not an ASM claim. Frame table in docs/sprites/sprite-4d-monty-mole.md.
 */
export const EMERGED_MISC1602 = 0x02

/**
 * One sprite height up, so the ghost clears the mound. An editor layout
 * choice, NOT a ROM apex: the real emerge height comes out of the `#$B0`
 * launch speed (bank_01.asm:13367-13368) against runtime gravity, which
 * is not simulated here.
 *
 * Deliberately NOT clamped at row 0. 4 of 176 measured placements sit
 * there and get the ghost clipped away by `CanvasRenderTarget.blit8x8`.
 * Clamping would park the ghost on top of the mound, destroying the one
 * thing the annotation is for - telling the two poses apart. A clipped
 * annotation degrades to the pre-annotation behaviour; an overlapping
 * one is worse than nothing.
 */
export const EMERGED_DY = -16

/**
 * Ghost alpha: the house "drawn for you, not actually there" value, same
 * as `InvisibleBlockRevealBehavior`.
 */
export const EMERGED_ALPHA = 0.5

/** `EffFrame >> 4 & 1` (bank_01.asm:13392-13397): 16 game frames per pose. */
export const ANIM_ROM_FRAMES = 16
export const ANIM_CYCLE_ROM_FRAMES = ANIM_ROM_FRAMES * 2

/**
 * Game frames per editor tick, from the one shared stride so retuning the
 * cadence cannot leave this stale.
 *
 * Was 7.5, which converted the interval the editor ASKED for while the
 * interval it REALIZED was display-dependent. The shared frame clock
 * realizes 8 game frames exactly on any display, so the two agree.
 * docs/sprites/sprite-4d-monty-mole.md predates the clock on this point.
 */
export const ROM_FRAMES_PER_TICK = TICK_ROM_FRAMES

export class MontyMoleAppearance extends StaticSpriteAppearance {
  /** Stand-in for `EffFrame`, advanced in fractional game frames per tick. */
  private romFrame = 0

  /**
   * Covers the mound AND the lifted ghost. The mound is anonymous dirt
   * and the ghost is the only recognisable mole artwork on screen, so
   * clicking or hovering it has to select the sprite rather than fall
   * through to the L1 tile behind it. The ghost is still an annotation:
   * it has no identity of its own, and `Sprite.pickAt` returns the one
   * mole whichever half was hit.
   */
  override readonly hitRect: HitRect

  /**
   * `emergedParts` is the ghost pose, already expanded to four 8x8 parts.
   * Empty = no annotation.
   */
  constructor(
    readonly parts0: readonly SpritePart[],
    readonly parts1: readonly SpritePart[],
    readonly emergedParts: readonly SpritePart[] = [],
  ) {
    super(parts0)
    this.hitRect = partsHitRect([
      ...parts0,
      ...emergedParts.map(p => ({ ...p, dy: p.dy + EMERGED_DY })),
    ])
  }

  /**
   * Single-frame construction for $4E: shares the class, not the pose, and
   * gets NO annotation. $4E reaches the same emerged
   * draw path, but its resting pose is modelled from the wrong routine
   * today (SPRITE_GFX_OVERRIDES in SpriteTileLoader.ts marks it 'sub0'
   * and documents that as known-wrong; bank_01.asm:13420 puts $4E on
   * SubSprGfx2Entry1). Annotating a pose we draw wrong would mislead.
   * Wiring it up after that fix is a one-liner.
   */
  static fromParts(parts: readonly SpritePart[]): MontyMoleAppearance {
    return new MontyMoleAppearance(parts, parts, [])
  }

  /** Build both SubSprGfx0 frames for $4D straight from the ROM tables. */
  static fromTables(
    chars: Map<number, Char>,
    tables: SpriteTileTables,
    placeholder: Char,
  ): MontyMoleAppearance {
    const attr = tables.spriteAttr[0x4d] ?? 0
    const palette = 8 + ((attr >> 1) & 0x07)
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    const base = tables.tilemapOffset[0x4d] ?? 0

    const makeParts = (animFrame: number, propGroup: number): SpritePart[] =>
      [0, 1, 2, 3].map(corner => {
        const tileByte = tables.tilemap[base + animFrame * 4 + corner] ?? 0
        const gfxFlags = tables.gfxProp[propGroup * 4 + corner] ?? 0
        return {
          char: chars.get(OBJ_CHAR_BASE + charHigh + (tileByte & 0x1ff)) ?? placeholder,
          palette,
          flipX: (gfxFlags & 0x40) !== 0,
          flipY: (gfxFlags & 0x80) !== 0,
          dx: tables.dispX[corner] ?? 0,
          dy: tables.dispY[corner] ?? 0,
        }
      })

    // Same SpriteOBJAttribute,X byte both draw paths read (bank_01.asm:
    // 3870 vs 4169); InitMontyMole (bank_01.asm:730-734) writes only
    // SpriteMisc151C and no emerged state overrides the attribute, so the
    // ghost shares the mound's palette and char-high.
    const emergedTile = tables.tilemap[base + EMERGED_MISC1602] ?? 0

    return new MontyMoleAppearance(
      makeParts(MOLE_TILE_FRAMES[0], MOLE_PROP_GROUPS[0]),
      makeParts(MOLE_TILE_FRAMES[1], MOLE_PROP_GROUPS[1]),
      bigTileParts(chars, emergedTile, palette, charHigh, placeholder),
    )
  }

  override tickAnimation(): void {
    // Wrap on the full cycle so the accumulator stays bounded. Both 7.5
    // and 32 are exact multiples of 0.5, so the modulo introduces no drift.
    this.romFrame = (this.romFrame + ROM_FRAMES_PER_TICK) % ANIM_CYCLE_ROM_FRAMES
  }

  /** `LDA EffFrame : LSR x4 : AND #$01` (bank_01.asm:13392-13397). */
  private get frame(): 0 | 1 {
    return (Math.floor(this.romFrame / ANIM_ROM_FRAMES) & 1) as 0 | 1
  }

  /** The animated mound pose. The ghost is static and does not use this. */
  private activeParts(): readonly SpritePart[] {
    return this.frame === 0 ? this.parts0 : this.parts1
  }

  override render(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    for (const p of this.activeParts()) {
      target.blit8x8(
        p.char.getPixels(),
        { x: x + p.dx, y: y + p.dy },
        mapStore.palette.row(p.palette),
        p.flipX,
        p.flipY,
      )
    }
  }

  /**
   * Editor annotation: a ghost of the emerged mole above the mound.
   *
   * The reason is IDENTITY, not occlusion. $4D's resting pose is an
   * anonymous pile of rubble, so the editor shows the user what is buried
   * there. The in-place rubble is correct and, on everything measured,
   * unoccluded: 176 $4D/$4E instances across four ROMs (vanilla, Grand
   * Poo World 2, Seven_Vanilla_Levels, Invictus), none with an L1
   * priority subtile in the sprite's cell or the ghost's. Method and
   * scope in docs/sprites/sprite-4d-monty-mole.md.
   *
   * It runs in the above-L1 pass so the annotation's legibility does not
   * depend on what the author put in that cell. On today's evidence that
   * is observationally identical to appending these parts to `render`;
   * the pass is the annotation seam, not a fix for a measured burial.
   *
   * Limitation, documented rather than fixed: the pass does not test
   * whether anything actually occludes the sprite, so an author who puts
   * a priority tile in the cell above a mole gets the ghost drawn over
   * legitimate foreground. No measured placement does this, so occlusion
   * logic would be mechanism with nothing to act on.
   *
   * Static, never animated: the mound already toggles on its own
   * 16-game-frame cycle and a level can hold a dozen moles.
   *
   * Facing is not modelled. `SubSprGfx2Entry1` takes X-flip from
   * SpriteMisc157C (bank_01.asm:4166-4171), which `FaceMario`
   * (bank_01.asm:13373) sets at runtime, so the ROM has no static facing
   * to be faithful to. The composite is mirror-symmetric in sprite set 5
   * only - which covers every vanilla placement, but not most hack ones.
   */
  override renderAboveL1(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    for (const p of this.emergedParts) {
      target.blit8x8(
        p.char.getPixels(),
        { x: x + p.dx, y: y + EMERGED_DY + p.dy },
        mapStore.palette.row(p.palette),
        p.flipX,
        p.flipY,
        EMERGED_ALPHA,
      )
    }
  }
}
