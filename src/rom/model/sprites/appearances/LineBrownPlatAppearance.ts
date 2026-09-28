// Consumes: (none directly - palette via mapStore)

import type { Char } from '../../chars/Char'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import type { SpritePart } from './StaticSpriteAppearance'

const OBJ_CHAR_BASE = 0x400

/**
 * X shift from sprite spawn position to the left edge of the 3-tile strip.
 *
 * InitLinePlat (bank_01.asm:11774) reads bit 4 of SpriteXPosLow, XORs with
 * 1, and stores the result in SpriteMisc1602:
 *   bit4 clear (even-col spawn) → SpriteMisc1602=$10 → forward → xShift=$28=40px
 *   bit4 set   (odd-col spawn)  → SpriteMisc1602=$00 → reverse → xShift=$18=24px
 *
 * CODE_01DAA2 (bank_01.asm:12323): SpriteMisc1602=$10 (forward) → _0=$28=40px;
 * SpriteMisc1602=$00 (reverse) → _0=$18=24px. The resolved direction lives
 * in `behavior.lineGuide.direction` (set by `resolveLineGuideAttachment` at
 * level-load time); this converts that to the pixel shift so the Appearance
 * doesn't embed the ASM constant twice.
 */
export function xShiftPx(direction: 'forward' | 'reverse'): number {
  return direction === 'forward' ? 0x28 : 0x18
}

/**
 * $62 Brown Platform (line-guided) - direction-aware appearance.
 *
 * CODE_01B2DF (bank_01.asm:6913, _1=0 path) draws 3 big-tiles at
 * slot-X offsets 0/+$10/+$20 with base chars $60/$61/$62. Before the
 * draw call, CODE_01DAA2 (bank_01.asm:12323) shifts the sprite position:
 *   X -= xShift  (40px forward / 24px reverse, from SpriteMisc1602)
 *   Y -= $08
 *
 * `render` reads `behavior.lineGuide?.direction` to pick the correct
 * xShift at draw time, so forward (even-col spawn) and reverse (odd-col
 * spawn) both land in the right position. Parts are stored at
 * platform-local coords (dx 0..40, dy 0..8); the CODE_01DAA2 shift is
 * applied in render, not baked into the parts.
 */
export class LineBrownPlatAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(
    readonly platformParts: readonly SpritePart[],
    readonly direction: 'forward' | 'reverse',
  ) {
    const xShift = xShiftPx(direction)
    this.hitRect = { dx: -xShift, dy: -8, w: 48, h: 16 }
  }

  /**
   * Build the appearance from pre-resolved palette and charHigh.
   * Parts are stored at platform-local offsets; direction determines hitRect.
   *
   * Tile layout - CODE_01B2DF _1=0 path:
   *   slot[100] = big-tile $60  →  chars $60,$61,$70,$71  at (0,0),(8,0),(0,8),(8,8)
   *   slot[104] = big-tile $61  →  chars $61,$62,$71,$72  at (16,0),(24,0),(16,8),(24,8)
   *   slot[108] = big-tile $62  →  chars $62,$63,$72,$73  at (32,0),(40,0),(32,8),(40,8)
   *     (slot[108] tile overridden from $61 → $62 at bank_01.asm:6977)
   */
  static fromTables(
    chars: Map<number, Char>,
    palette: number,
    charHigh: number,
    placeholder: Char,
    direction: 'forward' | 'reverse',
  ): LineBrownPlatAppearance {
    const c = (n: number): Char => chars.get(OBJ_CHAR_BASE + charHigh + (n & 0x1ff)) ?? placeholder

    const SLOT_BASE_CHARS = [0x60, 0x61, 0x62] as const
    const parts: SpritePart[] = []
    for (let s = 0; s < 3; s++) {
      const base = SLOT_BASE_CHARS[s]
      const sdx = s * 16
      parts.push(
        { char: c(base), palette, flipX: false, flipY: false, dx: sdx, dy: 0 },
        { char: c(base + 1), palette, flipX: false, flipY: false, dx: sdx + 8, dy: 0 },
        { char: c(base + 0x10), palette, flipX: false, flipY: false, dx: sdx, dy: 8 },
        { char: c(base + 0x11), palette, flipX: false, flipY: false, dx: sdx + 8, dy: 8 },
      )
    }
    return new LineBrownPlatAppearance(parts, direction)
  }

  render(
    target: RenderTarget,
    x: number,
    y: number,
    behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    const direction = behavior.lineGuide?.direction ?? 'reverse'
    const xShift = xShiftPx(direction)

    for (const part of this.platformParts) {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(
        pixels,
        { x: x + part.dx - xShift, y: y + part.dy - 8 },
        row,
        part.flipX,
        part.flipY,
      )
    }
  }
}
