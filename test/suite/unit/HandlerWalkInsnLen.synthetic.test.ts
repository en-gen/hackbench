/**
 * Table witnesses for the `INSN_LEN` entries the palette-animation walk steps
 * over by length: the eight conditional branches, `$FC`, `$CB` and `$DB`.
 * The lengths are 65816 opcode map (hardware) facts, not ROM-derived bytes.
 * The walk-level witness is in PaletteAnimationDetect.synthetic.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { instructionLength } from '../../../src/rom/dispatch/HandlerWalk'

const FLAGS: Array<[boolean, boolean]> = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
]

describe('INSN_LEN: lengths the palette walk steps by (65816 opcode map, hardware)', () => {
  const cases: Array<[string, number, number]> = [
    ['BPL', 0x10, 2],
    ['BMI', 0x30, 2],
    ['BVC', 0x50, 2],
    ['BVS', 0x70, 2],
    ['BCC', 0x90, 2],
    ['BCS', 0xb0, 2],
    ['BNE', 0xd0, 2],
    ['BEQ', 0xf0, 2],
    ['JSR (abs,X)', 0xfc, 3],
    ['WAI', 0xcb, 1],
    ['STP', 0xdb, 1],
  ]
  it.each(cases)('%s is the same length under every M/X width', (_n, op, len) => {
    for (const [m8, x8] of FLAGS) expect(instructionLength(op, m8, x8)).toBe(len)
  })
})
