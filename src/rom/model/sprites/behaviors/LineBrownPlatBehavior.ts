import { MovementBehavior, type BehaviorMeta } from '../MovementBehavior'

/**
 * $62 Brown Platform (line-guided) movement behavior.
 *
 * InitLinePlat (bank_01.asm:11774) reads bit 4 of SpriteXPosLow,
 * XORs with 1, and stores the result in SpriteMisc1602:
 *   bit4 clear (even-col spawn) → SpriteMisc1602=$10 → forward  → xShift=$28=40px
 *   bit4 set   (odd-col spawn)  → SpriteMisc1602=$00 → reverse  → xShift=$18=24px
 *
 * CODE_01DAA2 (bank_01.asm:12323) uses SpriteMisc1602 before calling
 * CODE_01B2DF: X -= xShift, Y -= $08. CODE_01B2DF (_1=0 path,
 * bank_01.asm:6913) then places 3 big-tiles at slot-X offsets 0/+$10/+$20
 * with base chars $60/$61/$62.
 *
 * The resolved direction lives in `behavior.lineGuide.direction` (set by
 * `resolveLineGuideAttachment` at level-load time). `xShiftPx` converts
 * that to the pixel shift so the Appearance doesn't embed the ASM constant.
 */
export class LineBrownPlatBehavior extends MovementBehavior {
  readonly kind = 'line_brown_plat'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /**
   * X shift from sprite spawn position to the left edge of the 3-tile strip.
   * CODE_01DAA2: SpriteMisc1602=$10 (forward) → _0=$28=40px;
   *              SpriteMisc1602=$00 (reverse)  → _0=$18=24px.
   */
  static xShiftPx(direction: 'forward' | 'reverse'): number {
    return direction === 'forward' ? 0x28 : 0x18
  }
}
