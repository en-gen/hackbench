/**
 * ROM-byte clean-up (#1082): ExecutePtr, CallSpriteInit and the grinder's entry are recognized by RUNNING them on the
 * 65816 core, not by a hash of 27, 8 and 17 bytes (fewer than 24 unknown bytes each). The block spawn's dispatcher,
 * free-slot search and status write are one contiguous hashed span. Every check here is proven able to fail on a
 * planted defect; the synthetic half needs no ROM, the vanilla half proves the real build is accepted.
 */
import { describe, expect, it } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import {
  grinderDrawsBeforeSnap,
  VANILLA_DISPATCH,
} from '../../../../src/rom/sprites/interp/LineGuided'
import {
  BLOCK_SPAWN_DISPATCHER,
  checkExecutePtr,
  resolveBlockSpawn,
  resolveLoop,
  resolvePointer,
  resolveTables,
  spanMask,
} from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import {
  GRINDER_DISPATCH,
  GRINDER_DISPATCH_AT,
  GRINDER_HANDLER,
} from '../../support/syntheticGrinder'
import {
  buildSyntheticRom,
  SYNTHETIC_DISPATCHER as SYN,
  SYNTHETIC_EXECUTE_PTR_CODE as EXEC,
} from '../../support/syntheticSpriteRom'

const EXEC_AT = 0x0086fa
const CALL = [[0xfa, 0x86, 0x00]]
const INIT_AT = 0x018170
const SPAWN_AT = 0x0288dc
const flip = (rom: RomFile, at: number) => void rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 1])
const tablesReason = (rom: RomFile) => {
  const t = resolveTables(rom)
  return t.ok ? null : t.reason
}
const execReason = (rom: RomFile) => {
  const r = checkExecutePtr(rom, CALL)
  return r.ok ? null : r.reason
}

describe('ExecutePtr is run, not hashed (synthetic cart)', () => {
  it('accepts the cart 16-bit pointer-table jump', () => {
    expect(execReason(buildSyntheticRom())).toBeNull()
    expect(tablesReason(buildSyntheticRom())).toBeNull()
  })

  // Each defect edits the cart routine (offsets into SYNTHETIC_EXECUTE_PTR_CODE) and must be refused.
  it.each([
    ['the index is not doubled (ASL -> NOP)', 10, [0xea]],
    ['the index is masked to zero (AND #$0000)', 8, [0x00]],
    ['Y is not restored (LDY dp -> NOPs)', 25, [0xea, 0xea]],
    ['the return address is not fully popped (PLA -> NOP)', 13, [0xea]],
    ['the table is read one byte early (INY -> NOP)', 18, [0xea]],
  ] as const)('refuses a routine where %s', (_name, off, bytes) => {
    const rom = buildSyntheticRom()
    rom.writeAt(EXEC_AT + off, [...bytes])
    expect(execReason(rom)).toMatch(/16-bit ExecutePtr/)
    expect(tablesReason(rom)).toMatch(/16-bit ExecutePtr/)
  })

  it('refuses a routine that ignores the table and always jumps to one place', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(EXEC_AT, [0x5c, 0x00, 0x90, 0x7e, ...new Array(EXEC.length - 4).fill(0xea)]) // JML $7E9000
    expect(execReason(rom)).toMatch(/16-bit ExecutePtr/)
  })

  it('refuses a routine that never jumps (budget) and one that runs off ROM', () => {
    const loop = buildSyntheticRom()
    loop.writeAt(EXEC_AT, [0x80, 0xfe]) // BRA -2
    expect(execReason(loop)).toMatch(/16-bit ExecutePtr/)
    const off = buildSyntheticRom()
    off.writeAt(EXEC_AT, [0x5c, 0x00, 0x00, 0x7f]) // JML $7F0000: WRAM is not code
    expect(execReason(off)).toMatch(/16-bit ExecutePtr/)
  })

  it('refuses a routine that writes a hardware register on the way', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(EXEC_AT, [0x8d, 0x00, 0x21, ...EXEC]) // STA $2100, then the working routine
    expect(execReason(rom)).toMatch(/16-bit ExecutePtr/)
  })

  it('still refuses calls that do not reach the same routine, or do not reach ROM', () => {
    const rom = buildSyntheticRom()
    expect(checkExecutePtr(rom, [[0xfa, 0x86, 0x00], [0xfb, 0x86, 0x00]])).toMatchObject({ ok: false, reason: expect.stringMatching(/same routine/) }) // prettier-ignore
    expect(checkExecutePtr(rom, [[0x00, 0x00, 0x7e]])).toMatchObject({ ok: false, reason: expect.stringMatching(/does not reach ROM/) }) // prettier-ignore
  })
})

describe('CallSpriteInit is run, not hashed (synthetic cart)', () => {
  it('accepts the cart, and reads the INIT table from the call frame', () => {
    expect(resolveTables(buildSyntheticRom())).toMatchObject({ ok: true, tables: { initTable: 0x01817c } }) // prettier-ignore
  })

  it('follows the table when the routine is one byte longer: nothing assumes its length', () => {
    const rom = buildSyntheticRom()
    const code = [...rom.readAt(INIT_AT, 12)!]
    const tbl = [...rom.readAt(INIT_AT + 12, 402)!]
    rom.writeAt(INIT_AT, [0xea, ...code])
    rom.writeAt(INIT_AT + 13, tbl)
    expect(resolveTables(rom)).toMatchObject({ ok: true, tables: { initTable: 0x01817d } })
  })

  // Offsets into the cart CallSpriteInit: LDY #imm (0..1), TYA, STA abs,X (3..5), LDA dp,X (6..7), JSL (8..11).
  it.each([
    ['a different run status', 1, [0x09]],
    ['the status goes to another cell', 4, [0xc9]],
    ['the sprite number is read without X', 6, [0xa5]],
    ['the sprite number is read from another cell', 7, [0x9f]],
    ['the status is not written (STA -> NOPs)', 3, [0xea, 0xea, 0xea]],
    ['the JSL goes to another routine', 9, [0xfb]],
  ] as const)('refuses an INIT where %s', (_name, off, bytes) => {
    const rom = buildSyntheticRom()
    rom.writeAt(INIT_AT + off, [...bytes])
    expect(tablesReason(rom)).toMatch(/CallSpriteInit is not/)
  })

  it('refuses an INIT that writes anything besides the status', () => {
    const rom = buildSyntheticRom()
    // LDY #8, TYA, STA $14C8,X, STA $14C9,X, LDA $9E,X, JSL: one write too many, the table moves by three.
    const code = [
      0xa0, 0x08, 0x98, 0x9d, 0xc8, 0x14, 0x9d, 0xc9, 0x14, 0xb5, 0x9e, 0x22, 0xfa, 0x86, 0x00,
    ]
    const tbl = [...rom.readAt(INIT_AT + 12, 402)!]
    rom.writeAt(INIT_AT, code)
    rom.writeAt(INIT_AT + 15, tbl)
    expect(tablesReason(rom)).toMatch(/CallSpriteInit is not/)
    // The same routine without the extra write is accepted, so the extra write is what is refused.
    rom.writeAt(INIT_AT, [0xa0, 0x08, 0x98, 0x9d, 0xc8, 0x14, 0xea, 0xea, 0xea, 0xb5, 0x9e, 0x22, 0xfa, 0x86, 0x00]) // prettier-ignore
    expect(tablesReason(rom)).toBeNull()
  })
})

describe('the grinder entry is run, not hashed (synthetic cart)', () => {
  const verdict = (rom: RomFile) => grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)

  it('accepts the cart', () => {
    expect(verdict(buildSyntheticRom())).toBe(true)
  })

  it.each([
    ['returns at once (RTS)', [0x60]],
    ['loops (BRA -2)', [0x80, 0xfe]],
    ['jumps elsewhere than the dispatch block', [0x4c, 0x01, 0x92]],
    // LDA $9D / BNE +3 / JMP dispatch / JMP elsewhere: zero WRAM lands on the dispatch, all-set WRAM does not.
    [
      'reaches the dispatch block on one of the two seeds only',
      [0xa5, 0x9d, 0xd0, 0x03, 0x4c, 0x20, 0x92, 0x4c, 0x01, 0x92],
    ],
  ] as const)('refuses an entry that %s', (_name, bytes) => {
    const rom = buildSyntheticRom()
    rom.writeAt(GRINDER_HANDLER, [...bytes])
    expect(verdict(rom)).toBe(false)
  })

  it('still gates on the dispatch block at the landing address', () => {
    const rom = buildSyntheticRom()
    flip(rom, GRINDER_DISPATCH_AT)
    expect(verdict(rom)).toBe(false)
  })
})

describe('the block spawn span (synthetic cart)', () => {
  it('is one 81-byte span with seven masked operands, 74 hashed, like the real one', () => {
    for (const span of [SYN, BLOCK_SPAWN_DISPATCHER]) {
      expect(span.length).toBe(81)
      expect(spanMask(span)).toHaveLength(7)
    }
  })

  it('a flip at every hashed offset is refused, at every operand offset is not', () => {
    const masked = spanMask(SYN)
    const wrong: number[] = []
    for (let i = 0; i < SYN.length; i++) {
      const rom = buildSyntheticRom()
      flip(rom, SPAWN_AT + i)
      const r = resolveBlockSpawn(rom, SYN)
      const refusedAsBuild = !r.ok && /not a build/.test(r.reason)
      if (masked.includes(i) ? refusedAsBuild : !refusedAsBuild) wrong.push(i)
    }
    expect(wrong).toEqual([])
  })
})

describe.skipIf(!hasRom(VANILLA))('the vanilla ROM', () => {
  const loopOf = (rom: RomFile) => resolveLoop(rom) as { handle: number }

  it('is accepted by every reader', () => {
    const rom = freshRom()
    const t = resolveTables(rom, loopOf(rom).handle)
    if (!t.ok) throw new Error(t.reason)
    expect(resolveBlockSpawn(rom).ok).toBe(true)
    const p = resolvePointer(rom, t.tables.mainTable, 0x67)
    if (!p.ok) throw new Error('pointer')
    expect(grinderDrawsBeforeSnap(rom, p.handler.address, VANILLA_DISPATCH)).toBe(true)
  })

  it('block spawn span: a flip at every hashed offset is refused, at every operand offset is not', () => {
    const masked = spanMask(BLOCK_SPAWN_DISPATCHER)
    const { callAt } = BLOCK_SPAWN_DISPATCHER
    const wrong: number[] = []
    for (let i = 0; i < BLOCK_SPAWN_DISPATCHER.length; i++) {
      const rom = freshRom()
      flip(rom, SPAWN_AT + i)
      // The three JSL operand bytes are masked from the hash but checked as the call, so they are refused too.
      const expectRefused = !masked.includes(i) || (i >= callAt && i < callAt + 3)
      if (!resolveBlockSpawn(rom).ok !== expectRefused) wrong.push(i)
    }
    expect(wrong).toEqual([])
  })

  it('a changed first instruction of ExecutePtr or CallSpriteInit is refused', () => {
    const rom0 = freshRom()
    const h = rom0.readAt(0x018127 + 13, 3)!
    const ep = (h[2]! << 16) | (h[1]! << 8) | h[0]!
    const w = rom0.readAt(0x018127 + 18, 2)!
    const initEntry = 0x010000 | (w[0]! | (w[1]! << 8))
    for (const [at, why] of [
      [ep, /16-bit ExecutePtr/],
      [initEntry, /CallSpriteInit is not/],
    ] as const) {
      const rom = freshRom()
      flip(rom, at)
      const t = resolveTables(rom, loopOf(rom).handle)
      expect(!t.ok && why.test(t.reason), `flip at $${at.toString(16)}`).toBe(true)
    }
  })
})
