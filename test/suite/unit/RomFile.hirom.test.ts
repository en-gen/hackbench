/**
 * RomFile - HiROM mapping, copier-header detection, write/read symmetry,
 * and unmapped-address null returns. Pins down the address-space contract
 * that all SNES address translation depends on.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'

describe('RomFile - copier header detection', () => {
  it('hasHeader is false for sizes that are exact multiples of 1024', () => {
    const rom = new RomFile('clean.smc', Buffer.alloc(0x100000))
    expect(rom.hasHeader).toBe(false)
    expect(rom.romSize).toBe(0x100000)
  })

  it('hasHeader is true when size mod 1024 == 512', () => {
    const buf = Buffer.alloc(0x100000 + 512)
    buf[512 + 0x7fd5] = 0x20 // map mode at INTERNAL header offset
    const rom = new RomFile('headered.smc', buf)
    expect(rom.hasHeader).toBe(true)
    expect(rom.romSize).toBe(0x100000)
  })
})

describe('RomFile - map-mode auto-detect', () => {
  it("'lorom' when file offset $7FD5 is $20 and HiROM offset is not", () => {
    const buf = Buffer.alloc(0x100000)
    buf[0x7fd5] = 0x20
    expect(new RomFile('lo.smc', buf).mapMode).toBe('lorom')
  })

  it("'lorom' for fast-LoROM map byte $30", () => {
    const buf = Buffer.alloc(0x100000)
    buf[0x7fd5] = 0x30
    expect(new RomFile('lo.smc', buf).mapMode).toBe('lorom')
  })

  it("'hirom' when only HiROM map byte at $FFD5 matches", () => {
    const buf = Buffer.alloc(0x100000)
    buf[0xffd5] = 0x21
    expect(new RomFile('hi.smc', buf).mapMode).toBe('hirom')
  })

  it("'hirom' for fast-HiROM map byte $31", () => {
    const buf = Buffer.alloc(0x100000)
    buf[0xffd5] = 0x31
    expect(new RomFile('hi.smc', buf).mapMode).toBe('hirom')
  })

  it("prefers 'lorom' when BOTH map bytes are valid (header at 7FD5 wins)", () => {
    const buf = Buffer.alloc(0x100000)
    buf[0x7fd5] = 0x20
    buf[0xffd5] = 0x21
    expect(new RomFile('both.smc', buf).mapMode).toBe('lorom')
  })

  it("'unknown' when neither map byte is recognized; defaults to LoROM mapping", () => {
    const rom = new RomFile('unk.smc', Buffer.alloc(0x100000))
    expect(rom.mapMode).toBe('unknown')
    // readAt still works via LoROM fallback
    expect(rom.readByte(0x008000)).toBe(0) // file offset 0
  })
})

describe('RomFile.readAt - LoROM mapping', () => {
  it('reads from bank $00 addr $8000 → file offset 0', () => {
    const buf = Buffer.alloc(0x100000)
    buf[0x7fd5] = 0x20
    buf[0] = 0x42
    expect(new RomFile('lo.smc', buf).readByte(0x008000)).toBe(0x42)
  })

  it('reads from a higher LoROM bank with correct offset arithmetic', () => {
    const buf = Buffer.alloc(0x100000)
    buf[0x7fd5] = 0x20
    // SNES $068000 = bank 6, addr $8000 → file offset 6*$8000 = $30000
    buf[0x30000] = 0x77
    expect(new RomFile('lo.smc', buf).readByte(0x068000)).toBe(0x77)
  })

  it('returns null for addresses below $8000 in banks $00-$3F', () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    expect(new RomFile('lo.smc', buf).readByte(0x000100)).toBeNull()
  })

  it('returns null for SRAM/WRAM banks ($70-$7F)', () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    expect(new RomFile('lo.smc', buf).readByte(0x7e0000)).toBeNull()
  })
})

describe('RomFile.readAt - HiROM mapping', () => {
  function makeHiRom(): RomFile {
    const buf = Buffer.alloc(0x400000)
    buf[0xffd5] = 0x21
    buf[0x008100] = 0x55 // bank $00 addr $8100 → file offset $8100
    // Bank $42 addr $8200: effectiveBank = $42 & $3F = 2, offset = 2*$10000 + $8200 = $28200
    buf[0x028200] = 0x66
    return new RomFile('hi.smc', buf)
  }

  it('decodes bank $00-$3F upper-half ($8000+) as effectiveBank × 0x10000 + addr', () => {
    expect(makeHiRom().readByte(0x008100)).toBe(0x55)
  })

  it('decodes bank $40-$6F full-page mapping (effectiveBank = bank & 0x3F)', () => {
    expect(makeHiRom().readByte(0x428200)).toBe(0x66)
  })

  it('returns null for $00-$3F addresses below $8000 (system area)', () => {
    expect(makeHiRom().readByte(0x002000)).toBeNull()
  })

  it('returns null for SRAM/WRAM banks $70-$7F', () => {
    expect(makeHiRom().readByte(0x7e0000)).toBeNull()
  })
})

describe('RomFile.readAt - bounds check', () => {
  it('returns null when offset + length exceeds buffer.length', () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    expect(new RomFile('lo.smc', buf).readAt(0x008000, 0x20000)).toBeNull()
  })
})

describe('RomFile.readWord and readString', () => {
  function makeRom(): RomFile {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    buf[0] = 0x34
    buf[1] = 0x12 // little-endian word $1234
    Buffer.from('HACKBENCH', 'ascii').copy(buf, 0x100)
    return new RomFile('lo.smc', buf)
  }

  it('readWord returns 16-bit LE value', () => {
    expect(makeRom().readWord(0x008000)).toBe(0x1234)
  })

  it('readWord returns null when read fails (out of bounds)', () => {
    // 1-byte buffer: readWord at $008000 needs 2 bytes from file offset 0,
    // but length 2 > buffer.length 1 → readAt returns null.
    expect(new RomFile('mini.smc', Buffer.alloc(1)).readWord(0x008000)).toBeNull()
  })

  it('readString decodes ASCII and replaces null bytes with spaces', () => {
    expect(makeRom().readString(0x008100, 9)).toBe('HACKBENCH')
  })

  it('readString returns empty string when read fails', () => {
    expect(new RomFile('mini.smc', Buffer.alloc(0)).readString(0x008000, 8)).toBe('')
  })
})

describe('RomFile.writeAt', () => {
  it('writes bytes back through the SNES → file mapping', () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('lo.smc', buf)
    rom.writeAt(0x008010, [0xaa, 0xbb, 0xcc])
    expect(buf[0x10]).toBe(0xaa)
    expect(buf[0x11]).toBe(0xbb)
    expect(buf[0x12]).toBe(0xcc)
  })

  it('throws when address is not writable (WRAM bank)', () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    expect(() => new RomFile('lo.smc', buf).writeAt(0x7e0000, [0x42])).toThrow(/not writable/)
  })

  it('accepts both Buffer and number-array data', () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('lo.smc', buf)
    rom.writeAt(0x008000, Buffer.from([0x11, 0x22]))
    rom.writeAt(0x008002, [0x33, 0x44])
    expect(Array.from(buf.slice(0, 4))).toEqual([0x11, 0x22, 0x33, 0x44])
  })
})

describe('RomFile.readAtFileOffset', () => {
  it('skips the copier header when present', () => {
    const buf = Buffer.alloc(0x100000 + 512)
    buf[512 + 0x7fd5] = 0x20
    buf[512 + 100] = 0x99
    const rom = new RomFile('headered.smc', buf)
    expect(rom.readAtFileOffset(100, 1)?.[0]).toBe(0x99)
  })

  it('returns null for negative offset', () => {
    expect(new RomFile('lo.smc', Buffer.alloc(8)).readAtFileOffset(-1, 1)).toBeNull()
  })

  it('returns null when offset + length exceeds buffer', () => {
    expect(new RomFile('lo.smc', Buffer.alloc(8)).readAtFileOffset(4, 100)).toBeNull()
  })
})

/**
 * A read must not hand back a window onto the ROM.
 *
 * `Buffer.prototype.slice` is `subarray`, so a `Buffer`-backed RomFile used
 * to return a live view: writing through a read result changed the cart
 * without moving `version`, and `readGfxRoutines` invalidates its per-cart
 * cache on `version` alone. No caller does that, so these pin a latent hole
 * shut rather than fixing a live bug. They also pin the two backings to the
 * same behaviour: `Uint8Array.prototype.slice` already copied, so whether a
 * read aliased depended on how the RomFile had been constructed.
 */
describe('RomFile reads are detached copies', () => {
  const loromBuffer = () => {
    const buf = Buffer.alloc(0x10000)
    buf[0x7fd5] = 0x20
    buf[0x0000] = 0x11
    return buf
  }

  it('readAt does not alias a Buffer-backed cart', () => {
    const buf = loromBuffer()
    const rom = new RomFile('lo.smc', buf)
    const read = rom.readAt(0x008000, 4)!
    read[0] = 0x99
    expect(rom.readByte(0x008000)).toBe(0x11)
    expect(buf[0]).toBe(0x11)
  })

  it('readAt does not alias a Uint8Array-backed cart either', () => {
    const bytes = new Uint8Array(loromBuffer())
    const rom = RomFile.fromBytes('lo.smc', bytes)
    const read = rom.readAt(0x008000, 4)!
    read[0] = 0x99
    expect(rom.readByte(0x008000)).toBe(0x11)
  })

  it('readAtFileOffset does not alias either', () => {
    const buf = loromBuffer()
    const rom = new RomFile('lo.smc', buf)
    rom.readAtFileOffset(0, 4)![0] = 0x99
    expect(buf[0]).toBe(0x11)
  })

  it('keeps a Buffer-backed read a Buffer, so readString still works', () => {
    const buf = loromBuffer()
    buf.write('HB', 0x10)
    const rom = new RomFile('lo.smc', buf)
    expect(Buffer.isBuffer(rom.readAt(0x008010, 2))).toBe(true)
    expect(rom.readString(0x008010, 2)).toBe('HB')
  })

  it('leaves writeAt as the only versioned way to change the bytes', () => {
    const rom = new RomFile('lo.smc', loromBuffer())
    const before = rom.version
    rom.readAt(0x008000, 4)![0] = 0x99
    expect(rom.version).toBe(before)
    rom.writeAt(0x008000, [0x22])
    expect(rom.version).toBe(before + 1)
    expect(rom.readByte(0x008000)).toBe(0x22)
  })
})
