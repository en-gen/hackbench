import type { Char } from '../../chars/Char'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

const OBJ_CHAR_BASE = 0x400

/**
 * $63 Checker/Brown Platform (line-guided) — spawn-time-fixed appearance.
 *
 * InitLinePlat (bank_01.asm:11774) sets SpriteMisc1602 from spawn X bit 4:
 *   even tile col → SpriteMisc1602=$10 → checker mode → 5 big tiles, xShift=$28=40px
 *   odd tile col  → SpriteMisc1602=$00 → brown mode   → 3 big tiles, xShift=$18=24px
 *
 * CODE_01DAA2 (bank_01.asm:12323) uses SpriteMisc1602 identically to $62's
 * direction flag, so the same $18/$28 xShift values apply. Unlike $62, the
 * xShift for $63 is determined at spawn time and never changes at render time.
 * `render` therefore applies a fixed `this.xShift` rather than reading from
 * `behavior.lineGuide?.direction`.
 *
 * Tile layout — CODE_01B2DF (_1≠0 checker path, bank_01.asm:6948):
 *   5 big tiles $EA/$EB/$EB/$EB/$EC at X offsets 0/+$10/+$20/+$30/+$40 → 80px
 * Tile layout — CODE_01B2DF (_1=0 brown path, bank_01.asm:6959):
 *   3 big tiles $60/$61/$62 at X offsets 0/+$10/+$20 → 48px
 *   (slot[108] overridden $61→$62 at bank_01.asm:6977)
 */
export class LineCheckerPlatAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(
    readonly platformParts: readonly SpritePart[],
    readonly xShift: number,
    readonly width:  number,
  ) {
    this.hitRect = { dx: -xShift, dy: -8, w: width, h: 16 }
  }

  static fromTables(
    chars:       Map<number, Char>,
    palette:     number,
    charHigh:    number,
    placeholder: Char,
    checkerMode: boolean,
  ): LineCheckerPlatAppearance {
    const c = (n: number): Char =>
      chars.get(OBJ_CHAR_BASE + charHigh + (n & 0x1FF)) ?? placeholder

    const slots = checkerMode
      ? [0xEA, 0xEB, 0xEB, 0xEB, 0xEC] as const
      : [0x60, 0x61, 0x62]             as const

    const parts: SpritePart[] = []
    for (let s = 0; s < slots.length; s++) {
      const base = slots[s]
      const sdx  = s * 16
      parts.push(
        { char: c(base),        palette, flipX: false, flipY: false, dx: sdx,     dy: 0 },
        { char: c(base + 1),    palette, flipX: false, flipY: false, dx: sdx + 8, dy: 0 },
        { char: c(base + 0x10), palette, flipX: false, flipY: false, dx: sdx,     dy: 8 },
        { char: c(base + 0x11), palette, flipX: false, flipY: false, dx: sdx + 8, dy: 8 },
      )
    }
    return new LineCheckerPlatAppearance(
      parts,
      checkerMode ? 0x28 : 0x18,
      checkerMode ? 80   : 48,
    )
  }

  render(
    ctx:    RenderContext,
    target: RenderTarget,
    x:      number,
    y:      number,
  ): void {
    for (const part of this.platformParts) {
      const pixels = part.char.getPixels(ctx)
      const row    = ctx.palette.row(part.palette, ctx)
      target.blit8x8(
        pixels,
        { x: x + part.dx - this.xShift, y: y + part.dy - 8 },
        row, part.flipX, part.flipY,
      )
    }
  }
}
