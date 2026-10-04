/**
 * `readLevelBgMode` (src/rom/BgMode.ts): the BG mode the level loader sets, and
 * whether the path that reaches it is intact. Synthetic fixtures run without a
 * ROM; the corpus case at the end reports what each cart reads as.
 */
import { describe, it, expect } from 'vitest'
import { readLevelBgMode } from '../../../src/rom/BgMode'
import { RomFile } from '../../../src/rom/RomFile'
import { CORPUS, MAGIC, VANILLA, hasRom, romPath } from '../support/corpus'
import {
  bgModeRom,
  CALL_AT,
  CALL_BYTES,
  IRQ_AT,
  IRQ_BYTES,
  SET_AT,
  setBytes,
} from '../support/bgModeRom'

const unverified = (rom: RomFile) => {
  const r = readLevelBgMode(rom)
  return r.ok ? null : r.reason
}

describe('the level BG mode (synthetic)', () => {
  it('reads modes 0-7 from the ORA operand, and its layer 3 priority twin', () => {
    for (let mode = 0; mode < 8; mode++)
      for (const operand of [mode, mode | 8]) {
        const r = readLevelBgMode(bgModeRom(operand))
        // Only mode 1 is the order the view stacks; every other is a reasoned "no".
        expect(r.ok, `operand ${operand}`).toBe(mode === 1)
        if (!r.ok) expect(r.reason).toContain(`BG mode ${mode}`)
      }
    expect(readLevelBgMode(bgModeRom(9))).toEqual({ ok: true, mode: 1 })
  })

  it('names the missing or doubled reading, never a mode', () => {
    expect(unverified(bgModeRom(1, [SET_AT, new Array(10).fill(0)]))).toMatch(/MainBGMode write is not found/) // prettier-ignore
    expect(unverified(bgModeRom(1, [SET_AT + 0x40, setBytes()]))).toMatch(/MainBGMode write is found more than once/) // prettier-ignore
    expect(unverified(bgModeRom(1, [CALL_AT, new Array(13).fill(0)]))).toMatch(/call into the header routine is not found/) // prettier-ignore
    expect(unverified(bgModeRom(1, [CALL_AT + 0x40, CALL_BYTES]))).toMatch(/call into the header routine is found more than once/) // prettier-ignore
    expect(unverified(bgModeRom(1, [IRQ_AT, [0, 0, 0, 0, 0]]))).toMatch(/IRQ copy of MainBGMode is not found/) // prettier-ignore
    expect(unverified(bgModeRom(1, [IRQ_AT + 0x40, IRQ_BYTES]))).toMatch(/IRQ copy of MainBGMode is found more than once/) // prettier-ignore
  })

  it('refuses a call whose target does not hold the write, in or out of the routine span', () => {
    // JSR $8000: the write sits 0x568 past it, beyond the routine; JSR $8600: it sits before the entry.
    for (const target of [0x8000, 0x8600])
      expect(unverified(bgModeRom(1, [CALL_AT, [0x20, target & 0xff, target >> 8]])), `$${target.toString(16)}`).toMatch(/does not hold the MainBGMode write/) // prettier-ignore
  })

  it('every pinned byte of the three runs is needed: flipping any one is unverified', () => {
    // Positions that vary by design: the mode operand, the second JSR's operand, the CMP immediate
    // and the BEQ displacement. The STA dp is pinned through the IRQ copy that must name it.
    const free = { set: new Set([7]), call: new Set([4, 5, 10, 12]), irq: new Set<number>() }
    const runs = [
      ['set', SET_AT, setBytes()],
      ['call', CALL_AT, CALL_BYTES],
      ['irq', IRQ_AT, IRQ_BYTES],
    ] as const
    let flipped = 0
    for (const [name, at, bytes] of runs)
      bytes.forEach((b, k) => {
        if (free[name].has(k)) return
        const rom = bgModeRom(1, [at + k, [b ^ 0xff]])
        expect(unverified(rom), `${name} byte ${k}`).not.toBeNull()
        flipped++
      })
    expect(flipped).toBe(10 - 1 + 13 - 4 + 5) // the sweep reached every pinned byte
  })

  it('a free position can change without losing the reading', () => {
    expect(readLevelBgMode(bgModeRom(1, [CALL_AT + 10, [0x0b]], [CALL_AT + 12, [0x20]]))).toEqual({ ok: true, mode: 1 }) // prettier-ignore
  })
})

// The two stock-shaped ROMs read mode 1. The four hacks hook LoadLevel's entry and boss-mode
// check (JSL), so the pinned call is absent: unverified with a reason, measured 2026-10-04.
describe.each(CORPUS)('the level BG mode (%s)', name => {
  it.skipIf(!hasRom(name))('reads as expected for this cart', () => {
    const r = readLevelBgMode(RomFile.load(romPath(name)))
    if ([VANILLA, MAGIC].includes(name)) expect(r).toEqual({ ok: true, mode: 1 })
    else expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be verified/) }) // prettier-ignore
  })
})
