/**
 * Unit tests for the Map16 view's decode logic (theia/extension/src/node/map16-decode.ts).
 *
 * Address correctness itself (the arithmetic, checked against real cart
 * bytes) lives in Map16.romAddress.test.ts - this file is about the DTO
 * shape decodeMap16Sheet/nextQuadrantWord hand to the view: every tile
 * present, addresses attached, a field edit changing only that field, and
 * (since the owner's review) the FG/BG table split and the BG/FG palette
 * variant choice actually reaching the decode.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { RomFile } from '../../../src/rom/RomFile'
import { decodeSubTileWord, MAP16_TOTAL_TILES } from '../../../src/rom/Map16'
import { loadVram, VRAM_SLOT_NAMES } from '../../../src/rom/GfxLoader'
import { loadAnimationData } from '../../../src/rom/AnimationLoader'
import { buildChars, vramFromChars } from '../../../src/rom/model/chars/CharFactory'
import {
  decodeMap16Sheet,
  nextQuadrantWord,
  gateQuadrantWrite,
} from '../../../theia/extension/src/node/map16-decode'
import {
  Map16Layer,
  Map16PaletteVariantDto,
  Map16QuadrantKey,
  MAP16_TILES_PER_ROW,
} from '../../../theia/extension/src/common/map16-protocol'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { plantGfxReadPath, plantPaletteCol1ReachPath } from '../support/syntheticGfxCart'
import { map16Stub } from '../support/syntheticMap16'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'

const ROM_PATH = romPath(VANILLA)

/** The address a write to this quadrant would land at. */
function wordAddress(
  rom: RomFile,
  tileset: number,
  layer: Map16Layer,
  id: number,
  which: Map16QuadrantKey,
): number {
  const gate = gateQuadrantWrite(rom, tileset, layer, id, which, 'charNum', 0)
  if (gate.status !== 'ok') throw new Error(gate.reason)
  return gate.write.romAddr
}
const romPresent = hasRom(VANILLA)

const DEFAULT_VARIANT: Map16PaletteVariantDto = { bg: 0, fg: 0 }

/**
 * `decodeMap16Sheet` now RETURNS a refusal rather than throwing one, so a
 * test that wants the sheet has to say so. Asserting the status here rather
 * than casting means a refusal shows up as a failed expectation naming the
 * reason, not as a `undefined.tiles` further down.
 */
function sheetOf(
  rom: SmwRom,
  tileset: number,
  layer: 'fg' | 'bg',
  variant: Map16PaletteVariantDto = DEFAULT_VARIANT,
) {
  const result = decodeMap16Sheet(rom, tileset, layer, variant)
  if (result.status !== 'ok') throw new Error(`expected a sheet, got: ${result.reason}`)
  return result.sheet
}

describe.skipIf(!romPresent)('map16-decode (ROM-only)', () => {
  it('decodes all 512 tiles, each with 4 quadrants and a real entry address', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = sheetOf(rom, 0, 'fg')

    expect(sheet.tiles).toHaveLength(MAP16_TOTAL_TILES)
    expect(sheet.layer).toBe('fg')
    expect(sheet.tileset).toBe(0)
    expect(sheet.paletteVariant).toEqual(DEFAULT_VARIANT)
    expect(sheet.tilesPerRow).toBe(MAP16_TILES_PER_ROW)
    expect(sheet.width).toBe(MAP16_TILES_PER_ROW * 16)
    expect(sheet.height).toBe(Math.ceil(MAP16_TOTAL_TILES / MAP16_TILES_PER_ROW) * 16)
    expect(sheet.pipeVariantsIgnored).toBe(true)

    for (const tile of sheet.tiles) {
      expect(tile.romAddr).toBe(tile.tl.romAddr)
      // Column-major offsets from Map16.ts: TL+0, BL+2, TR+4, BR+6.
      expect(tile.bl.romAddr).toBe(tile.romAddr + 2)
      expect(tile.tr.romAddr).toBe(tile.romAddr + 4)
      expect(tile.br.romAddr).toBe(tile.romAddr + 6)
    }
  })

  it('renders a non-uniform RGBA atlas (real tile art, not a blank sheet)', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = sheetOf(rom, 0, 'fg')
    const bytes = Buffer.from(sheet.rgbaBase64, 'base64')
    expect(bytes.length).toBe(sheet.width * sheet.height * 4)
    expect(new Set(bytes).size).toBeGreaterThan(1)
  })

  it('different tilesets decode to different pixels for at least one tile', () => {
    const rom = SmwRom.open(ROM_PATH)
    const a = sheetOf(rom, 0, 'fg')
    const b = sheetOf(rom, 1, 'fg')
    expect(a.rgbaBase64).not.toBe(b.rgbaBase64)
  })

  it('rejects an out-of-range tileset rather than silently clamping it', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(() => decodeMap16Sheet(rom, -1, 'fg', DEFAULT_VARIANT)).toThrow()
    expect(() => decodeMap16Sheet(rom, 15, 'fg', DEFAULT_VARIANT)).toThrow()
  })

  it('the write gate addresses agree with decodeMap16Sheet for the same tile/corner', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = sheetOf(rom, 0, 'fg')
    const tile = sheet.tiles[0x100]!
    expect(wordAddress(rom.rom, 0, 'fg', 0x100, 'tl')).toBe(tile.tl.romAddr)
    expect(wordAddress(rom.rom, 0, 'fg', 0x100, 'br')).toBe(tile.br.romAddr)
  })

  /**
   * The gap the owner's Mesen/map-editor diff found: FG and BG are two
   * SEPARATE 512-tile tables (MapEditorProvider.ts:388-390 loads both),
   * sharing nothing. Confirmed tile $100 differs between them, matching
   * the owner's own diff (`char=$182 pal=2` FG vs `char=$FD pal=1` BG on
   * this cartridge).
   */
  describe('FG/BG table split', () => {
    it('the same tile id is a completely different tile in each table', () => {
      const rom = SmwRom.open(ROM_PATH)
      const fg = sheetOf(rom, 0, 'fg')
      const bg = sheetOf(rom, 0, 'bg')

      const fgTile = fg.tiles[0x100]!
      const bgTile = bg.tiles[0x100]!
      expect(fgTile.tl.charNum).toBe(0x182)
      expect(fgTile.tl.colorRow).toBe(2)
      expect(bgTile.tl.charNum).toBe(0xfd)
      expect(bgTile.tl.colorRow).toBe(1)
      expect(fgTile.romAddr).not.toBe(bgTile.romAddr)
    })

    it('every one of the 512 tiles differs between FG and BG (matches the owner-reported diff)', () => {
      const rom = SmwRom.open(ROM_PATH)
      const fg = sheetOf(rom, 0, 'fg')
      const bg = sheetOf(rom, 0, 'bg')
      let differing = 0
      for (let i = 0; i < MAP16_TOTAL_TILES; i++) {
        const a = fg.tiles[i]!
        const b = bg.tiles[i]!
        const same =
          a.tl.charNum === b.tl.charNum &&
          a.tl.colorRow === b.tl.colorRow &&
          a.tr.charNum === b.tr.charNum &&
          a.bl.charNum === b.bl.charNum &&
          a.br.charNum === b.br.charNum
        if (!same) differing++
      }
      expect(differing).toBe(MAP16_TOTAL_TILES)
    })

    it("the BG table does not move when 'tileset' changes - only the FG table does", () => {
      const rom = SmwRom.open(ROM_PATH)
      const bg0 = sheetOf(rom, 0, 'bg')
      const bg1 = sheetOf(rom, 1, 'bg')
      // Every tile's fields (not just pixels, which VRAM/tileset also
      // feeds) must be identical - the BG table itself has no tileset axis.
      expect(bg0.tiles).toEqual(bg1.tiles)

      const fg0 = sheetOf(rom, 0, 'fg')
      const fg1 = sheetOf(rom, 1, 'fg')
      expect(fg0.tiles).not.toEqual(fg1.tiles)
    })

    /**
     * Reversed guidance, owner's follow-up measurement: even though the BG
     * BLOCK TABLE is tileset-independent (previous test), tileset still
     * resolves VRAM/GFX assignment for BOTH layers, and `readGfxAssignment`
     * differs across tilesets in the fg3/an1 slots (chars $100-$1FF) - 1310
     * of the BG table's 2048 subtiles (64.0%) sit there. So the RENDERED
     * PIXELS for `bg` must still change with tileset, same as `fg`'s.
     */
    it('the BG table renders different PIXELS across tilesets even though the tile fields do not move', () => {
      const rom = SmwRom.open(ROM_PATH)
      const bgAt0 = sheetOf(rom, 0, 'bg')
      const bgAt3 = sheetOf(rom, 3, 'bg')
      expect(bgAt0.rgbaBase64).not.toBe(bgAt3.rgbaBase64)
    })

    it('the write gate for bg ignores tileset for the address, matching decodeMap16Sheet', () => {
      const rom = SmwRom.open(ROM_PATH)
      const addr0 = wordAddress(rom.rom, 0, 'bg', 0x100, 'tl')
      const addr1 = wordAddress(rom.rom, 7, 'bg', 0x100, 'tl')
      expect(addr0).toBe(addr1)
      const sheet = sheetOf(rom, 0, 'bg')
      expect(addr0).toBe(sheet.tiles[0x100]!.tl.romAddr)
    })
  })

  /**
   * Gap 2 from the same review: the palette variant was hardcoded 0/0.
   * Level $015 has BG palette $07, FG palette $00 - variant 0 and 7
   * overlap heavily in the grassland range, which is exactly why a
   * checksum-only comparison would miss this; these compare RAW CGRAM
   * indices are actually different requests reaching decode, and confirm
   * variant 0 truly is the default (no behaviour change for a caller that
   * never sets it).
   */
  /**
   * The owner's measured correction: which controls a sheet's palette
   * fields can actually reach must be SCANNED from the loaded table, never
   * assumed from `layer`. Owner's own histogram (identical on all 6 corpus
   * carts): the BG table cites only rows {0,1,4,7}, zero subtiles on rows
   * 2-3; the FG common table cites both {0,1} (232 subtiles) and {2,3}
   * (1007 subtiles). Pinned exactly for BG (a small, closed set); FG is
   * checked as containment since it also includes tileset-specific tiles
   * this test does not enumerate by hand.
   */
  describe('citedColorRows', () => {
    it('the BG table cites exactly rows {0,1,4,7} - never rows 2-3', () => {
      const rom = SmwRom.open(ROM_PATH)
      const bg = sheetOf(rom, 0, 'bg')
      expect(bg.citedColorRows).toEqual([0, 1, 4, 7])
    })

    it('the FG table (tileset 0) cites both a BG-fed row (0 or 1) and both FG-fed rows (2-3)', () => {
      const rom = SmwRom.open(ROM_PATH)
      const fg = sheetOf(rom, 0, 'fg')
      // Not [0,1,2,3] exactly: measured on the real cart, tileset 0's
      // merged (common + tileset-specific) table cites row 0 but not row 1
      // - a real, specific fact, not the "both rows of each pair" the
      // common table alone might suggest.
      expect(fg.citedColorRows).toEqual(expect.arrayContaining([2, 3]))
      expect(fg.citedColorRows.some(r => r === 0 || r === 1)).toBe(true)
    })
  })

  describe('BG/FG palette variant', () => {
    it('a different bg variant produces different pixels for a tile using a BG-colored row', () => {
      const rom = SmwRom.open(ROM_PATH)
      const variant0 = sheetOf(rom, 0, 'fg', { bg: 0, fg: 0 })
      const variant7 = sheetOf(rom, 0, 'fg', { bg: 7, fg: 0 })
      expect(variant0.paletteVariant).toEqual({ bg: 0, fg: 0 })
      expect(variant7.paletteVariant).toEqual({ bg: 7, fg: 0 })
      expect(variant0.rgbaBase64).not.toBe(variant7.rgbaBase64)
    })

    it('a different fg variant also changes the rendered pixels', () => {
      const rom = SmwRom.open(ROM_PATH)
      const variant0 = sheetOf(rom, 0, 'fg', { bg: 0, fg: 0 })
      const variant7 = sheetOf(rom, 0, 'fg', { bg: 0, fg: 7 })
      expect(variant0.rgbaBase64).not.toBe(variant7.rgbaBase64)
    })

    it('the variant choice applies to the BG table too', () => {
      const rom = SmwRom.open(ROM_PATH)
      const variant0 = sheetOf(rom, 0, 'bg', { bg: 0, fg: 0 })
      const variant7 = sheetOf(rom, 0, 'bg', { bg: 7, fg: 0 })
      expect(variant0.rgbaBase64).not.toBe(variant7.rgbaBase64)
    })
  })

  /**
   * The bug this task fixes: decodeMap16Sheet used to composite from raw
   * VRAM, so an animated char (? blocks, coins, berries, the goal tape)
   * rendered whatever static junk its GFX file left in the `an1`/`fg3`
   * slots. This is the ORACLE for that fix - see CharFactory.ts's
   * `vramFromChars` doc comment for the measurement it pins.
   */
  describe('character animation', () => {
    it('vanilla tileset 0 has a real animation model with cart-read timing, not an invented one', () => {
      const rom = SmwRom.open(ROM_PATH)
      const sheet = sheetOf(rom, 0, 'fg')
      expect(sheet.charAnimation).toBeDefined()
      const anim = sheet.charAnimation!
      // AnimationLoader.loadAnimationData's own values for vanilla - facts
      // read from the cart, not chosen here.
      expect(anim.frameCount).toBe(4)
      expect(anim.intervalMs).toBe(133)
      expect(anim.phases).toHaveLength(4)
      // Frame 0 IS the still sheet - the same bytes, not independently
      // recomputed (decodeMap16Sheet's own documented choice).
      expect(anim.phases[0]).toBe(sheet.rgbaBase64)
      // Every phase must actually be a real, differently-composited atlas -
      // four identical "phases" would be a fake-looking animation.
      expect(new Set(anim.phases).size).toBe(4)
    })

    /**
     * animatedTileIds must name EXACTLY the blocks whose composited pixels
     * differ between phases - no more, no less.
     *
     * The previous version of this test asserted only that the list was
     * non-empty, that each id indexed a real block, and that some block was
     * absent. An adversarial review planted `animatedTileIds.length = 1`
     * and all 22 cases still passed, so the oracle could not fail. It also
     * missed a real defect: the list was built from "cites a char the
     * animation DMA touches", and the DMA rewrites many chars with
     * byte-identical data, so on vanilla tileset 0 it claimed 88 blocks
     * when only 36 change.
     *
     * This version recomputes the truth from the phase atlases the DTO
     * itself carries, independently of how the backend derived the list,
     * and compares the two sets exactly.
     */
    it('animatedTileIds names exactly the tiles whose pixels differ between phases', () => {
      const rom = SmwRom.open(ROM_PATH)
      const sheet = sheetOf(rom, 0, 'fg')
      const anim = sheet.charAnimation!

      const phases = anim.phases.map(b64 => Buffer.from(b64, 'base64'))
      const differs = (id: number): boolean => {
        const x0 = (id % sheet.tilesPerRow) * 16
        const y0 = Math.floor(id / sheet.tilesPerRow) * 16
        for (let p = 1; p < phases.length; p++) {
          for (let y = 0; y < 16; y++) {
            const off = ((y0 + y) * sheet.width + x0) * 4
            for (let i = 0; i < 16 * 4; i++) {
              if (phases[0]![off + i] !== phases[p]![off + i]) return true
            }
          }
        }
        return false
      }

      const truth = sheet.tiles.filter(t => differs(t.id)).map(t => t.id)
      expect(anim.animatedTileIds).toEqual(truth)

      // Pinned so a regression to the char-citation heuristic is loud: that
      // version reported 88 here. Measured on the vanilla cart, tileset 0.
      expect(truth).toHaveLength(36)

      // And the strip's "does not animate" branch must be reachable, or the
      // set above would be trivially everything.
      expect(truth.length).toBeLessThan(sheet.tiles.length)
    })

    /**
     * The oracle the owner asked for by name: pins the exact measured
     * effect of `vramFromChars` against real cart bytes, at phase 0,
     * BEFORE any `tickAnimation()`. If a future change makes the still
     * sheet composite from raw VRAM again (the original bug), this
     * `charsChanged` count collapses to 0 and the test goes red.
     */
    it('vramFromChars at phase 0 already differs from raw VRAM by exactly the measured 76 chars (2 slots)', () => {
      const rom = SmwRom.open(ROM_PATH)
      const vram = loadVram(rom.rom, 0)
      const animData = loadAnimationData(rom.rom, 0)
      expect(animData).not.toBeNull()
      const chars = buildChars(vram, animData!)
      const phase0 = vramFromChars(vram, chars)

      let slotsChanged = 0
      let charsChanged = 0
      for (const slot of VRAM_SLOT_NAMES) {
        const base = vram[slot]
        const patched = phase0[slot]
        if (!base || !patched || base === patched) continue
        slotsChanged++
        for (let i = 0; i < base.length; i++) {
          if (base[i] !== patched[i]) charsChanged++
        }
      }
      expect(slotsChanged).toBe(2)
      expect(charsChanged).toBe(76)
    })

    it('the BG table also gets a character-animation model, from the same tileset-scoped VRAM', () => {
      const rom = SmwRom.open(ROM_PATH)
      const sheet = sheetOf(rom, 0, 'bg')
      expect(sheet.charAnimation).toBeDefined()
      expect(sheet.charAnimation!.animatedTileIds.length).toBeGreaterThan(0)
    })
  })
})

describe('nextQuadrantWord', () => {
  /** The word, or a failed expectation naming the refusal - never a cast
   * that turns a refusal into `undefined.charNum` further down. */
  function wordOf(result: ReturnType<typeof nextQuadrantWord>): number {
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error(result.reason)
    return result.word
  }

  it('changes only the targeted field, verified by decoding the result', () => {
    const original = 0x145 | (2 << 10) // charNum=0x145, palette=2, everything else off
    const decoded = decodeSubTileWord(wordOf(nextQuadrantWord(original, 'flipY', true)))
    expect(decoded.flipY).toBe(true)
    expect(decoded.charNum).toBe(0x145) // untouched
    expect(decoded.palette).toBe(2) // untouched
    expect(decoded.flipX).toBe(false)
    expect(decoded.priority).toBe(false)
  })

  it('setting the color row does not disturb charNum, even when charNum uses all 10 bits', () => {
    const original = 0x3ff // charNum maxed, palette 0
    const decoded = decodeSubTileWord(wordOf(nextQuadrantWord(original, 'colorRow', 6)))
    expect(decoded.charNum).toBe(0x3ff)
    expect(decoded.palette).toBe(6)
  })

  it('clearing a flip bit that was set actually clears it', () => {
    const original = 0x8000 // flipY set, everything else 0
    expect(wordOf(nextQuadrantWord(original, 'flipY', false))).toBe(0)
  })

  /**
   * The truncation these refusals exist to prevent: encodeSubTileWord masks
   * each field to its own width, so $407 would commit as $007 - a real,
   * different character, written by an edit that reported success. The
   * character palettes cannot express such a value; the RPC surface can,
   * and with the drag path gone it is the only place that can.
   */
  it('refuses a character wider than the 10-bit field rather than truncating it', () => {
    const result = nextQuadrantWord(0x0001, 'charNum', 0x407)
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('expected a refusal')
    expect(result.reason).toContain('1031') // the value as asked for
    expect(result.reason).toContain('1023') // the widest it could hold
    // And explicitly NOT the masked value, which is the defect.
    expect(decodeSubTileWord(0x0001 | 0x007).charNum).toBe(0x007)
  })

  it('refuses a color row above the 3-bit field, which would bleed into priority', () => {
    expect(nextQuadrantWord(0, 'colorRow', 8).status).toBe('refused')
    expect(nextQuadrantWord(0, 'colorRow', 7).status).toBe('ok')
  })

  it('refuses a negative or fractional value rather than coercing it', () => {
    expect(nextQuadrantWord(0, 'charNum', -1).status).toBe('refused')
    expect(nextQuadrantWord(0, 'charNum', 1.5).status).toBe('refused')
  })

  it('refuses a value of the wrong TYPE, which coercion would have accepted', () => {
    // `Number(true)` is 1, a perfectly legal character, so without a type
    // check an RPC caller that sent a boolean would have written character 1
    // and been told it succeeded. Map16WriteGate.test.ts covers the same
    // rule at the RPC boundary.
    expect(nextQuadrantWord(0, 'charNum', true).status).toBe('refused')
    expect(nextQuadrantWord(0, 'colorRow', '3' as never).status).toBe('refused')
    expect(nextQuadrantWord(0, 'priority', 2 as never).status).toBe('refused')
  })

  it('refuses a field name the union does not carry, rather than returning undefined', () => {
    expect(nextQuadrantWord(0, 'wat' as never, 1).status).toBe('refused')
  })
})
// Column 1 wiring (#492), on a synthetic cart: a combined stub plants a
// stock GFX read path, Map16 'bg' engine code (#489's map16Stub - the
// background table is ROM-read, not fixed, since #532) and column 1's own
// reach+opcode path, so these prove the view calls the gated reader rather
// than swallowing its refusal or falling back to a hardcoded constant -
// neither would fail without this pair, corpus or no corpus.
describe('column 1 wiring (no cartridge)', () => {
  function stubRom(): RomFile {
    const rom = new RomFile('stub.sfc', Buffer.from(map16Stub()))
    rom.writeAt(0x00ffd5, [0x20]) // LoROM header byte (SNES $00:FFD5 -> file $7FD5)
    plantGfxReadPath(rom)
    plantPaletteCol1ReachPath(rom)
    return rom
  }

  it('refuses when the level-load path no longer reaches LoadPalette', () => {
    const rom = stubRom()
    rom.writeAt(0x00a5bc, [0x4c, 0xed, 0xab]) // JMP, not JSR: a hijacked call site
    const result = decodeMap16Sheet(new SmwRom(rom), 0, 'bg', DEFAULT_VARIANT)
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('Palette column 1 is unavailable'),
    })
  })

  it('renders a non-stock column-1 immediate in the cited CGRAM row, not the vanilla $7FDD', () => {
    const rom = stubRom()
    rom.writeAt(0x00abef, [0xa9, 0x34, 0x12]) // LDA #$1234, still a valid opcode
    const result = decodeMap16Sheet(new SmwRom(rom), 0, 'bg', DEFAULT_VARIANT)
    if (result.status !== 'ok') throw new Error(result.reason)
    const [r, g, b] = bgr555ToRgba(0x1234)
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
    expect(result.sheet.cgramRows.find(row => row.row === 0)?.colors[1]).toBe(hex)
  })
})
