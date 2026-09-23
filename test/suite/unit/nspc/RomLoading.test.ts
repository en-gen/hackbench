/** Header scoring, code-referenced upload chains, and the preview snapshot. Synthetic only. */
import { describe, it, expect } from 'vitest'
import { detectHeader } from '../../../../src/rom/nspc/RomHeader'
import {
  findUploadChains,
  parseChain,
  findPointerLoads,
} from '../../../../src/rom/nspc/UploadChains'
import { buildSnapshot } from '../../../../src/rom/nspc/SpcSnapshot'
import { syntheticEarlier, SYN } from '../../support/syntheticNspc'

function headerAt(rom: Uint8Array, at: number, mapByte: number, resetTo: number) {
  rom.set(
    Array.from('SYNTHETIC GAME       ', c => c.charCodeAt(0)),
    at,
  )
  rom[at + 0x15] = mapByte
  rom[at + 0x17] = 0x09
  rom[at + 0x1c] = 0x34
  rom[at + 0x1d] = 0x12
  rom[at + 0x1e] = 0x34 ^ 0xff
  rom[at + 0x1f] = 0x12 ^ 0xff
  rom[at + 0x3c] = 0x00
  rom[at + 0x3d] = 0x80
  rom[resetTo] = 0x78 // SEI
}

describe('detectHeader', () => {
  it('picks LoROM from evidence at $7FC0', () => {
    const rom = new Uint8Array(0x80000)
    headerAt(rom, 0x7fc0, 0x20, 0x0000)
    const r = detectHeader(rom)
    expect(r.ok && r.best.layout).toBe('lorom')
  })

  it('picks HiROM from evidence at $FFC0', () => {
    const rom = new Uint8Array(0x80000)
    headerAt(rom, 0xffc0, 0x21, 0x8000)
    const r = detectHeader(rom)
    expect(r.ok && r.best.layout).toBe('hirom')
  })

  it('refuses when both sites score the same', () => {
    const rom = new Uint8Array(0x80000)
    headerAt(rom, 0x7fc0, 0x20, 0x0000)
    headerAt(rom, 0xffc0, 0x21, 0x8000)
    expect(detectHeader(rom)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('both scored'),
    })
  })

  it('refuses an empty image rather than defaulting to LoROM', () => {
    expect(detectHeader(new Uint8Array(0x80000)).ok).toBe(false)
  })
})

describe('upload chains', () => {
  const chainBytes = [0x04, 0x00, 0x00, 0x05, 1, 2, 3, 4, 0x00, 0x00, 0x00, 0x05]

  it('parses a block chain and its entry', () => {
    const rom = new Uint8Array(64)
    rom.set(chainBytes, 8)
    expect(parseChain(rom, 8)).toMatchObject({
      entry: 0x0500,
      payload: 4,
      blocks: [{ dest: 0x0500, size: 4, fileOffset: 12 }],
    })
  })

  it('refuses a block that writes the I/O registers', () => {
    const rom = new Uint8Array(64)
    rom.set([0x10, 0x00, 0xf0, 0x00], 0)
    expect(parseChain(rom, 0)).toBeNull()
  })

  it('finds a chain only when code loads its address (8-bit and 16-bit forms)', () => {
    const rom = new Uint8Array(0x10000)
    rom.set(chainBytes, 0x4000) // LoROM $00:C000
    rom.set(chainBytes, 0x5000) // not referenced by any code: must not be found
    // LDA #$00 : STA $00 : LDA #$C0 : STA $01 : LDA #$00 : STA $02
    rom.set([0xa9, 0x00, 0x85, 0x00, 0xa9, 0xc0, 0x85, 0x01, 0xa9, 0x00, 0x85, 0x02], 0x100)
    const chains = findUploadChains(rom, 'lorom')
    expect(chains.map(c => c.fileOffset)).toEqual([0x4000])

    // 16-bit: LDA #$D000 : STA $00 : LDA #$00 : STA $02 (the $5000 chain).
    rom.set([0xa9, 0x00, 0xd0, 0x85, 0x00, 0xa9, 0x00, 0x85, 0x02], 0x200)
    expect(findPointerLoads(rom).has(0x00d000)).toBe(true)
    expect(findUploadChains(rom, 'lorom').map(c => c.fileOffset)).toEqual([0x4000, 0x5000])
  })
})

describe('buildSnapshot', () => {
  it('pre-loads the command and clears only the port-reset bits of the init write', () => {
    const s = syntheticEarlier()
    const r = buildSnapshot(s.image(), 5, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ram = r.spc.subarray(256, 256 + 0x10000)
    expect(ram[0xf6]).toBe(5)
    expect(r.patchedAt).toHaveLength(1)
    expect(ram[r.patchedAt[0]]).toBe(0xc0)
    expect(r.spc[0x25] | (r.spc[0x26] << 8)).toBe(SYN.entry)
    // The source image is untouched: only the preview copy is patched.
    expect(s.aram[r.patchedAt[0]]).toBe(0xf0)
  })

  it('refuses when no port-clearing init write exists', () => {
    const s = syntheticEarlier()
    const at = s.aram.findIndex(
      (_, i) => s.aram[i] === 0xe8 && s.aram[i + 1] === 0xf0 && s.aram[i + 2] === 0xc5,
    )
    s.aram[at + 1] = 0x01
    expect(buildSnapshot(s.image(), 5, 2).ok).toBe(false)
  })
})
