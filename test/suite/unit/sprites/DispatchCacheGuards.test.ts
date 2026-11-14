/**
 * The ExecutePtr and CallSpriteInit verdict caches (#1231) must not stand in for what their key does not cover:
 * the header map byte (read off the buffer, not the bus) and the entry. Synthetic carts, no ROM.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  checkExecutePtr,
  ENTRY,
  initTableOf,
  resolveTables,
} from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
const bytesOf = () => new Uint8Array(buildSyntheticRom().buffer)

describe('a cached verdict does not bypass the mapper refusal', () => {
  it('checkExecutePtr refuses a non-LoROM header after a cached pass', () => {
    const base = bytesOf()
    const ok = checkExecutePtr(RomFile.fromBytes('a.sfc', base.slice()), [[0xfa, 0x86, 0x00]])
    expect(ok.ok).toBe(true)
    const hi = base.slice()
    hi[0x7fd5] = 0x21
    const r = checkExecutePtr(RomFile.fromBytes('b.sfc', hi), [[0xfa, 0x86, 0x00]])
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/not LoROM/) })
  })

  it('initTableOf refuses a non-LoROM header after a cached pass', () => {
    const base = bytesOf()
    const a = RomFile.fromBytes('a.sfc', base.slice())
    const h = a.readAt(ENTRY.handleSprite, 20)!
    const m = a.readAt(0x010000 | (h[10]! | (h[11]! << 8)), 9)!
    const args = [
      0x010000 | (h[18]! | (h[19]! << 8)),
      (h[15]! << 16) | (h[14]! << 8) | h[13]!,
      { status: h[1]! | (h[2]! << 8), runStatus: h[6]!, number: m[4]! },
    ] as const
    expect(initTableOf(a, ...args)).toHaveProperty('table')
    const hi = base.slice()
    hi[0x7fd5] = 0x21
    expect(initTableOf(RomFile.fromBytes('b.sfc', hi), ...args)).toMatchObject({
      reason: expect.stringMatching(/not LoROM/),
    })
    expect(resolveTables(RomFile.fromBytes('c.sfc', hi)).ok).toBe(false)
  })
})

describe('the ExecutePtr verdict is keyed by entry', () => {
  it('a second entry on the same ROM that is not the jump is refused', () => {
    const bytes = bytesOf()
    const at = off(0x019800)
    expect(bytes[at]).toBe(0)
    bytes[at] = 0x6b // RTL: returns instead of jumping to the table
    const rom = RomFile.fromBytes('two.sfc', bytes)
    expect(checkExecutePtr(rom, [[0xfa, 0x86, 0x00]]).ok).toBe(true)
    expect(checkExecutePtr(rom, [[0x00, 0x98, 0x01]]).ok).toBe(false)
  })
})
