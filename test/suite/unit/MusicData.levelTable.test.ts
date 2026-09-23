/**
 * The level music decode, exercised entirely on synthetic carts.
 *
 * CI has no cartridge, so every gate in LevelMusicTable.ts is proven here
 * rather than only against test/roms/. The corpus suite beside this one adds
 * the measured values; it skips when the carts are absent, and these do not.
 *
 * What is at risk, and so what is asserted directly:
 *
 *   - the table address comes from the LDA.L OPERAND, not from a constant,
 *     so a relocated table is still found
 *   - two candidate sites is unavailable, never the first one
 *   - no site is unavailable, never the vanilla address
 *   - a table pointing off the end of the cart is refused rather than read
 *     as zeroes
 *
 * Every assertion below was proven able to fail by planting the matching
 * defect in LevelMusicTable.ts; the mutation list is in docs/testing.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { readLevelMusicTableIfReadable, LEVEL_MUSIC_COUNT } from '../../../src/rom/MusicData'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'

/** 512 KB, the vanilla cart size, so `hasCopierHeader` reads false. */
const CART_SIZE = 0x80000

/** Cart-relative file offset of a LoROM SNES address. */
const fileOffset = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)

/**
 * TXA : LSR A x4 : AND #$07 : TAX : LDA.L table,X   (bank_05.asm:576-582)
 * The three operand bytes are what the reader is here to recover.
 */
const decodeSite = (table: number): number[] => [
  0x8a,
  0x4a,
  0x4a,
  0x4a,
  0x4a,
  0x29,
  0x07,
  0xaa,
  0xbf,
  table & 0xff,
  (table >> 8) & 0xff,
  (table >> 16) & 0xff,
]

/** Where vanilla keeps them, used so the synthetic carts read like real ones. */
const VANILLA_SITE = 0x058549
const VANILLA_TABLE = 0x0584db
const VANILLA_COMMANDS = [0x02, 0x06, 0x01, 0x08, 0x07, 0x03, 0x05, 0x12]

interface Plant {
  at: number
  bytes: number[]
}

/**
 * A zero-filled cart with byte runs planted at SNES addresses.
 *
 * Zeros never match the pattern, which opens with $8A, so nothing is found
 * except what a test puts there.
 */
function cart(...plants: Plant[]): Buffer {
  const buf = Buffer.alloc(CART_SIZE, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode, so this reads as a real cart
  for (const { at, bytes } of plants) buf.set(bytes, fileOffset(at))
  return buf
}

const rom = (...plants: Plant[]): RomFile => new RomFile('synthetic.sfc', cart(...plants))

/** A cart whose decode site and table sit where vanilla keeps them. */
const vanillaShaped = (
  commands: number[] = VANILLA_COMMANDS,
  site = VANILLA_SITE,
  table = VANILLA_TABLE,
): RomFile => rom({ at: site, bytes: decodeSite(table) }, { at: table, bytes: commands })

describe('readLevelMusicTable', () => {
  it('reads the eight commands from the address the LDA.L operand names', () => {
    const result = readLevelMusicTableIfReadable(vanillaShaped())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.table.address).toBe(VANILLA_TABLE)
    expect(result.table.commands).toEqual(VANILLA_COMMANDS)
    expect(result.table.foundAt).toBe(VANILLA_SITE)
  })

  it('reads exactly eight commands, the width of the 3-bit header field', () => {
    // A ninth byte beyond the table must not be picked up: the index is
    // masked to 3 bits at the decode site, so a slot 8 cannot be selected.
    const nine = [...VANILLA_COMMANDS, 0x1d]
    const result = readLevelMusicTableIfReadable(vanillaShaped(nine))

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.table.commands).toHaveLength(LEVEL_MUSIC_COUNT)
    expect(result.table.commands).toEqual(VANILLA_COMMANDS)
  })

  it('follows a relocated table, because the address is an operand', () => {
    // The defect this catches is reading a hardcoded $0584DB. A hack that
    // moves the table leaves the operand pointing at the new home; a reader
    // anchored on the constant returns whatever now sits at the old one.
    const moved = 0x0f8100
    const commands = [0x0b, 0x0f, 0x0a, 0x11, 0x10, 0x0c, 0x0e, 0x12]
    const result = readLevelMusicTableIfReadable(
      rom(
        { at: VANILLA_SITE, bytes: decodeSite(moved) },
        { at: moved, bytes: commands },
        // Vanilla bytes left behind at the old address, as a relocating hack
        // would leave them. Reading these would be the confident wrong answer.
        { at: VANILLA_TABLE, bytes: VANILLA_COMMANDS },
      ),
    )

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.table.address).toBe(moved)
    expect(result.table.commands).toEqual(commands)
  })

  it('finds a relocated decode site, because the site is matched by pattern', () => {
    const elsewhere = 0x0e8200
    const result = readLevelMusicTableIfReadable(
      rom(
        { at: elsewhere, bytes: decodeSite(VANILLA_TABLE) },
        { at: VANILLA_TABLE, bytes: VANILLA_COMMANDS },
      ),
    )

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.table.foundAt).toBe(elsewhere)
  })

  it('is unavailable when the decode site is absent, never the vanilla address', () => {
    // A cart carrying the table but not the routine that reads it. Returning
    // the bytes at $0584DB here is the defect: they are unreachable data.
    const result = readLevelMusicTableIfReadable(
      rom({ at: VANILLA_TABLE, bytes: VANILLA_COMMANDS }),
    )

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/not found/i)
  })

  it('is unavailable when two sites match, rather than taking the first', () => {
    const second = 0x0d8200
    const result = readLevelMusicTableIfReadable(
      rom(
        { at: VANILLA_SITE, bytes: decodeSite(VANILLA_TABLE) },
        { at: second, bytes: decodeSite(0x0f8100) },
        { at: VANILLA_TABLE, bytes: VANILLA_COMMANDS },
      ),
    )

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/2 /)
  })

  it('refuses a table that does not fit inside the ROM', () => {
    // $7F8000 is past the end of a 512 KB cart. Reading it as zeroes would
    // report eight tracks of BGM $00, which is a plausible-looking lie.
    const result = readLevelMusicTableIfReadable(
      rom({ at: VANILLA_SITE, bytes: decodeSite(0x7f8000) }),
    )

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/outside the ROM/i)
  })

  it('reads the same values through a copier header', () => {
    // The header is not code. Scanning it could make a unique site look
    // ambiguous, and an offset that forgot to skip it would read 512 bytes
    // late and land mid-instruction.
    const headered = Buffer.concat([
      Buffer.alloc(COPIER_HEADER_SIZE, 0xff),
      cart(
        { at: VANILLA_SITE, bytes: decodeSite(VANILLA_TABLE) },
        { at: VANILLA_TABLE, bytes: VANILLA_COMMANDS },
      ),
    ])
    const result = readLevelMusicTableIfReadable(new RomFile('headered.smc', headered))

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.table.address).toBe(VANILLA_TABLE)
    expect(result.table.foundAt).toBe(VANILLA_SITE)
    expect(result.table.commands).toEqual(VANILLA_COMMANDS)
  })

  it('gates on the opcode, so a near-miss instruction is not read as the decode', () => {
    // $AF is LDA long WITHOUT the X index: same three operand bytes, but the
    // instruction does not index the table, so the site is not this decode.
    // A reader matching only on the operand shape would accept it.
    const nearMiss = decodeSite(VANILLA_TABLE)
    nearMiss[8] = 0xaf
    const result = readLevelMusicTableIfReadable(
      rom({ at: VANILLA_SITE, bytes: nearMiss }, { at: VANILLA_TABLE, bytes: VANILLA_COMMANDS }),
    )

    expect(result.status).toBe('unavailable')
  })

  it('gates on the mask, so a decode of a different header field is not read', () => {
    // AND #$1F is the tileset field two instructions away in the same
    // routine (bank_05.asm:594). It shares TAX : LDA.L and would match a
    // pattern that wildcarded the mask.
    const tileset = decodeSite(VANILLA_TABLE)
    tileset[6] = 0x1f
    const result = readLevelMusicTableIfReadable(
      rom({ at: VANILLA_SITE, bytes: tileset }, { at: VANILLA_TABLE, bytes: VANILLA_COMMANDS }),
    )

    expect(result.status).toBe('unavailable')
  })
})
