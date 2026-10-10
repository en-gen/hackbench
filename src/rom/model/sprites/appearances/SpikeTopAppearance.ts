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
// X flip swaps the columns of the large-OBJ block, and each 8x8 is mirrored by flipX
const FLIPPED_CORNERS = [0x01, 0x00, 0x11, 0x10] as const
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
   * Facing: InitSpikeTop (bank_01.asm:602) leaves direction $C2 = 4 when Mario
   * is strictly left of the sprite (SubHorizPos, bank_01.asm:6124), else 0.
   * The flip is DATA_02BCC7[$C2] (bank_02.asm:8051, bank_02.asm:8089) with
   * SubSprGfx2Entry1 then EORing OBJ_XFlip because $157C stays 0
   * (bank_01.asm:4166-4171). So Mario left draws UNFLIPPED and Mario right or
   * level draws X-flipped, the reverse of the table alone. Evidence scope: the
   * served interpreter, 44 vanilla placements; see docs/sprites/sprite-overlay-removal.md.
   * Y flip (bit 7) is not modelled: it is clear at both indices on vanilla.
   * Without `tables.wallFollowAttr` the flip is not modelled (false, as before).
   *
   * Frame 0: SprTilemap[tilemapBase + 0], Frame 1: SprTilemap[tilemapBase + 1].
   * Both frames expand to four 8×8 corners via the SNES large-OBJ layout
   * [N, N+1, N+$10, N+$11] (bank_01.asm:4148 SubSprGfx2Entry1); X flip mirrors the
   * columns of that block as the hardware does.
   */
  static fromTables(
    chars: Map<number, Char>,
    tables: SpriteTileTables,
    placeholder: Char,
    marioLeft = false,
  ): SpikeTopAppearance {
    const attr = tables.spriteAttr[0x2e] ?? 0
    const palette = 8 + ((attr >> 1) & 0x07)
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    const tilemapBase = tables.tilemapOffset[0x2e] ?? 0

    const flipByte = tables.wallFollowAttr?.[marioLeft ? 4 : 0]
    const flipX = flipByte !== undefined && ((flipByte ^ 0x40) & 0x40) !== 0
    const corners = flipX ? FLIPPED_CORNERS : CORNER_OFFSETS

    const makeParts = (animOffset: number): SpritePart[] =>
      corners.map((co, corner) => {
        const baseTile = tables.tilemap[tilemapBase + animOffset] ?? 0
        return {
          char: chars.get(OBJ_BASE + charHigh + ((baseTile + co) & 0x1ff)) ?? placeholder,
          palette,
          flipX,
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
