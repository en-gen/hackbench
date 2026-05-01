// Consumes: (none directly — palette via mapStore)

import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { Char } from '../../chars/Char'

/**
 * Sprite $99 (Volcano Lotus).
 *
 * VolcanoLotusGfx (bank_02.asm:12711) writes 4 OAM entries:
 *   - 2 x 16x16 head big-tiles (base char $CE, OBJ palette 5 = CGRAM row 13);
 *     left at dx=-8 unflipped, right at dx=+8 flipped.
 *   - 2 x 8x8 flower chars from VolcanoLotusTiles (bank_02.asm:12708)
 *     = { $8E, $9E, $E2 } indexed by SpriteMisc1602.
 *     Left at dx=0, right at dx=+8 (base+1).
 *
 * In-game, CODE_02DFC9 (bank_02.asm:12666) sets SpriteMisc1602 each game
 * frame from bit 3 of the decrementing $1540 timer: LSR #3; AND #$01.
 * $1540 decrements every game frame, so bit 3 flips every 8 game frames --
 * meaning the flower holds $8E for 8 frames, $9E for 8 frames, and so on.
 *
 * The editor's tile-animation tick is 8 / NTSC_FPS * 1000 = approx 133ms
 * (ANIM_INTERVAL_MS in AnimationLoader.ts) -- one editor tick is exactly
 * 8 SNES game frames. So advancing the flower by one frame per editor
 * tick matches the ASM cadence exactly: idle 8 game frames, blink 8
 * game frames. The canvas redraws at rAF rate (60fps), but the flower
 * frame index only changes on tick -- render reads the same value for ~8
 * redraws before it changes.
 *
 * Head parts render first (behind), flower parts render on top.
 */
export class VolcanoLotusAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private frame = 0

  constructor(
    readonly headParts: readonly SpritePart[],
    readonly flowerFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
  ) {
    this.hitRect = partsHitRect([
      ...headParts,
      ...flowerFrames[0],
      ...flowerFrames[1],
    ])
  }

  tickAnimation(): void {
    this.frame = (this.frame + 1) % this.flowerFrames.length
  }

  render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    const blit = (part: SpritePart) => {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    for (const part of this.headParts) blit(part)
    for (const part of this.flowerFrames[this.frame]) blit(part)
  }

  /**
   * Head: 2 x 16x16 big-tile $CE (charHigh 1, OBJ palette 5 = CGRAM row 13).
   * Flower: 2-frame blink between $8E and $9E (charHigh 1, OBJ palette 4 = row 12).
   */
  static fromTables(chars: Map<number, Char>, placeholder: Char): VolcanoLotusAppearance {
    const OBJ_BASE   = 0x400
    const HEAD_PAL   = 13
    const FLOWER_PAL = 12
    const c = (n: number) => chars.get(OBJ_BASE + (n & 0x1FF)) ?? placeholder
    const bigTile = (baseTile: number, bdx: number, bdy: number, flipX: boolean): SpritePart[] => {
      const co  = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
      const dxo = [0, 8, 0, 8]
      const dyo = [0, 0, 8, 8]
      return co.map((off, i) => ({
        char: c(0x100 + baseTile + off),
        palette: HEAD_PAL, flipX, flipY: false,
        dx: bdx + dxo[i], dy: bdy + dyo[i],
      }))
    }
    const flowerPair = (baseTile: number): SpritePart[] => [
      { char: c(0x100 + baseTile),     palette: FLOWER_PAL, flipX: false, flipY: false, dx: 0, dy: -1 },
      { char: c(0x100 + baseTile + 1), palette: FLOWER_PAL, flipX: false, flipY: false, dx: 8, dy: -1 },
    ]
    const headParts: SpritePart[] = [
      ...bigTile(0xCE, -8, -1, false),
      ...bigTile(0xCE,  8, -1, true),
    ]
    const flowerFrames: [SpritePart[], SpritePart[]] = [
      flowerPair(0x8E),
      flowerPair(0x9E),
    ]
    return new VolcanoLotusAppearance(headParts, flowerFrames)

  }
}
