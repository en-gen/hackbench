// Consumes: mapStore.marioSpawnX (facing, via SpriteFactory at build time)

import type { Char } from '../../chars/Char'
import type { RgbaColor } from '../../../GraphicsDecoder'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteTileTables } from '../../../SpriteTileLoader'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import { SPRITE_ANIM_FRAME_STRIDE as ROM_FRAMES_PER_TICK } from '../../../timing'
import {
  MAGIKOOPA_PALS,
  compositeDynPalRow,
  dynPalFirstCol,
  dynPalRow,
  dynPalToRgba,
} from '../../palette/DynSpritePalette'

/**
 * Sprite $1F (Magikoopa), state 2 only: the visible cast cycle.
 *
 * `Magikoopa` (bank_01.asm:8413) dispatches on `SpriteTableC2 & 3`; state 2 is
 * `CODE_01BE6E` (bank_01.asm:8493), which draws a 16x32 body through
 * `SubSprGfx1` plus an 8x8 wand. States 1 and 3 are a teleport fade the editor
 * has no frame clock for, but they are where $1F's colours come from: the fade
 * leaves a runtime palette in CGRAM $F0..$F7 that state 2 never overwrites, so
 * this appearance composites over the level's row 15 instead of using it.
 *
 * In game that CGRAM write is global. Here the splice is applied per sprite,
 * inside render, so the other nine OBJ-palette-7 sprites ($6D, $6E, $6F, $AF,
 * $B0, $C5, $C6, $F6, $F8) keep the level's static row. Deliberate editor
 * convention, and a known divergence from post-fade hardware: see the doc.
 *
 * Dispatch table, tile selection, anchoring, the pose formula, the bob and wand
 * gates, and the whole CGRAM story are derived in docs/sprite-1f-magikoopa.md.
 */

const OBJ_BASE = 0x400

/** DATA_01BE69 (bank_01.asm:8487, ROM $01:BE69) - pose base per `timer >> 6`. */
const POSE_BASE = [0x04, 0x02, 0x00] as const

/** Largest timer `POSE_BASE` is defined for: `$BF >> 6` is its last index. */
const MAX_POSE_TIMER = (POSE_BASE.length << 6) - 1

/** DATA_01BE6C (bank_01.asm:8490, ROM $01:BE6C) - wand dx per SpriteMisc157C. */
const WAND_DX = [0x10, -0x08] as const

/** `LDA #$99` at bank_01.asm:8570, ROM $01:BF04 - the 8x8 wand/magic char. */
const WAND_TILE = 0x99

/** Wand Y is `_1 + $10` (`ADC #$10`, bank_01.asm:8560). */
const WAND_DY = 0x10

/** SpriteMisc1540 on entry to state 2: `LDA #$70`, bank_01.asm:8729, ROM $01:C022. */
export const STATE2_TIMER_START = 0x70

/**
 * SpriteMisc1602 for a given state-2 timer value (CODE_01BE96,
 * bank_01.asm:8513-8528): `POSE_BASE[timer >> 6] | ((timer >> 3) & 1)`.
 *
 * Throws outside $00..$BF rather than returning `undefined | bit`, which would
 * coerce to just the bit and render a pose that no timer value produces.
 * Exported so the test can sweep the countdown rather than spot-check.
 */
export function misc1602ForTimer(timer: number): number {
  if (timer < 0 || timer > MAX_POSE_TIMER) {
    throw new RangeError(`Magikoopa state-2 timer out of range: ${timer}`)
  }
  return POSE_BASE[timer >> 6] | ((timer >> 3) & 0x01)
}

/**
 * Does this SpriteMisc1602 value nudge the TOP tile down one pixel?
 * bank_01.asm:8530-8539, `SBC #$02 : CMP #$02 : BCC + : LSR : BCC +`.
 */
export function topTileBobs(misc1602: number): boolean {
  const d = (misc1602 - 0x02) & 0xFF
  return d >= 0x02 && (d & 0x01) === 1
}

/** Is the wand drawn? bank_01.asm:8545-8547, `CMP #$04 : BCC Return01BF15`. */
export function wandVisible(misc1602: number): boolean {
  return misc1602 >= 0x04
}

/**
 * SpriteMisc1602 values reachable in state 2, in countdown order. The timer
 * enters at STATE2_TIMER_START, so `timer >> 6` only ever yields 1 then 0.
 * `frames[v - FRAME_BASE]` is the part list for value v.
 */
export const STATE2_MISC1602_VALUES = [0x02, 0x03, 0x04, 0x05] as const
const FRAME_BASE = STATE2_MISC1602_VALUES[0]

export class MagikoopaAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  /** Fractional SpriteMisc1540; counts down from $70 and wraps (state 2 restart). */
  private timer = STATE2_TIMER_START

  /** `dynColors` as RGBA, precomputed once. */
  private readonly dynRgba: RgbaColor[]

  /** Reused composite row, so render() allocates nothing. */
  private readonly rowScratch: RgbaColor[] = []

  /**
   * @param frames    One part list per entry of STATE2_MISC1602_VALUES, in that order.
   * @param dynColors MagiKoopaPals resting entry as raw BGR555 words, read from
   *                  the cart. Empty means the read failed, in which case the
   *                  level's static row is used unchanged.
   */
  constructor(
    readonly frames: readonly (readonly SpritePart[])[],
    readonly dynColors: readonly number[] = [],
  ) {
    this.hitRect = partsHitRect(frames.flat())
    this.dynRgba = dynPalToRgba(dynColors)
  }

  /**
   * @param faceRight SubHorizPos Y = 0, i.e. Mario is at or right of the sprite.
   *                  State 2 recomputes this every frame (bank_01.asm:8496-8498);
   *                  the editor pins it to Mario's spawn side, as $30/$91 do.
   */
  static fromTables(
    chars: Map<number, Char>,
    tables: SpriteTileTables,
    placeholder: Char,
    faceRight: boolean,
    dynColors: readonly number[] = [],
  ): MagikoopaAppearance {
    const SPRITE_ID    = 0x1F
    const attr         = tables.spriteAttr[SPRITE_ID] ?? 0
    const palette      = 8 + ((attr >> 1) & 0x07)
    const charHigh     = (attr & 0x01) !== 0 ? 0x100 : 0
    const tilemapBase  = tables.tilemapOffset[SPRITE_ID] ?? 0
    // SubSprGfx1 X-flips when SpriteMisc157C bit 0 is CLEAR (bank_01.asm:3957-3962).
    const flipX        = faceRight
    const misc157C     = faceRight ? 0 : 1

    const char = (tile: number): Char =>
      chars.get(OBJ_BASE + charHigh + (tile & 0x1FF)) ?? placeholder

    // SNES large-OBJ: base N -> [N, N+1, N+$10, N+$11] at (0,0),(8,0),(0,8),(8,8).
    // An X-flipped entry swaps the columns AND mirrors each 8x8 char.
    const bigTile = (baseTile: number, dy: number): SpritePart[] => {
      const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
      return co.map((off, i) => ({
        char:  char(baseTile + off),
        palette,
        flipX,
        flipY: false,
        dx: [0, 8, 0, 8][i],
        dy: dy + [0, 0, 8, 8][i],
      }))
    }

    const frames = STATE2_MISC1602_VALUES.map(misc1602 => {
      const idx    = (tilemapBase + misc1602 * 2) & 0xFF
      const top    = tables.tilemap[idx]     ?? 0
      const bottom = tables.tilemap[idx + 1] ?? 0
      const parts: SpritePart[] = []
      // The wand goes to OAM slot +$108, behind the body's slots +$100/+$104,
      // so it must blit first for the body to cover it.
      if (wandVisible(misc1602)) {
        parts.push({
          char: char(WAND_TILE), palette, flipX, flipY: false,
          dx: WAND_DX[misc157C], dy: WAND_DY,
        })
      }
      parts.push(...bigTile(top, topTileBobs(misc1602) ? 1 : 0))
      parts.push(...bigTile(bottom, 0x10))
      return parts
    })

    return new MagikoopaAppearance(frames, dynColors)
  }

  tickAnimation(): void {
    this.timer -= ROM_FRAMES_PER_TICK
    if (this.timer < 0) this.timer += STATE2_TIMER_START + 1
  }

  render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    const misc1602 = misc1602ForTimer(Math.floor(this.timer))
    const frame    = this.frames[misc1602 - FRAME_BASE]
    // No silent fallback: a missing frame means `frames` was not built from
    // STATE2_MISC1602_VALUES, and frames[0] would render a pose the timer
    // never selects rather than surfacing that.
    if (!frame) {
      throw new RangeError(
        `Magikoopa frame missing for SpriteMisc1602 $${misc1602.toString(16)} ` +
        `(have ${this.frames.length} frames from $${FRAME_BASE.toString(16)})`,
      )
    }
    for (const p of frame) {
      target.blit8x8(
        p.char.getPixels(),
        { x: x + p.dx, y: y + p.dy },
        this.rowFor(p.palette, mapStore),
        p.flipX,
        p.flipY,
      )
    }
  }

  /**
   * The level row, with the runtime-uploaded colours spliced back in.
   *
   * The row test is not decorative: CODE_01C028 writes only CGRAM $F0..$F7, so
   * a part on any other OBJ palette must get the level's row untouched. Every
   * part `fromTables` builds is on row 15, but `frames` is constructor-supplied
   * and rehydrate.ts carries a per-part palette, so a part on another row is
   * representable and must not be recoloured.
   */
  private rowFor(palette: number, mapStore: MapStore): RgbaColor[] {
    const base = mapStore.palette.row(palette)
    if (this.dynRgba.length === 0 || palette !== dynPalRow(MAGIKOOPA_PALS)) return base
    return compositeDynPalRow(base, this.dynRgba, dynPalFirstCol(MAGIKOOPA_PALS), this.rowScratch)
  }
}
