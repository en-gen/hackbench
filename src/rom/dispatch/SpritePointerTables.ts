/**
 * The two sprite handler pointer tables, as addresses only.
 *
 * Lifted unchanged from `feature/generic-sprite-renderer`'s
 * `SpriteDrawDescriptor.ts` so the dispatch reader does not drag the rest of
 * that branch's engine along with it.
 */

/**
 * Sprite MAIN pointer table. 201 entries of 2 bytes, bank $01.
 *
 * Located the same way: entry $12 reads $F87B (`Return01F87B`) and entries
 * $00-$03 and $04-$07 form the two runs of identical pointers that
 * `CallSpriteMain` (bank_01.asm:893) shows. Base is $01:85CC.
 *
 * This is the DRAW-relevant table. A previously circulated figure of
 * $01:8183 is the INIT table misaligned by three entries.
 */
export const SPRITE_MAIN_PTR_TABLE = 0x0185cc

export const SPRITE_PTR_TABLE_COUNT = 201
