/**
 * The synthetic cart's ids 31, 32 and 103 (the line-guided grinder): see the Ids list in syntheticSpriteRom.ts.
 * Split out to keep that file under the content gate's byte-token limit. Hand-written test opcodes; the
 * id 103 handler has the opcode SKELETON of the vanilla grinder's (operands that name a label are free), which
 * is what `grinderDrawsBeforeSnap` reads.
 */
import type { SyntheticOptions } from './syntheticSpriteRom'

/** `drawSub`: the shared one-piece draw routine, ending in RTS. */
export function putGrinderRoutines(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
  drawSub: number[],
): void {
  // id 31: draw one 16x16 piece at the sprite's X, THEN move X by +4, as the grinder's MAIN draws before its line step.
  const move = [0xb5, 0xe4, 0x18, 0x69, 0x04, 0x95, 0xe4, 0x60]
  put(0x019300, [...drawSub.slice(0, -1), ...move])
  put(0x019290, move)
  // id 32: as 31 but draws only from its second MAIN ($1650,X counts MAINs), so its first draw is on pass 1.
  put(
    0x0192a0,
    [
      0xfe, 0x50, 0x16, 0xbd, 0x50, 0x16, 0xc9, 0x02, 0x90, 0x03, 0x20, 0x00, 0x94, 0x4c, 0x90,
      0x92,
    ],
  )
  // The draw subroutine; id 103 may draw on its first MAIN only (count in $1650,X).
  put(0x019400, [
    ...(o.grinderDrawsOnce
      ? [0xfe, 0x50, 0x16, 0xbd, 0x50, 0x16, 0xc9, 0x02, 0x90, 0x01, 0x60]
      : []),
    ...drawSub,
  ])
  put(0x019282, [0x6b])
  put(0x019280, [0x60])
  // id 103 handler: LineGrinder's 17 shape bytes (TrueFrame/SpriteLock test, sound, JMP), then the dispatch block of
  // CODE_01D9A7 around its draw JSR and the JMP to the line step; the step here is the +4 move.
  put(
    0x019200,
    [
      0xa5, 0x13, 0x29, 0x07, 0x1d, 0x26, 0x16, 0x05, 0x9d, 0xd0, 0x05, 0xa9, 0x00, 0x8d, 0xf9,
      0x1d, 0x4c, 0x20, 0x92,
    ],
  )
  put(0x019220, [0xb5, 0x9e, 0xc9, o.alteredGrinder ? 0x63 : 0x64, 0xf0, 0x30, 0xc9, 0x65, 0x90, 0x30, 0xc9, 0x68, 0xd0, 0x05, 0x20, 0x00, 0x86, 0x80, 0x07, 0xc9, 0x67, 0xd0, 0x08, 0x20, 0x00, 0x94, 0x20, 0x80, 0x92, 0x80, 0x07, 0x20, 0x80, 0x92, 0x22, 0x82, 0x92, 0x01, 0x4c, 0x90, 0x92]) // prettier-ignore
}
