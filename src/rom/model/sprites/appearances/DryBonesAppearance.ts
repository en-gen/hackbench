import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $30 (Dry Bones – throws bones) and $32 (Dry Bones – stays on ledge).
 *
 * DryBonesAndBeetle (bank_01.asm:13520) dispatches to CODE_03C3DA
 * (bank_03.asm:7831), which writes two 16×16 big-tiles from DryBonesTiles:
 *   top tile $64 (state 0 anim 0) at InitDryBones-shifted dx
 *   bottom tile $66 at (0, 0)
 *
 * InitDryBones is FaceMario: SpriteMisc157C = SubHorizPos's Y at spawn.
 *   SubHorizPos Y = 0 → Mario is right of (or at) sprite → flipX, topDx = +8
 *   SubHorizPos Y = 1 → Mario is left of sprite           → no flip, topDx = -8
 *
 * Sprite $31 (Bony Beetle) shares the same handler entry but diverts at
 * CODE_03C3DA via CMP #$31 BEQ → GenericSprGfxRt2 — it stays on the
 * generic SpriteFactory path.
 *
 * Extends StaticSpriteAppearance → serializes as { kind:'static' }, no
 * changes to serialize.ts / rehydrate.ts needed.
 */
export class DryBonesAppearance extends StaticSpriteAppearance {
  /**
   * @param palette   8 + ((Sprite166EVals[id] >> 1) & 0x07)
   * @param charHigh  0x100 when Sprite166EVals[id] & 0x01, else 0
   * @param faceRight true when marioStartPx.x >= spritePx (SubHorizPos Y = 0)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    palette: number,
    charHigh: number,
    faceRight: boolean,
  ): DryBonesAppearance {
    const OBJ_BASE = 0x400
    const flipX    = faceRight
    const topDx    = faceRight ? 8 : -8
    const bigTile  = (baseTile: number, bdx: number, bdy: number): SpritePart[] => {
      // SNES 16×16 OBJ: base N → [N, N+1, N+$10, N+$11] at (0,0),(8,0),(0,8),(8,8).
      // flipX reverses column order AND flips each 8×8.
      const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
      return co.map((off, i) => ({
        char: chars.get(OBJ_BASE + charHigh + ((baseTile + off) & 0x1FF)) ?? placeholder,
        palette, flipX, flipY: false,
        dx: bdx + [0, 8, 0, 8][i], dy: bdy + [0, 0, 8, 8][i],
      }))
    }
    const parts: SpritePart[] = [
      ...bigTile(0x64, topDx, -16),  // top body
      ...bigTile(0x66, 0,     0),    // bottom body
    ]
    return new DryBonesAppearance(parts)
  }
}
