/**
 * Ids 34, 35 and 36 of the synthetic cart, the probes of the runner's draw-position sample (#842). Id 34 draws,
 * moves X by +4, and draws again; ids 35 and 36 each write OAM-range memory the runner's draw-position filter
 * must ignore, then move X by +4, then draw, so the draw position is the one after the move.
 * Ids 37-40 are the at-rest draw-origin probes of #1131: draw then move by ($0E, $0F), move then draw, lift Y
 * around the draw, and lift Y around the draw then move X.
 * Split from syntheticSpriteRom.ts to keep that file under the content gate's byte-token limit. Hand-written
 * with its own one-piece draw (not the shared `draw` of syntheticSpriteRom.ts, which the older ids use).
 */
import { OP, word } from './asm65'

/** One 16x16 piece at the sprite's screen position, tile $24, attribute $0A, size byte 2; ends in RTS. */
const DRAW: number[] = [
  OP.LDY_ABS, ...word(0x15ea),
  OP.LDA_IMM, 0x24, OP.STA_ABSY, ...word(0x0302), OP.LDA_IMM, 0x0a, OP.STA_ABSY, ...word(0x0303),
  OP.SEC, OP.LDA_DPX, 0xd8, OP.SBC_DP, 0x1c, OP.STA_ABSY, ...word(0x0301),
  OP.SEC, OP.LDA_DPX, 0xe4, OP.SBC_DP, 0x1a, OP.STA_ABSY, ...word(0x0300),
  OP.STY_DP, 0x00, OP.LDA_DP, 0x00, OP.LSR_A, OP.LSR_A, OP.TAY, OP.LDA_IMM, 1, OP.INC_A, OP.STA_ABSY, ...word(0x0460), OP.RTS,
] // prettier-ignore
/** X += 4 (the low byte, as the older ids do). */
const MOVE4: number[] = [OP.INC_DPX, 0xe4, OP.INC_DPX, 0xe4, OP.INC_DPX, 0xe4, OP.INC_DPX, 0xe4]

/** X += $0E and Y += $0F (the low bytes; the probes' seeds keep both small and positive). */
const MOVEV: number[] = [
  OP.LDA_DP, 0x0e, OP.CLC, OP.ADC_DPX, 0xe4, OP.STA_DPX, 0xe4,
  OP.LDA_DP, 0x0f, OP.CLC, OP.ADC_DPX, 0xd8, OP.STA_DPX, 0xd8,
] // prettier-ignore

export function putDrawPosProbes(put: (snes: number, bytes: number[]) => void): void {
  // 34: the first OAM write is at the old X, the last at the new one.
  put(0x019780, [...DRAW.slice(0, -1), ...MOVE4, ...DRAW])
  // 35 writes $0380 while $15E9 names another slot (restored after).
  put(0x019700, [OP.LDA_IMM, 0x0f, OP.STA_ABS, ...word(0x15e9), OP.STA_ABS, ...word(0x0380), OP.STX_ABS, ...word(0x15e9), ...MOVE4, ...DRAW]) // prettier-ignore
  // 36 writes $0400, in the gap the capture's filter excludes ($0400-$041F), with $15E9 = the slot.
  put(0x019740, [OP.STA_ABS, ...word(0x0400), ...MOVE4, ...DRAW])
  // 37 draws, then moves by ($0E, $0F) px (#1131); 38 moves, then draws.
  put(0x01a900, [...DRAW.slice(0, -1), ...MOVEV, OP.RTS])
  put(0x01a980, [...MOVEV, ...DRAW])
  // 39 lifts Y by 16, draws, and puts Y back, as a taller sprite's draw routine does; 40 then also moves X by +4.
  const yBy16 = (op: number) => Array.from({ length: 16 }, () => [op, 0xd8]).flat()
  const lifted = [...yBy16(OP.DEC_DPX), ...DRAW.slice(0, -1), ...yBy16(OP.INC_DPX)]
  put(0x01aa00, [...lifted, OP.RTS])
  put(0x01aa80, [...lifted, ...MOVE4, OP.RTS])
}
