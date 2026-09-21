// Consumes: (none directly - palette via mapStore)

import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { Char } from '../../chars/Char'

/**
 * Sprite $9C (Hammer Brother Platform / Flying Block Platform).
 *
 * FlyingPlatformGfx (bank_02.asm:12216) writes 4 OAM entries, split into
 * a static platform body and an animated 2-frame wing pair:
 *
 *   Frame 0 (EffFrame bit 3 = 0):
 *     big-tile $40 at ( 0,   0)  -- platform left
 *     big-tile $40 at (+16,  0)  -- platform right
 *     big-tile $C6 at (-14, -10)  flipX  -- left wing
 *     big-tile $C6 at (+30, -10)         -- right wing
 *
 *   Frame 1 (EffFrame bit 3 = 1):
 *     big-tile $40 at ( 0,   0)  -- platform left (same)
 *     big-tile $40 at (+16,  0)  -- platform right (same)
 *     8x8 tile $5D at ( -6,  -2)  flipX  -- left wing
 *     8x8 tile $5D at (+30,  -2)          -- right wing
 *
 * All tiles use OBJ palette 1 (attr $32 & $0F = $02 -> CGRAM row 9), charHigh 0.
 */
export class HammerBroPlatformAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private frame = 0

  constructor(
    readonly platformParts: readonly SpritePart[],
    readonly wingFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
  ) {
    this.hitRect = partsHitRect([...platformParts, ...wingFrames[0], ...wingFrames[1]])
  }

  tickAnimation(): void {
    this.frame = (this.frame + 1) % this.wingFrames.length
  }

  render(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    for (const part of this.platformParts) {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    for (const part of this.wingFrames[this.frame]) {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }

  /**
   * Builds $9C's own visual parts (2 static turn-blocks + 2 animated wing
   * frames) from FlyingPlatformGfx. Palette 9 / charHigh 0 come from
   * hardcoded attr $32 -- independent of Sprite166EVals.
   */
  static fromTables(chars: Map<number, Char>, placeholder: Char): HammerBroPlatformAppearance {
    const PAL = 9
    const OBJ_BASE = 0x400
    const c = (n: number) => chars.get(OBJ_BASE + (n & 0x1ff)) ?? placeholder
    const bigTile = (baseTile: number, dx: number, dy: number, flipX = false): SpritePart[] => {
      const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
      const dxo = [0, 8, 0, 8]
      const dyo = [0, 0, 8, 8]
      return co.map((off, i) => ({
        char: c(baseTile + off),
        palette: PAL,
        flipX,
        flipY: false,
        dx: dx + dxo[i],
        dy: dy + dyo[i],
      }))
    }
    const smallTile = (tile: number, dx: number, dy: number, flipX = false): SpritePart => ({
      char: c(tile),
      palette: PAL,
      flipX,
      flipY: false,
      dx,
      dy,
    })
    const platformParts: SpritePart[] = [...bigTile(0x40, 0, 0), ...bigTile(0x40, 16, 0)]
    const frame0: SpritePart[] = [
      ...bigTile(0xc6, -14, -10, true),
      ...bigTile(0xc6, 30, -10, false),
    ]
    const frame1: SpritePart[] = [smallTile(0x5d, -6, -2, true), smallTile(0x5d, 30, -2, false)]
    return new HammerBroPlatformAppearance(platformParts, [frame0, frame1])
  }
}
