/**
 * `readLevelBgMode` (src/rom/BgMode.ts): the BG mode the level loader sets, and
 * whether the path that reaches it is intact. Synthetic fixtures run without a
 * ROM; the corpus cases pin what each cart reads as.
 */
import { describe, it, expect } from 'vitest'
import { readLevelBgMode, ROUTINE_SPAN } from '../../../src/rom/BgMode'
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
const jsr = (target: number) => [0x20, target & 0xff, target >> 8]

describe('the level BG mode (synthetic)', () => {
  it('reads modes 0-7 from the ORA operand, and its layer 3 priority twin', () => {
    for (let mode = 0; mode < 8; mode++)
      for (const operand of [mode, mode | 8]) {
        const r = readLevelBgMode(bgModeRom(operand))
        // Only mode 1 is the order the view stacks; every other is a reasoned "no".
        expect(r.ok, `operand ${operand}`).toBe(mode === 1)
        if (!r.ok) expect(r.reason).toContain(`BG mode ${mode}`)
      }
  })

  it.each([
    ['no write', [SET_AT, new Array(10).fill(0)], /MainBGMode write is not found/],
    ['two writes', [SET_AT + 0x40, setBytes()], /MainBGMode write is found more than once/],
    ['no call', [CALL_AT, new Array(13).fill(0)], /call into the header routine is not found/],
    ['two calls', [CALL_AT + 0x40, CALL_BYTES], /call into the header routine is found more than once/], // prettier-ignore
    ['no IRQ copy', [IRQ_AT, [0, 0, 0, 0, 0]], /IRQ copy of MainBGMode is not found/],
    ['two IRQ copies', [IRQ_AT + 0x40, IRQ_BYTES], /IRQ copy of MainBGMode is found more than once/], // prettier-ignore
    // The corpus hacks: the JSR pair is intact, the LDA after it is a JSL.
    ['a hooked tail', [CALL_AT + 6, [0x22, 0x00, 0x80, 0x00]], /code after LoadLevel's call is replaced/], // prettier-ignore
  ] as const)('%s is unverified, with its own reason', (_, run, reason) => {
    expect(unverified(bgModeRom(1, [run[0], [...run[1]]]))).toMatch(reason)
  })

  it('the call must lead to the write, with the edge of the routine span exact', () => {
    const entry = SET_AT & 0xffff // the write's own address in its bank
    const at = (target: number) => unverified(bgModeRom(1, [CALL_AT, jsr(target)]))
    expect(at(entry - ROUTINE_SPAN + 1)).toBeNull() // the farthest entry still ahead of it
    expect(at(entry - ROUTINE_SPAN)).toMatch(/call into the header routine is not found/)
    expect(at(entry)).toBeNull() // the write is the entry itself
    expect(at(entry + 1)).toMatch(/call into the header routine is not found/) // the entry is past it
  })

  it('every pinned byte of the three runs is needed: flipping any one is unverified', () => {
    // Free by design: the mode operand, the second JSR's operand, the CMP immediate and the BEQ
    // displacement. The STA dp is pinned through the IRQ copy that must name it.
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
        expect(unverified(bgModeRom(1, [at + k, [b ^ 0xff]])), `${name} byte ${k}`).not.toBeNull()
        flipped++
      })
    expect(flipped).toBe(10 - 1 + 13 - 4 + 5) // the sweep reached every pinned byte
  })

  it('a free position can change without losing the reading', () => {
    expect(readLevelBgMode(bgModeRom(1, [CALL_AT + 10, [0x0b]], [CALL_AT + 12, [0x20]]))).toEqual({ ok: true, mode: 1 }) // prettier-ignore
  })
})

// Stock vanilla and the magic-edited ROM read mode 1. The four hacks hook LoadLevel's code after
// the call, so they are unverified with that reason (measured 2026-10-04; docs/rom/bg-mode.md).
describe.each(CORPUS)('the level BG mode (%s)', name => {
  it.skipIf(!hasRom(name))('reads as expected for this cart', () => {
    const r = readLevelBgMode(RomFile.load(romPath(name)))
    if ([VANILLA, MAGIC].includes(name)) expect(r).toEqual({ ok: true, mode: 1 })
    else expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/code after LoadLevel's call is replaced/) }) // prettier-ignore
  })
})
