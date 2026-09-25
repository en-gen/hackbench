/** Header scoring, code-referenced upload chains, and the preview snapshot. Synthetic only. */
import { describe, it, expect } from 'vitest'
import { detectHeader } from '../../../../src/rom/nspc/RomHeader'
import {
  chainsHolding,
  chainsWriting,
  indexChainStarts,
  parseChain,
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

  it('indexes every well-formed chain start in one pass', () => {
    const rom = new Uint8Array(64).fill(0xff)
    rom.set(chainBytes, 8)
    const starts = indexChainStarts(rom)
    expect(starts[8]).toBe(2)
    // Offset 9 would read a size of $0000 followed by garbage: a terminator, not a chain.
    expect([...starts.keys()].filter(i => starts[i] === 2)).toEqual([8])
  })

  it('finds the chain whose first block writes an address, and the one holding a file offset', () => {
    const rom = new Uint8Array(0x100).fill(0xff)
    rom.set(chainBytes, 0x40)
    const starts = indexChainStarts(rom)
    expect(chainsWriting(rom, starts, 0x0501, 0x0503)).toEqual([0x40])
    expect(chainsWriting(rom, starts, 0x0503, 0x0505)).toEqual([])
    expect(chainsHolding(rom, starts, 0x46)).toEqual([0x40])
    expect(chainsHolding(rom, starts, 0x48)).toEqual([])
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

  it('replaces a song start CALL to an upload receiver with the song number, only in the preview', () => {
    const s = syntheticEarlier()
    // Receiver: the handshake a driver opens with before waiting for the SNES.
    s.put(0x2000, [0xe8, 0xaa, 0xc5, 0xf4, 0x00, 0xe8, 0xbb, 0xc5, 0xf5, 0x00])
    const lookup = s.aram.findIndex(
      (_, i) => s.aram[i] === 0x1c && s.aram[i + 1] === 0xfd && s.aram[i + 2] === 0xf6,
    )
    s.put(lookup - 3, [0x3f, 0x00, 0x20])
    const r = buildSnapshot(s.image(), 9, 0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ram = r.spc.subarray(256, 256 + 0x10000)
    expect(Array.from(ram.subarray(lookup - 3, lookup))).toEqual([0xe8, 9, 0x00])
    expect(s.aram[lookup - 3]).toBe(0x3f)
  })

  it('leaves a CALL to anything that is not a receiver alone', () => {
    const s = syntheticEarlier()
    s.put(0x2000, [0xe8, 0xaa, 0xc5, 0xf4, 0x00, 0xe8, 0xbc, 0xc5, 0xf5, 0x00])
    const lookup = s.aram.findIndex(
      (_, i) => s.aram[i] === 0x1c && s.aram[i + 1] === 0xfd && s.aram[i + 2] === 0xf6,
    )
    s.put(lookup - 3, [0x3f, 0x00, 0x20])
    const r = buildSnapshot(s.image(), 9, 0)
    expect(r.ok && r.spc[256 + lookup - 3]).toBe(0x3f)
  })

  it('sends the indirect command and stores the song where the song start reads it', () => {
    const s = syntheticEarlier()
    // CMP A,#6 : BNE +3 : MOV A,!$07FE, then a song-table lookup, in unused memory.
    s.put(0x0f00, [0x68, 0x06, 0xd0, 0x03, 0xe5, 0xfe, 0x07, 0x1c, 0xfd, 0xf6, 0x00, 0x10])
    const r = buildSnapshot(s.image(), 12, 0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ram = r.spc.subarray(256, 256 + 0x10000)
    expect(ram[0xf4]).toBe(6)
    expect(ram[0x07fe]).toBe(12)
  })

  it('sends the song number itself when the song start has no indirection', () => {
    const r = buildSnapshot(syntheticEarlier().image(), 12, 0)
    expect(r.ok && r.spc[256 + 0xf4]).toBe(12)
  })
})
