import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $9B (Hammer Brother). Static parts plus a periodic flipX toggle.
 *
 * In-game (bank_02.asm), Hammer Bro's facing direction is the bit-5 value
 * of `SpriteMisc1570`. Misc1570 increments 3 of every 4 game frames at
 * ~60 Hz (≈45 increments/sec), so bit 5 flips every 32 increments
 * ≈ 711 ms.
 *
 * spriteAnimTimer fires at 125 ms, so a tick is ~7.5 game frames. With
 * the 3-of-4 cadence that's ≈5.6 increments per tick; rounded to 6, bit 5
 * flips every 32/6 ≈ 5.3 ticks ≈ 666 ms — within ~6% of the in-game rate.
 */
export class HammerBroAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private misc1570 = 0
  private prevBit5 = 0
  private flipped = false

  constructor(readonly parts: readonly SpritePart[]) {
    this.hitRect = partsHitRect(parts)
  }

  tickAnimation(): void {
    this.misc1570 = (this.misc1570 + 6) & 0xFF
    const bit5 = (this.misc1570 >> 5) & 1
    if (bit5 !== this.prevBit5) {
      this.prevBit5 = bit5
      this.flipped = !this.flipped
    }
  }

  render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    // When flipped, mirror each 8×8 part horizontally around the hitRect
    // center: a part at left edge `dx` reflects to `2*L + W - 8 - dx`,
    // where L = hitRect.dx and W = hitRect.w.
    const reflectAxis = 2 * this.hitRect.dx + this.hitRect.w - 8
    for (const part of this.parts) {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      const fx = this.flipped ? !part.flipX : part.flipX
      const dx = this.flipped ? reflectAxis - part.dx : part.dx
      target.blit8x8(pixels, { x: x + dx, y: y + part.dy }, row, fx, part.flipY)
    }
  }
}
