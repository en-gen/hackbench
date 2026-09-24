/**
 * The Map16 tile count comes from the CARTRIDGE, not from a constant.
 *
 * `src/rom/Map16.ts` hardcoded 512 in nine places. Vanilla does hold 512,
 * so on this corpus the constant and the truth agree and nothing catches
 * the difference. On a cart carrying Lunar Magic's expanded-Map16 patch
 * (en-gen/hackbench#102) they diverge, and a hardcoded 512 would present
 * the first two pages as though they were the whole table: correct-looking
 * output that silently omits the rest.
 *
 * The count is readable. CODE_058126's fill loop ends:
 *
 *     ADC.W #$0008 / STA.B _0 / INX / INX / CPX.W #$0400 / BNE -
 *
 * (`bank_05.asm:229-237`). `$0400` is 1024 BYTES of pointer table, two per
 * tile, so the immediate divided by two is the tile count. That is an
 * operand read, which CLAUDE.md's recipe calls interpretation rather than
 * assumption.
 *
 * Every case here builds its bytes in the test. CI has no cartridge.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { readMap16TileCount, VANILLA_MAP16_TILE_COUNT } from '../../../src/rom/Map16'
import { VANILLA, hasRom, romPath, romsOnDisk } from '../support/corpus'

const romPresent = hasRom(VANILLA)

/**
 * A 64 KB stub carrying one copy of the fill loop's tail at a known offset,
 * with `pointerBytes` as the CPX immediate. Nothing else in the buffer may
 * look like the pattern, so the fill is $00 rather than $FF.
 */
function stubRom(pointerBytes: number, at = 0x1000, copies = 1): RomFile {
  const buf = Buffer.alloc(0x10000, 0x00)
  for (let c = 0; c < copies; c++) {
    const o = at + c * 0x400
    buf[o] = 0x69 // ADC.W #$0008
    buf[o + 1] = 0x08
    buf[o + 2] = 0x00
    buf[o + 3] = 0x85 // STA.B _0
    buf[o + 4] = 0x65
    buf[o + 5] = 0xe8 // INX
    buf[o + 6] = 0xe8 // INX
    buf[o + 7] = 0xe0 // CPX.W #imm
    buf[o + 8] = pointerBytes & 0xff
    buf[o + 9] = (pointerBytes >> 8) & 0xff
    buf[o + 10] = 0xd0 // BNE
    buf[o + 11] = 0xf3
  }
  return RomFile.fromBytes('stub.sfc', new Uint8Array(buf))
}

describe('readMap16TileCount', () => {
  it('reads the vanilla loop bound as 512 tiles', () => {
    expect(readMap16TileCount(stubRom(0x0400))).toBe(512)
  })

  it('reads an expanded loop bound rather than assuming vanilla', () => {
    // LM v1.70 parity is 2048 tiles, so 4096 bytes of pointer table.
    expect(readMap16TileCount(stubRom(0x1000))).toBe(2048)
  })

  it('refuses when the loop is absent, rather than falling back to 512', () => {
    const buf = Buffer.alloc(0x10000, 0x00)
    expect(readMap16TileCount(RomFile.fromBytes('empty.sfc', new Uint8Array(buf)))).toBeNull()
  })

  it('accepts repeated sites that agree, since the cart says one thing', () => {
    // The real loop shape occurs 3 times per cartridge, measured on all 6.
    expect(readMap16TileCount(stubRom(0x0400, 0x1000, 3))).toBe(512)
  })

  it('refuses when two sites disagree, since no single count can be claimed', () => {
    const buf = Buffer.alloc(0x10000, 0x00)
    const write = (o: number, bound: number) => {
      buf.set([0x69, 0x08, 0x00, 0x85, 0x65, 0xe8, 0xe8, 0xe0, bound & 0xff, bound >> 8, 0xd0], o)
    }
    write(0x1000, 0x0400)
    write(0x2000, 0x1000)
    expect(readMap16TileCount(RomFile.fromBytes('split.sfc', new Uint8Array(buf)))).toBeNull()
  })

  it('refuses an odd byte count, which cannot be a whole number of pointers', () => {
    expect(readMap16TileCount(stubRom(0x0401))).toBeNull()
  })

  it('refuses a zero bound, which would render an empty table as if it were whole', () => {
    expect(readMap16TileCount(stubRom(0x0000))).toBeNull()
  })

  /**
   * The gate has to fail on a planted defect or it is not a gate. Anchoring
   * on the CPX alone would match any `CPX.W` in the cartridge; the INX/INX
   * before and the BNE after are what make the match specific.
   */
  it('does not match the generic loop tail without the Map16 stride', () => {
    const buf = Buffer.alloc(0x10000, 0x00)
    // INX / INX / CPX.W #$0400 / BNE with no ADC.W #$0008 in front. This
    // shape occurs 5 to 7 times per real cartridge and means nothing on its own.
    buf.set([0xe8, 0xe8, 0xe0, 0x00, 0x04, 0xd0, 0xf3], 0x1000)
    expect(readMap16TileCount(RomFile.fromBytes('bare.sfc', new Uint8Array(buf)))).toBeNull()
  })

  it('states the vanilla count as a documented cross-check, never as a default', () => {
    expect(VANILLA_MAP16_TILE_COUNT).toBe(512)
  })
})

describe.skipIf(!romPresent)('readMap16TileCount against real cartridges', () => {
  it('reads 512 from every cart in the corpus, from their own bytes', () => {
    const carts = romsOnDisk()
    expect(carts.length).toBeGreaterThan(0)
    for (const name of carts) {
      const rom = RomFile.load(romPath(name))
      expect(readMap16TileCount(rom), name).toBe(512)
    }
  })
})
