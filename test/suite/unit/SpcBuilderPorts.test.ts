/**
 * The SPC I/O ports baked into a built snapshot.
 *
 * The panel's hurry-up and Yoshi-drums controls are single port writes in
 * the game (bank_00.asm:1591, constants.asm:325-326), but the player engine
 * loads a 64 KB ARAM snapshot and exposes no way to write a port afterwards.
 * So they have to be set before the snapshot is handed over, and these pin
 * WHERE they are set: the SNES writes $2140-$2143 and the SPC reads
 * $F4-$F7, so port 0 is ARAM $F4, port 1 is $F5 and port 2 is $F6.
 *
 * Getting that offset wrong is silent. The snapshot still loads, the track
 * still plays, and the control simply does nothing, which is the shape of
 * defect the house rules single out.
 *
 * Synthetic, so it runs in CI where test/roms/ is absent.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { buildSpc } from '../../../src/rom/SpcBuilder'

const CART_SIZE = 0x80000
const fileOffset = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)

/** Where a .spc file's 64 KB ARAM dump starts. */
const ARAM_BASE = 256

/** LDA #lo : STA $0000 : LDA #hi : STA $0001 : LDA #bank : STA $0002 */
const uploadRoutine = (romAddr: number): number[] => [
  0xa9,
  romAddr & 0xff,
  0x8d,
  0x00,
  0x00,
  0xa9,
  (romAddr >> 8) & 0xff,
  0x8d,
  0x01,
  0x00,
  0xa9,
  (romAddr >> 16) & 0xff,
  0x8d,
  0x02,
  0x00,
]

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]

/** A block that uploads `size` bytes to `dest`, then a zero terminator. */
const block = (dest: number, bytes: number[]): number[] => [
  ...u16(bytes.length),
  ...u16(dest),
  ...bytes,
  ...u16(0),
  ...u16(0),
]

/**
 * A ROM with the three upload routines buildSpc reads, each pointing at a
 * small block. Enough for it to produce a snapshot; the audio content is
 * irrelevant to where a port byte lands.
 */
function rom(): RomFile {
  const buf = Buffer.alloc(CART_SIZE, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode

  const ENGINE_AT = 0x0e8000
  const SAMPLES_AT = 0x0f8000
  const BANK_AT = 0x0eaed6

  buf.set(uploadRoutine(ENGINE_AT), fileOffset(0x0080e8))
  buf.set(uploadRoutine(SAMPLES_AT), fileOffset(0x0080fd))
  buf.set(uploadRoutine(BANK_AT), fileOffset(0x008148))

  // The engine block must land at ARAM $0500 so buildSpc's simulated init
  // finds somewhere to write; the contents do not matter here.
  buf.set(block(0x0500, new Array(64).fill(0x00)), fileOffset(ENGINE_AT))
  buf.set(block(0x8000, new Array(16).fill(0x00)), fileOffset(SAMPLES_AT))
  buf.set(
    block(0x1360, [...u16(0x1364), ...u16(0x1380), ...new Array(32).fill(0xaa)]),
    fileOffset(BANK_AT),
  )

  return new RomFile('synthetic.sfc', buf)
}

const aram = (spc: Uint8Array, addr: number): number => spc[ARAM_BASE + addr]

describe('buildSpc ports', () => {
  it('puts the BGM command on port 2, which is ARAM $F6', () => {
    const spc = buildSpc(rom(), 0x05, 'level')

    expect(spc).not.toBeNull()
    expect(aram(spc!, 0xf6)).toBe(0x05)
  })

  it('leaves ports 0 and 1 alone when no control is asked for', () => {
    // The default snapshot must be exactly what the engine sees on an
    // ordinary track change, or every track would play with a stray SFX.
    const spc = buildSpc(rom(), 0x05, 'level')

    expect(aram(spc!, 0xf4)).toBe(0)
    expect(aram(spc!, 0xf5)).toBe(0)
  })

  it('puts hurry-up on port 0, which is ARAM $F4', () => {
    // $FF is !SFX_HURRYUP (constants.asm:322), written by UpdateStatusBar
    // when the timer ticks to 099 (bank_00.asm:1591).
    const spc = buildSpc(rom(), 0x05, 'level', { port0: 0xff })

    expect(aram(spc!, 0xf4)).toBe(0xff)
    // And it must not disturb the track selection.
    expect(aram(spc!, 0xf6)).toBe(0x05)
    expect(aram(spc!, 0xf5)).toBe(0)
  })

  it('puts Yoshi drums on port 1, which is ARAM $F5', () => {
    // $02 is !SFX_YOSHIDRUMON, $03 !SFX_YOSHIDRUMOFF (constants.asm:325-326).
    const on = buildSpc(rom(), 0x05, 'level', { port1: 0x02 })
    const off = buildSpc(rom(), 0x05, 'level', { port1: 0x03 })

    expect(aram(on!, 0xf5)).toBe(0x02)
    expect(aram(off!, 0xf5)).toBe(0x03)
    expect(aram(on!, 0xf4)).toBe(0)
  })

  it('carries both controls at once', () => {
    const spc = buildSpc(rom(), 0x12, 'level', { port0: 0xff, port1: 0x02 })

    expect(aram(spc!, 0xf4)).toBe(0xff)
    expect(aram(spc!, 0xf5)).toBe(0x02)
    expect(aram(spc!, 0xf6)).toBe(0x12)
  })
})
