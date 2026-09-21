// Consumes: (none)

import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { SpriteAppearance, HitRect } from '../SpriteAppearance'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteBehavior } from '../SpriteBehavior'
import type { Char } from '../../chars/Char'
import type { SpriteTileTables } from '../../../SpriteTileLoader'

const OBJ_BASE = 0x400
const CORNER_OFFSETS = [0x00, 0x01, 0x10, 0x11] as const
// EffFrame >> 3 & 1 - toggles every 8 game frames (bank_02.asm:8079-8083)
const ANIM_TICKS = 8

export class SpikeTopAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private tick = 0
  private frame = 0

  constructor(
    readonly parts0: readonly SpritePart[],
    readonly parts1: readonly SpritePart[],
  ) {
    this.hitRect = partsHitRect(parts0)
  }

  /**
   * Build both animation frames from the ROM tile tables.
   *
   * Direction is HARDCODED to 0, which is why both flips are false:
   * DATA_02BCC7[0]=$00. It is not always 0 in game - a Spike Top that
   * spawns with Mario to its left starts at direction 4 and is drawn
   * X-flipped. Trace, and the fix available from marioStartPx, in
   * docs/sprite-overlay-removal.md, "ROM evidence that went with the
   * overlays".
   *
   * Frame 0: SprTilemap[tilemapBase + 0], Frame 1: SprTilemap[tilemapBase + 1].
   * Both frames expand to four 8×8 corners via the SNES large-OBJ layout
   * [N, N+1, N+$10, N+$11] (bank_01.asm:4148 SubSprGfx2Entry1).
   */
  static fromTables(
    chars: Map<number, Char>,
    tables: SpriteTileTables,
    placeholder: Char,
  ): SpikeTopAppearance {
    const attr = tables.spriteAttr[0x2e] ?? 0
    const palette = 8 + ((attr >> 1) & 0x07)
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    const tilemapBase = tables.tilemapOffset[0x2e] ?? 0

    const makeParts = (animOffset: number): SpritePart[] =>
      CORNER_OFFSETS.map((co, corner) => {
        const baseTile = tables.tilemap[tilemapBase + animOffset] ?? 0
        return {
          char: chars.get(OBJ_BASE + charHigh + ((baseTile + co) & 0x1ff)) ?? placeholder,
          palette,
          flipX: false,
          flipY: false,
          dx: tables.dispX[corner] ?? 0,
          dy: tables.dispY[corner] ?? 0,
        }
      })

    return new SpikeTopAppearance(makeParts(0), makeParts(1))
  }

  tickAnimation(): void {
    if (++this.tick >= ANIM_TICKS) {
      this.tick = 0
      this.frame ^= 1
    }
  }

  render(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    for (const p of this.frame === 0 ? this.parts0 : this.parts1) {
      target.blit8x8(
        p.char.getPixels(),
        { x: x + p.dx, y: y + p.dy },
        mapStore.palette.row(p.palette),
        p.flipX,
        p.flipY,
      )
    }
  }
}
