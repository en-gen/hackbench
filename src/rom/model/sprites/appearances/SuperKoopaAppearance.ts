import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { SuperKoopaBehavior } from '../behaviors/SuperKoopaBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { Char } from '../../chars/Char'

/**
 * A two-frame flap animation. flapA renders when the internal flap toggle
 * is 0, flapB when 1. Grounded poses that do not visually animate use
 * identical parts for both.
 */
export interface SuperKoopaPoseFrames {
  readonly flapA: readonly SpritePart[]
  readonly flapB: readonly SpritePart[]
}

/**
 * Super Koopa ($71/$72/$73) appearance.
 *
 * Pose selection (airborne vs grounded) is fixed at construction from the
 * factory's L1-below check. Flash state (feather-drop cape alternation) is
 * evaluated per render-frame from behavior.dropsFeather(x).
 *
 * Pose geometry is Frame 0 (bank_02.asm:14373+$00) for grounded, Frames 2
 * and 3 alternated for airborne (+$08, +$0C). Cape flash alternates the
 * palette-override value between $10 (CGRAM row 8) and $0A (CGRAM row 13)
 * per CODE_02ED3B at bank_02.asm:14434.
 *
 * Flap toggle advances on each sprite-animation tick (`tickAnimation()`),
 * matching the cadence of all other sprite-internal animations.
 */
export class SuperKoopaAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private flap = 0

  constructor(
    readonly grounded:       SuperKoopaPoseFrames,
    readonly groundedFlash:  SuperKoopaPoseFrames,
    readonly airborne:       SuperKoopaPoseFrames,
    readonly airborneFlash:  SuperKoopaPoseFrames,
    readonly isAirborne:     boolean,
  ) {
    this.hitRect = partsHitRect([
      ...grounded.flapA, ...grounded.flapB,
      ...groundedFlash.flapA, ...groundedFlash.flapB,
      ...airborne.flapA, ...airborne.flapB,
      ...airborneFlash.flapA, ...airborneFlash.flapB,
    ])
  }

  tickAnimation(): void {
    this.flap ^= 1
  }

  render(
    target:   RenderTarget,
    x:        number,
    y:        number,
    behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    const flashing = behavior instanceof SuperKoopaBehavior && behavior.dropsFeather(x)
    const pose = this.isAirborne
      ? (flashing ? this.airborneFlash : this.airborne)
      : (flashing ? this.groundedFlash : this.grounded)
    const parts = this.flap === 0 ? pose.flapA : pose.flapB
    for (const part of parts) {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }

  /**
   * Builds all four pose variants (grounded/airborne x normal/flash) from
   * the ROM tile atlas and sprite-specific attr byte.
   *
   * Per-entry routing (DATA_02EC96 byte per frame entry):
   *   bit 1 set -> palette-override path (CODE_02ED3B, bank_02.asm:14449):
   *     OR capeOverride with attr, AND $FD. capeOverride is either
   *       the static value ($71 -> $08, $72/$73 -> $04), or
   *       DATA_02ED39 $10,$0A (CGRAM row 8, 13) when SpriteMisc1534 != 0.
   *   bit 1 clear -> standard path (CODE_02ED4D, bank_02.asm:14461):
   *     OR with _5 = Sprite166EVals[id] & $0E.
   *
   * @param spriteAttrByte  tables.spriteAttr[spriteId] & 0x0F
   * @param spriteId        $71, $72, or $73
   * @param faceRight       marioStartPx.x >= spritePx
   * @param airborne        l1[s.y+1]?.[s.x] is null/undefined
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    spriteAttrByte: number,
    spriteId: number,
    faceRight: boolean,
    airborne: boolean,
  ): SuperKoopaAppearance {
    const OBJ_BASE = 0x400
    const flipX = faceRight
    const bodyAttr5 = spriteAttrByte & 0x0E
    const normalCapeOverride = spriteId === 0x71 ? 0x08 : 0x04
    const FLASH_A = 0x10
    const FLASH_B = 0x0A

    type Entry = { tile: number; size: 8 | 16; attrByte: number; dx: number; dy: number }
    const buildFrameParts = (entries: readonly Entry[], capeOverride: number): SpritePart[] => {
      const parts: SpritePart[] = []
      for (const e of entries) {
        const palOverride = (e.attrByte & 0x02) !== 0
        const finalAttr = palOverride
          ? (e.attrByte | capeOverride) & 0xFD
          : e.attrByte | bodyAttr5
        const palette = 8 + ((finalAttr >> 1) & 0x07)
        const charHigh = (finalAttr & 0x01) !== 0 ? 0x100 : 0
        const vflip = (finalAttr & 0x80) !== 0
        if (e.size === 16) {
          const co = flipX && vflip ? [0x11, 0x10, 0x01, 0x00]
                   : flipX          ? [0x01, 0x00, 0x11, 0x10]
                   : vflip          ? [0x10, 0x11, 0x00, 0x01]
                   :                  [0x00, 0x01, 0x10, 0x11]
          const dxo = [0, 8, 0, 8]
          const dyo = [0, 0, 8, 8]
          for (let i = 0; i < 4; i++) {
            parts.push({
              char: chars.get(OBJ_BASE + charHigh + ((e.tile + co[i]) & 0x1FF)) ?? placeholder,
              palette, flipX, flipY: vflip,
              dx: e.dx + dxo[i], dy: e.dy + dyo[i],
            })
          }
        } else {
          parts.push({
            char: chars.get(OBJ_BASE + charHigh + (e.tile & 0x1FF)) ?? placeholder,
            palette, flipX, flipY: vflip,
            dx: e.dx, dy: e.dy,
          })
        }
      }
      return parts
    }

    const FRAME_0: readonly Entry[] = [
      { tile: 0xC8, size:  8, attrByte: 0x03, dx:  8, dy:  0 },
      { tile: 0xD8, size:  8, attrByte: 0x03, dx:  8, dy:  8 },
      { tile: 0xD0, size:  8, attrByte: 0x03, dx: 16, dy:  8 },
      { tile: 0xE0, size: 16, attrByte: 0x00, dx:  0, dy:  0 },
    ]
    const FRAME_2: readonly Entry[] = [
      { tile: 0xE4, size:  8, attrByte: 0x03, dx:  8, dy:  3 },
      { tile: 0xE5, size:  8, attrByte: 0x03, dx: 16, dy:  3 },
      { tile: 0xF2, size:  8, attrByte: 0x01, dx: 16, dy:  8 },
      { tile: 0xE0, size: 16, attrByte: 0x01, dx:  0, dy:  0 },
    ]
    const FRAME_3: readonly Entry[] = [
      { tile: 0xF4, size:  8, attrByte: 0x03, dx:  8, dy:  3 },
      { tile: 0xF5, size:  8, attrByte: 0x03, dx: 16, dy:  3 },
      { tile: 0xF2, size:  8, attrByte: 0x01, dx: 16, dy:  8 },
      { tile: 0xE0, size: 16, attrByte: 0x01, dx:  0, dy:  0 },
    ]

    const groundedNormal = buildFrameParts(FRAME_0, normalCapeOverride)
    const grounded = { flapA: groundedNormal, flapB: groundedNormal }
    const groundedFlash = {
      flapA: buildFrameParts(FRAME_0, FLASH_A),
      flapB: buildFrameParts(FRAME_0, FLASH_B),
    }
    const airborneFrames = {
      flapA: buildFrameParts(FRAME_2, normalCapeOverride),
      flapB: buildFrameParts(FRAME_3, normalCapeOverride),
    }
    const airborneFlash = {
      flapA: buildFrameParts(FRAME_2, FLASH_A),
      flapB: buildFrameParts(FRAME_3, FLASH_B),
    }
    return new SuperKoopaAppearance(grounded, groundedFlash, airborneFrames, airborneFlash, airborne)
  }
}
