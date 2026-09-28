/**
 * The two recognized replacement decompressors (#603), on synthetic ROMs
 * only: a pointer-XOR prelude in front of the stock body, and a fast LC_LZ2
 * body entered by JSL. The pinned bytes, lengths and fingerprints are
 * restated here as literals rather than imported, so a change to the code
 * under test cannot move the test along with it.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  checkStockCompression,
  layoutArena,
  readGfxFileTable,
  readGfxPointerSites,
} from '../../../src/rom/GfxArena'
import { FAST_LCLZ2, type FastRoutine } from '../../../src/rom/GfxDecompressor'
import { readGfxFile } from '../../../src/rom/GfxLoader'
import {
  DECOMP_ENTRY,
  FAST_DIVERGENT_COMMANDS,
  PRELUDE_KEY_BYTES,
  TABLE_HI,
  TABLE_LO,
  applyWrites,
  buildCart,
  gfxPayloads,
  gfxStreams,
  plantFast,
  plantPrelude,
  xorPrelude,
} from '../support/syntheticGfxCart'
import { flip } from '../support/syntheticRom'

const PRELUDE_AT = 0x018000
const FAST_AT = 0x019000
/** The shipped fingerprinted spans: [length, SHA-256], nothing masked. */
const FAST_SPANS: [number, string][] = [
  [0x1bc, 'c70bc52376ce570eddb05c7b592d07299969079ce36efdc9fd5ceef3502a2133'],
  [0x1ab, '575f68adc5aca7ff5c7cbc1e0460dd605efc9158f8865892d4db0b846f4ad209'],
]

/** A ROM whose stored pointers are XORed with `stored`, and whose entry
 *  calls a prelude holding `key`. */
function keyedCart(key: number, stored = key): RomFile {
  const { rom } = buildCart()
  for (let i = 0; i < 50; i++) {
    rom.writeAt(TABLE_LO + i, [rom.readByte(TABLE_LO + i)! ^ (stored & 0xff)])
    rom.writeAt(TABLE_HI + i, [rom.readByte(TABLE_HI + i)! ^ (stored >> 8)])
  }
  plantPrelude(rom, PRELUDE_AT, key)
  return rom
}

/** A synthetic routine of `length` arithmetic bytes, called as the fast body. */
function fastCart(length: number, rom = buildCart().rom): { rom: RomFile; fp: string } {
  return { rom, fp: plantFast(rom, FAST_AT, length).fingerprint }
}

const decodesAll = (rom: RomFile, fast?: FastRoutine[]): boolean =>
  gfxPayloads().every((p, i) => {
    const r = readGfxFile(rom, i, fast)
    return r.ok && Buffer.compare(Buffer.from(r.bytes), Buffer.from(p)) === 0
  })

describe('pointer XOR prelude', () => {
  it('reads the key from the operand, for two different keys', () => {
    for (const key of [0x0300, 0x5aa5]) {
      const rom = keyedCart(key)
      const gate = checkStockCompression(rom)
      expect(gate.ok && gate.sites.key).toBe(key)
      expect(decodesAll(rom), `key ${key}`).toBe(true)
    }
    // Tables keyed one way and the operand another: the operand decides.
    expect(decodesAll(keyedCart(0x5aa5, 0x0300))).toBe(false)
  })

  it('refuses when any pinned prelude or entry byte is flipped', () => {
    const survived: string[] = []
    for (let i = 0; i < xorPrelude(0).length; i++) {
      if (PRELUDE_KEY_BYTES.includes(i)) continue
      const rom = keyedCart(0x0300)
      flip(rom, PRELUDE_AT + i)
      if (checkStockCompression(rom).ok) survived.push(`prelude +${i}`)
    }
    for (let i = 0; i < 5; i++) {
      const rom = keyedCart(0x0300)
      flip(rom, DECOMP_ENTRY + i)
      if (checkStockCompression(rom).ok) survived.push(`entry +${i}`)
    }
    expect(survived).toEqual([])
  })

  it('refuses in front of an unrecognized body, naming what it calls', () => {
    const rom = keyedCart(0x0300)
    fastCart(0x1bc, rom)
    const r = checkStockCompression(rom)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/calls \$019000/)
  })

  it('fails closed on an entry that is neither stock nor the prelude', () => {
    const rom = keyedCart(0x0300)
    rom.writeAt(PRELUDE_AT, [0xea]) // the JSL now lands on something else
    expect(readGfxPointerSites(rom)).toBeNull()
    expect(readGfxFileTable(rom).every(f => f.offset === null)).toBe(true)
    const r = checkStockCompression(rom)
    expect(!r.ok && r.reason).toMatch(/unrecognized entry/)
  })

  it('writes pointers the prelude reads back', () => {
    const rom = keyedCart(0x5aa5)
    const r = layoutArena(rom, gfxStreams())
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const after = applyWrites(rom, r.plan.writes)
    expect(decodesAll(after)).toBe(true)
  })
})

describe('fast LC_LZ2 body', () => {
  it('ships exactly the pinned spans', () => {
    expect(FAST_LCLZ2.map(f => [f.length, f.fingerprint])).toEqual(FAST_SPANS)
  })

  for (const [length] of FAST_SPANS) {
    it(`hashes exactly $${length.toString(16)} bytes from the JSL target`, () => {
      const { rom, fp } = fastCart(length)
      const known = [{ length, fingerprint: fp }]
      expect(checkStockCompression(rom, known)).toMatchObject({ ok: true, kind: 'fast' })
      expect(decodesAll(rom, known)).toBe(true)
      expect(decodesAll(rom)).toBe(false) // not a shipped routine
      const survived: number[] = []
      for (let i = 0; i < length; i++) {
        const mutant = fastCart(length).rom
        flip(mutant, FAST_AT + i)
        if (checkStockCompression(mutant, known).ok) survived.push(i)
      }
      expect(survived).toEqual([])
      flip(rom, FAST_AT + length) // past the span
      expect(checkStockCompression(rom, known).ok).toBe(true)
    })
  }

  it('refuses when the JSL or its RTS is flipped', () => {
    for (const at of [0, 4]) {
      const { rom, fp } = fastCart(0x1bc)
      flip(rom, DECOMP_ENTRY + 5 + at)
      expect(checkStockCompression(rom, [{ length: 0x1bc, fingerprint: fp }]).ok).toBe(false)
    }
  })

  it('works behind the prelude, with the key applied', () => {
    const { rom, fp } = fastCart(0x1bc, keyedCart(0x0300))
    expect(decodesAll(rom, [{ length: 0x1bc, fingerprint: fp }])).toBe(true)
  })

  it.each(FAST_DIVERGENT_COMMANDS)(
    'refuses %s on the fast routine and decodes it on stock',
    (_, command) => {
      const streams = gfxStreams()
      streams[0] = Uint8Array.from([0x00, 0x11, ...command, 0xff])
      const { rom, fp } = fastCart(0x1bc, buildCart({ streams }).rom)
      const known: FastRoutine[] = [{ length: 0x1bc, fingerprint: fp }]
      expect(readGfxFile(rom, 0, known).ok).toBe(false)
      expect(readGfxFile(rom, 1, known).ok).toBe(true)
      expect(readGfxFile(buildCart({ streams }).rom, 0).ok).toBe(true)
    },
  )
})
