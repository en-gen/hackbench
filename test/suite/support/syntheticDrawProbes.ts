/**
 * Ids 35 and 36 of the synthetic cart: each writes OAM-range memory the runner's draw-position filter
 * must ignore, then moves X by +4, then draws, so the draw position is the one after the move.
 * Split from syntheticSpriteRom.ts to keep that file under the content gate's byte-token limit.
 */
export function putDrawPosProbes(
  put: (snes: number, bytes: number[]) => void,
  ownDraw: number[],
): void {
  const move4 = [0xb5, 0xe4, 0x18, 0x69, 0x04, 0x95, 0xe4]
  // 35 writes $0380 while $15E9 names another slot (restored after).
  put(0x019700, [0xa9, 0x0f, 0x8d, 0xe9, 0x15, 0x8d, 0x80, 0x03, 0x8e, 0xe9, 0x15, ...move4, ...ownDraw]) // prettier-ignore
  // 36 writes $0400, in the gap the capture's filter excludes ($0400-$041F), with $15E9 = the slot.
  put(0x019740, [0x8d, 0x00, 0x04, ...move4, ...ownDraw])
}
