import type { SpriteBehavior } from '../SpriteBehavior'

/**
 * Behavior for the Super Koopa family ($71, $72, $73).
 *
 * $71 - red cape, straight flight. InitSuperKoopa (bank_01.asm:797) calls
 *       FaceMario and sets YSpeed=$28. Never drops a feather
 *       (Sprite1686Vals[$71]=$10, TweakerE bit 6 clear).
 *
 * $72 - yellow cape, straight flight. Shares InitSuperKoopa. Never drops a
 *       feather (Sprite1686Vals[$72]=$10, TweakerE bit 6 clear).
 *
 * $73 - yellow cape, swooping. InitSuperKoopaFthr (bank_01.asm:802) reads
 *       SpriteXPosLow & $10 - when bit 4 is SET, it overwrites TweakerE to
 *       $10 (bit 6 cleared, no feather) and TweakerA to $10 (stompable).
 *       When bit 4 is CLEAR the init falls through, leaving TweakerE at its
 *       default Sprite1686Vals[$73]=$50 (bit 6 set) - this is the instance
 *       that drops a feather on stomp. The game visually distinguishes the
 *       feather-dropping instance with a flashing red/yellow cape.
 *
 * Feather spawn path - CODE_01A95D (bank_01.asm:5574):
 *   LDA SpriteTweakerE,X / AND #$40 / BEQ ...     ; bit 6 gates the drop
 *   CPY #$72 / BCC ...                             ; sprite < $72 falls back
 *   JSL CODE_02EAF2 (bank_02.asm:14193)            ; spawns sprite $77
 */
export class SuperKoopaBehavior implements SpriteBehavior {
  readonly kind: string
  displayName?: string
  spawns?: number
  isGenerator?: boolean
  reactRangeDy?: number

  constructor(readonly spriteId: number) {
    this.kind = `sprite_${spriteId.toString(16)}`
  }

  /**
   * Whether this instance drops a Cape Feather ($77) when stomped, based on
   * the spawn X position. Re-evaluates when the sprite is moved, so the
   * editor always reflects post-move state.
   */
  dropsFeather(spritePx: number): boolean {
    if (this.spriteId !== 0x73) return false
    return (spritePx & 0x10) === 0
  }
}
