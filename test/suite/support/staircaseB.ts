/**
 * The bytes the CODE_0DC3D8 port (staircase variant B) hard-codes rather than
 * reads, so a synthetic cart must plant them for the port to draw (#762).
 * Instruction shapes and targets from SMWDisX labels, not ROM content: the
 * routine is bank_0D.asm:4933-4975; JSR targets CODE_0DA6B1 (1635),
 * CODE_0DA6BA (1642), CODE_0DA95B (1996), CODE_0DA97D (2018),
 * Sta1To6ePointer (2107), StzTo6ePointer (2112).
 */

/** [offset, opcode, operand]: INC _0 (4947), CMP #$01 (4956), BEQ Return0DC42B (4963). */
export const C3_FIXED: readonly (readonly [number, number, number])[] = [
  [22, 0xe6, 0x00],
  [39, 0xc9, 0x01],
  [55, 0xf0, 0x1a],
]

/** [offset, target]: each JSR the port models, at 4940, 4950, 4952, 4958, 4960, 4964, 4966, 4967, 4968. */
export const C3_JSRS: readonly (readonly [number, number])[] = [
  [11, 0x0da6b1],
  [27, 0x0daa0d],
  [32, 0x0da95b],
  [43, 0x0daa08],
  [50, 0x0da95b],
  [57, 0x0daa08],
  [64, 0x0da95b],
  [67, 0x0da6ba],
  [70, 0x0da97d],
]

/** Plants for a handler at `addr`: the fixed instructions and every JSR, as the port expects them. */
export function c3StructurePlants(addr: number): [number, number[]][] {
  return [
    ...C3_FIXED.map(([off, op, operand]): [number, number[]] => [addr + off, [op, operand]]),
    ...C3_JSRS.map(([off, t]): [number, number[]] => [
      addr + off,
      [0x20, t & 0xff, (t >> 8) & 0xff],
    ]),
  ]
}
