/**
 * Unit tests for the Map16 view's decode logic (theia/extension/src/node/map16-decode.ts).
 *
 * Address correctness itself (the arithmetic, checked against real cart
 * bytes) lives in Map16.romAddress.test.ts - this file is about the DTO
 * shape decodeMap16Sheet/nextSubtileWord hand to the view: every block
 * present, addresses attached, a field edit changing only that field, and
 * (since the owner's review) the FG/BG table split and the BG/FG palette
 * variant choice actually reaching the decode.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { decodeSubTileWord, MAP16_TOTAL_TILES } from '../../../src/rom/Map16'
import { loadVram, VRAM_SLOT_NAMES } from '../../../src/rom/GfxLoader'
import { loadAnimationData } from '../../../src/rom/AnimationLoader'
import { buildChars, vramFromChars } from '../../../src/rom/model/chars/CharFactory'
import {
  decodeMap16Sheet,
  nextSubtileWord,
  subtileWordAddress,
} from '../../../theia/extension/src/node/map16-decode'
import {
  Map16PaletteVariantDto,
  MAP16_TILES_PER_ROW,
  MAP16_TILESET_COUNT,
} from '../../../theia/extension/src/common/map16-protocol'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

const DEFAULT_VARIANT: Map16PaletteVariantDto = { bg: 0, fg: 0 }

describe.skipIf(!romPresent)('map16-decode (ROM-only)', () => {
  it('decodes all 512 blocks, each with 4 subtiles and a real block address', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)

    expect(sheet.blocks).toHaveLength(MAP16_TOTAL_TILES)
    expect(sheet.layer).toBe('fg')
    expect(sheet.tileset).toBe(0)
    expect(sheet.paletteVariant).toEqual(DEFAULT_VARIANT)
    expect(sheet.tilesPerRow).toBe(MAP16_TILES_PER_ROW)
    expect(sheet.width).toBe(MAP16_TILES_PER_ROW * 16)
    expect(sheet.height).toBe(Math.ceil(MAP16_TOTAL_TILES / MAP16_TILES_PER_ROW) * 16)
    expect(sheet.pipeVariantsIgnored).toBe(true)

    for (const block of sheet.blocks) {
      expect(block.romAddr).toBe(block.tl.romAddr)
      // Column-major offsets from Map16.ts: TL+0, BL+2, TR+4, BR+6.
      expect(block.bl.romAddr).toBe(block.romAddr + 2)
      expect(block.tr.romAddr).toBe(block.romAddr + 4)
      expect(block.br.romAddr).toBe(block.romAddr + 6)
    }
  })

  it('renders a non-uniform RGBA atlas (real tile art, not a blank sheet)', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    const bytes = Buffer.from(sheet.rgbaBase64, 'base64')
    expect(bytes.length).toBe(sheet.width * sheet.height * 4)
    expect(new Set(bytes).size).toBeGreaterThan(1)
  })

  it('different tilesets decode to different pixels for at least one block', () => {
    const rom = SmwRom.open(ROM_PATH)
    const a = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    const b = decodeMap16Sheet(rom, 1, 'fg', DEFAULT_VARIANT)
    expect(a.rgbaBase64).not.toBe(b.rgbaBase64)
  })

  it('rejects an out-of-range tileset rather than silently clamping it', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(() => decodeMap16Sheet(rom, -1, 'fg', DEFAULT_VARIANT)).toThrow()
    expect(() => decodeMap16Sheet(rom, 15, 'fg', DEFAULT_VARIANT)).toThrow()
  })

  it('subtileWordAddress agrees with decodeMap16Sheet for the same tile/corner', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sheet = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    const block = sheet.blocks[0x100]!
    expect(subtileWordAddress(rom.rom, 0, 'fg', 0x100, 'tl')).toBe(block.tl.romAddr)
    expect(subtileWordAddress(rom.rom, 0, 'fg', 0x100, 'br')).toBe(block.br.romAddr)
  })

  /**
   * The gap the owner's Mesen/map-editor diff found: FG and BG are two
   * SEPARATE 512-block tables (MapEditorProvider.ts:388-390 loads both),
   * sharing nothing. Confirmed block $100 differs between them, matching
   * the owner's own diff (`char=$182 pal=2` FG vs `char=$FD pal=1` BG on
   * this cartridge).
   */
  describe('FG/BG table split', () => {
    it('the same tile id is a completely different block in each table', () => {
      const rom = SmwRom.open(ROM_PATH)
      const fg = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
      const bg = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)

      const fgBlock = fg.blocks[0x100]!
      const bgBlock = bg.blocks[0x100]!
      expect(fgBlock.tl.charNum).toBe(0x182)
      expect(fgBlock.tl.palette).toBe(2)
      expect(bgBlock.tl.charNum).toBe(0xfd)
      expect(bgBlock.tl.palette).toBe(1)
      expect(fgBlock.romAddr).not.toBe(bgBlock.romAddr)
    })

    it('every one of the 512 blocks differs between FG and BG (matches the owner-reported diff)', () => {
      const rom = SmwRom.open(ROM_PATH)
      const fg = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
      const bg = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)
      let differing = 0
      for (let i = 0; i < MAP16_TOTAL_TILES; i++) {
        const a = fg.blocks[i]!
        const b = bg.blocks[i]!
        const same =
          a.tl.charNum === b.tl.charNum &&
          a.tl.palette === b.tl.palette &&
          a.tr.charNum === b.tr.charNum &&
          a.bl.charNum === b.bl.charNum &&
          a.br.charNum === b.br.charNum
        if (!same) differing++
      }
      expect(differing).toBe(MAP16_TOTAL_TILES)
    })

    it("the BG table does not move when 'tileset' changes - only the FG table does", () => {
      const rom = SmwRom.open(ROM_PATH)
      const bg0 = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)
      const bg1 = decodeMap16Sheet(rom, 1, 'bg', DEFAULT_VARIANT)
      // Every block's fields (not just pixels, which VRAM/tileset also
      // feeds) must be identical - the BG table itself has no tileset axis.
      expect(bg0.blocks).toEqual(bg1.blocks)

      const fg0 = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
      const fg1 = decodeMap16Sheet(rom, 1, 'fg', DEFAULT_VARIANT)
      expect(fg0.blocks).not.toEqual(fg1.blocks)
    })

    /**
     * Reversed guidance, owner's follow-up measurement: even though the BG
     * BLOCK TABLE is tileset-independent (previous test), tileset still
     * resolves VRAM/GFX assignment for BOTH layers, and `readGfxAssignment`
     * differs across tilesets in the fg3/an1 slots (chars $100-$1FF) - 1310
     * of the BG table's 2048 subtiles (64.0%) sit there. So the RENDERED
     * PIXELS for `bg` must still change with tileset, same as `fg`'s.
     */
    it('the BG table renders different PIXELS across tilesets even though the block fields do not move', () => {
      const rom = SmwRom.open(ROM_PATH)
      const bgAt0 = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)
      const bgAt3 = decodeMap16Sheet(rom, 3, 'bg', DEFAULT_VARIANT)
      expect(bgAt0.rgbaBase64).not.toBe(bgAt3.rgbaBase64)
    })

    it('subtileWordAddress for bg ignores tileset for the address, matching decodeMap16Sheet', () => {
      const rom = SmwRom.open(ROM_PATH)
      const addr0 = subtileWordAddress(rom.rom, 0, 'bg', 0x100, 'tl')
      const addr1 = subtileWordAddress(rom.rom, 7, 'bg', 0x100, 'tl')
      expect(addr0).toBe(addr1)
      const sheet = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)
      expect(addr0).toBe(sheet.blocks[0x100]!.tl.romAddr)
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
  describe('citedPaletteRows', () => {
    it('the BG table cites exactly rows {0,1,4,7} - never rows 2-3', () => {
      const rom = SmwRom.open(ROM_PATH)
      const bg = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)
      expect(bg.citedPaletteRows).toEqual([0, 1, 4, 7])
    })

    it('the FG table (tileset 0) cites both a BG-fed row (0 or 1) and both FG-fed rows (2-3)', () => {
      const rom = SmwRom.open(ROM_PATH)
      const fg = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
      // Not [0,1,2,3] exactly: measured on the real cart, tileset 0's
      // merged (common + tileset-specific) table cites row 0 but not row 1
      // - a real, specific fact, not the "both rows of each pair" the
      // common table alone might suggest.
      expect(fg.citedPaletteRows).toEqual(expect.arrayContaining([2, 3]))
      expect(fg.citedPaletteRows.some(r => r === 0 || r === 1)).toBe(true)
    })
  })

  describe('BG/FG palette variant', () => {
    it('a different bg variant produces different pixels for a block using a BG-colored row', () => {
      const rom = SmwRom.open(ROM_PATH)
      const variant0 = decodeMap16Sheet(rom, 0, 'fg', { bg: 0, fg: 0 })
      const variant7 = decodeMap16Sheet(rom, 0, 'fg', { bg: 7, fg: 0 })
      expect(variant0.paletteVariant).toEqual({ bg: 0, fg: 0 })
      expect(variant7.paletteVariant).toEqual({ bg: 7, fg: 0 })
      expect(variant0.rgbaBase64).not.toBe(variant7.rgbaBase64)
    })

    it('a different fg variant also changes the rendered pixels', () => {
      const rom = SmwRom.open(ROM_PATH)
      const variant0 = decodeMap16Sheet(rom, 0, 'fg', { bg: 0, fg: 0 })
      const variant7 = decodeMap16Sheet(rom, 0, 'fg', { bg: 0, fg: 7 })
      expect(variant0.rgbaBase64).not.toBe(variant7.rgbaBase64)
    })

    it('the variant choice applies to the BG table too', () => {
      const rom = SmwRom.open(ROM_PATH)
      const variant0 = decodeMap16Sheet(rom, 0, 'bg', { bg: 0, fg: 0 })
      const variant7 = decodeMap16Sheet(rom, 0, 'bg', { bg: 7, fg: 0 })
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
      const sheet = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
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
     * animatedBlockIds must name EXACTLY the blocks whose composited pixels
     * differ between phases - no more, no less.
     *
     * The previous version of this test asserted only that the list was
     * non-empty, that each id indexed a real block, and that some block was
     * absent. An adversarial review planted `animatedBlockIds.length = 1`
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
    it('animatedBlockIds names exactly the blocks whose pixels differ between phases', () => {
      const rom = SmwRom.open(ROM_PATH)
      const sheet = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
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

      const truth = sheet.blocks.filter(b => differs(b.id)).map(b => b.id)
      expect(anim.animatedBlockIds).toEqual(truth)

      // Pinned so a regression to the char-citation heuristic is loud: that
      // version reported 88 here. Measured on the vanilla cart, tileset 0.
      expect(truth).toHaveLength(36)

      // And the strip's "does not animate" branch must be reachable, or the
      // set above would be trivially everything.
      expect(truth.length).toBeLessThan(sheet.blocks.length)
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
      const sheet = decodeMap16Sheet(rom, 0, 'bg', DEFAULT_VARIANT)
      expect(sheet.charAnimation).toBeDefined()
      expect(sheet.charAnimation!.animatedBlockIds.length).toBeGreaterThan(0)
    })
  })
})

describe('nextSubtileWord', () => {
  it('changes only the targeted field, verified by decoding the result', () => {
    const original = 0x145 | (2 << 10) // charNum=0x145, palette=2, everything else off
    const withFlipY = nextSubtileWord(original, 'flipY', true)
    const decoded = decodeSubTileWord(withFlipY)
    expect(decoded.flipY).toBe(true)
    expect(decoded.charNum).toBe(0x145) // untouched
    expect(decoded.palette).toBe(2) // untouched
    expect(decoded.flipX).toBe(false)
    expect(decoded.priority).toBe(false)
  })

  it('setting palette does not disturb charNum, even when charNum uses all 10 bits', () => {
    const original = 0x3ff // charNum maxed, palette 0
    const updated = nextSubtileWord(original, 'palette', 6)
    const decoded = decodeSubTileWord(updated)
    expect(decoded.charNum).toBe(0x3ff)
    expect(decoded.palette).toBe(6)
  })

  it('clearing a flip bit that was set actually clears it', () => {
    const original = 0x8000 // flipY set, everything else 0
    const updated = nextSubtileWord(original, 'flipY', false)
    expect(updated).toBe(0)
  })
})

/**
 * The two refusal paths, WITHOUT a cartridge.
 *
 * Both bounds checks were previously exercised only inside the corpus-gated
 * describe above, so on CI - where `test/roms/` is gitignored and absent -
 * neither was proven at all. That is precisely the case CLAUDE.md's "CI has
 * no cartridge" rule exists for: a safeguard proven only by a corpus test is
 * unproven where it actually runs.
 *
 * No cart is needed. `requireValidTileset` throws before touching the ROM,
 * and the `bg` layer resolves its pointers through
 * `buildL2Map16PointerTable()`, which takes no ROM argument at all - so a
 * stub stands in for the reader on every path these tests reach.
 *
 * Each assertion goes red if its check is deleted: remove the tileset guard
 * and the call returns an address instead of throwing; remove the tile-id
 * guard and `base + offset` yields NaN rather than refusing.
 */
describe('map16-decode refusals (no cartridge)', () => {
  // Never dereferenced on these paths - see this block's own comment.
  const noRom = {} as never

  it('refuses a tileset below range, naming the bound', () => {
    expect(() => subtileWordAddress(noRom, -1, 'bg', 0, 'tl')).toThrow(
      /tileset out of range 0\.\.14/,
    )
  })

  it('refuses a tileset above range, naming the bound', () => {
    expect(() => subtileWordAddress(noRom, MAP16_TILESET_COUNT, 'bg', 0, 'tl')).toThrow(
      /tileset out of range 0\.\.14/,
    )
  })

  it('refuses a negative tile id', () => {
    expect(() => subtileWordAddress(noRom, 0, 'bg', -1, 'tl')).toThrow(
      /tile id out of range 0\.\.511/,
    )
  })

  it('refuses a tile id past the last block', () => {
    expect(() => subtileWordAddress(noRom, 0, 'bg', MAP16_TOTAL_TILES, 'tl')).toThrow(
      /tile id out of range 0\.\.511/,
    )
  })

  it('accepts the last valid tile id, so the bound is off-by-one correct', () => {
    expect(() => subtileWordAddress(noRom, 0, 'bg', MAP16_TOTAL_TILES - 1, 'br')).not.toThrow()
  })
})
