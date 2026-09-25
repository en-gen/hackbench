/**
 * The character palettes and the tile-count refusals, the two things the
 * Map16 tile editor adds to the decode path.
 *
 * The REFUSALS are synthetic: CI has no cartridge, so a gate proven only by
 * a corpus test is unproven where it actually runs. Every stub here builds
 * its bytes in the test.
 *
 * The PALETTES need real graphics - four decoded GFX sheets and a real
 * OBJECTGFXLIST - so those cases are `describe.skipIf`-gated on the cart,
 * never generated from a directory listing: `for (const f of romFiles)` over
 * an empty array registers zero cases, so the run goes green with a skip
 * count of zero and the cases silently cease to exist.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { MAP16_TOTAL_TILES } from '../../../src/rom/Map16'
import { map16Stub } from '../support/syntheticMap16'
import {
  getCharPixels,
  loadVram,
  readGfxAssignment,
  VRAM_CHAR_BASE,
} from '../../../src/rom/GfxLoader'
import { getAnimatedChars, loadAnimationData } from '../../../src/rom/AnimationLoader'
import { buildChars, vramFromChars } from '../../../src/rom/model/chars/CharFactory'
import {
  compositeIndices,
  cropRegion,
  decodeRgba,
} from '../../../theia/extension/src/browser/map16-pixels'
import {
  decodeMap16Sheet,
  map16LayerExtent,
  map16TileCapacity,
  slotCharCount,
} from '../../../theia/extension/src/node/map16-decode'
import {
  MAP16_CHAR_SLOTS,
  MAP16_CHAR_SPACE_END,
  Map16PaletteVariantDto,
} from '../../../theia/extension/src/common/map16-protocol'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)
const DEFAULT_VARIANT: Map16PaletteVariantDto = { bg: 0, fg: 0 }

/** A stub whose fill loops claim `pointerBytes`; `null` adds a disagreeing count site. */
function stubRom(pointerBytes: number | null): RomFile {
  const bytes = map16Stub(pointerBytes === null ? { extraCount: 0x200 } : { bgBound: pointerBytes })
  return RomFile.fromBytes('stub.sfc', bytes)
}

describe('map16TileCapacity (no cartridge)', () => {
  it('accepts a stock 512-tile table, reading the count rather than assuming it', () => {
    expect(map16TileCapacity(stubRom(0x0400))).toEqual({ count: 512 })
  })

  it('accepts a SHORTER table at its real length, rather than padding to 512', () => {
    // Nothing in the corpus does this, but it is the half of "present what
    // the cart HAS" that does not need an expanded loader: 256 tiles are
    // 256 tiles, and showing 512 would invent the other half.
    expect(map16TileCapacity(stubRom(0x0200))).toEqual({ count: 256 })
  })

  it('refuses an expanded table rather than silently showing its first two pages', () => {
    const result = map16TileCapacity(stubRom(0x1000)) // LM v1.70 parity: 2048 tiles
    expect('reason' in result).toBe(true)
    const reason = (result as { reason: string }).reason
    // The reason has to name the real count and the tracking issue, or the
    // user cannot tell a refusal from a bug.
    expect(reason).toContain('2048')
    expect(reason).toContain(String(MAP16_TOTAL_TILES))
    expect(reason).toContain('en-gen/hackbench#102')
  })

  it('refuses a cartridge whose fill loop cannot be found, rather than falling back to 512', () => {
    const result = map16TileCapacity(stubRom(null))
    expect('reason' in result).toBe(true)
    expect((result as { reason: string }).reason).toMatch(/could not be resolved/i)
    // Explicitly NOT a count: falling back to the vanilla value is the
    // defect this gate exists to prevent.
    expect('count' in result).toBe(false)
  })

  it('refuses a bound that is not a whole number of two-byte pointers', () => {
    expect('reason' in map16TileCapacity(stubRom(0x0401))).toBe(true)
  })
})

/** Each layer answers from its own fill loop; every fixture is synthetic. */
describe('map16LayerExtent (no cartridge)', () => {
  it('reads the foreground extent off this ROM own fill loop', () => {
    expect(map16LayerExtent(stubRom(0x0400), 'fg')).toEqual({ count: 512 })
    expect(map16LayerExtent(stubRom(0x0200), 'fg')).toEqual({ count: 256 })
  })

  it('presents the background when the foreground count is unresolvable', () => {
    const rom = stubRom(null)
    expect('reason' in map16LayerExtent(rom, 'fg')).toBe(true)
    expect(map16LayerExtent(rom, 'bg')).toEqual({ count: 512 })
  })

  it('reads the background extent off its own fill loop, or refuses (#489)', () => {
    const rom = (bytes: Uint8Array): RomFile => RomFile.fromBytes('stub.sfc', bytes)
    expect(map16LayerExtent(rom(map16Stub({ bgBound: 0x200 })), 'bg')).toEqual({ count: 256 })
    expect('reason' in map16LayerExtent(rom(map16Stub({ bgBound: 0x1000 })), 'bg')).toBe(true)
    expect('reason' in map16LayerExtent(rom(map16Stub({}, ['bgLoop'])), 'bg')).toBe(true)
  })
})

/**
 * The claim the whole design rests on: a character in a palette section and
 * the same character inside a tile are the SAME PIXELS.
 *
 * It was false. `buildTileAtlas` composited from the animation's phase-0
 * VRAM while the palettes composited from the raw GFX-file bytes, and
 * `vramFromChars` copies, so the two never met. Measured on vanilla tileset
 * 0: 75 of 80 animated characters differed, and they are the coins, the `?`
 * blocks and the water - the most recognizable characters in the game. A
 * user expanded fg1, clicked the cell that looked like a coin, and the tile
 * drew something else.
 *
 * No test compared a palette cell against the quadrant citing it, which is
 * how it got through. These do.
 */
/**
 * The clamp the whole RPC-bound argument rests on.
 *
 * `MAP16_CHAR_SPACE_END` bounds writes to `$000-$1FF`, which is NOT the
 * same set as "loaded": measured across all 6 ROMs, 357 of 360 slot/tileset
 * combinations hold exactly 128 characters, and the three that do not are
 * Invictus tilesets 3, 9 and 14, whose `an1` holds 123. What keeps those
 * five unloaded characters unreachable is that a palette section draws only
 * what its sheet HOLDS, which is this function. If it stops clamping, the
 * accordion starts offering characters that are not loaded.
 *
 * The other half is the slot capacity: `loadVram` returns whatever the FILE
 * decoded to rather than what the slot maps, so a 4096-byte 3bpp file
 * yields 170 and, unclamped, `fg1` would offer characters that are really
 * `fg2`'s and `an1` would run past character space entirely. No corpus ROM
 * can show that, which is the romhack case the project rules exist for.
 */
describe('slotCharCount (no cartridge)', () => {
  it('offers every character when the file fits the slot', () => {
    for (const slot of MAP16_CHAR_SLOTS) expect(slotCharCount(slot, 128)).toBe(128)
    expect(slotCharCount('fg1', 64)).toBe(64)
  })

  it('never offers more than the sheet actually holds', () => {
    // The Invictus shape, measured: an1 decodes to 123 on tilesets 3, 9 and
    // 14. Offering 128 there would put $1FB-$1FF in the accordion, which is
    // exactly the hole the RPC bound does not close.
    expect(slotCharCount('an1', 123)).toBe(123)
    for (const slot of MAP16_CHAR_SLOTS) {
      for (const decoded of [0, 1, 63, 123, 127, 128]) {
        expect(slotCharCount(slot, decoded)).toBeLessThanOrEqual(decoded)
      }
    }
  })

  it('drops the characters past what the slot maps, rather than shadowing the next slot', () => {
    // 170 is what a 4096-byte 3bpp file decodes to.
    for (const slot of MAP16_CHAR_SLOTS) expect(slotCharCount(slot, 170)).toBe(128)
  })

  it('never lets a slot reach past the end of character space', () => {
    for (const slot of MAP16_CHAR_SLOTS) {
      expect(VRAM_CHAR_BASE[slot] + slotCharCount(slot, 512)).toBeLessThanOrEqual(
        MAP16_CHAR_SPACE_END,
      )
    }
  })
})

describe.skipIf(!romPresent)('the palettes and the tiles paint the same pixels (ROM-only)', () => {
  /** The cartridge's animation frame 0, re-derived independently of the
   * decoder so this is a comparison and not a restatement. */
  function frameZeroVram(rom: SmwRom, tileset: number) {
    const raw = loadVram(rom.rom, tileset)
    const animData = loadAnimationData(rom.rom, tileset)
    if (!animData) return { raw, frameZero: raw, animated: new Set<number>() }
    return {
      raw,
      frameZero: vramFromChars(raw, buildChars(raw, animData)),
      animated: getAnimatedChars(animData),
    }
  }

  it('offers the cartridge FRAME 0 for an animated character, not the raw GFX bytes', () => {
    const rom = SmwRom.open(ROM_PATH)
    const result = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    if (result.status !== 'ok') throw new Error('expected a sheet')
    const { raw, frameZero, animated } = frameZeroVram(rom, 0)

    let compared = 0
    let differedFromRaw = 0
    for (const sheet of result.sheet.charSheets) {
      const indices = Buffer.from(sheet.indicesBase64, 'base64')
      for (let c = 0; c < sheet.charCount; c++) {
        const charNum = sheet.charBase + c
        if (!animated.has(charNum)) continue
        const offered = indices.subarray(c * 64, (c + 1) * 64)
        expect(Array.from(offered)).toEqual(Array.from(getCharPixels(frameZero, charNum)!))
        compared++
        const rawPixels = getCharPixels(raw, charNum)!
        if (!offered.equals(Buffer.from(rawPixels))) differedFromRaw++
      }
    }
    // A tripwire on the fixture: if nothing differed between the two
    // sources, the assertion above would pass for a decoder that used
    // either, and this case would prove nothing.
    expect(compared).toBeGreaterThan(0)
    expect(differedFromRaw).toBe(75)
  })

  it('paints a palette cell identically to the quadrant that cites it', () => {
    const rom = SmwRom.open(ROM_PATH)
    const result = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    if (result.status !== 'ok') throw new Error('expected a sheet')
    const sheet = result.sheet
    const { animated } = frameZeroVram(rom, 0)

    // A tile quadrant citing an ANIMATED character with no flips: the case
    // the two sources disagreed on, and the one a user is most likely to
    // click. Flips excluded because the palette never mirrors a character.
    const found = sheet.tiles
      .flatMap(tile =>
        (['tl', 'tr', 'bl', 'br'] as const).map(key => ({ tile, key, quad: tile[key] })),
      )
      .find(
        q =>
          animated.has(q.quad.charNum) &&
          !q.quad.flipX &&
          !q.quad.flipY &&
          sheet.charSheets.some(
            s => q.quad.charNum >= s.charBase && q.quad.charNum < s.charBase + s.charCount,
          ),
      )
    expect(found, 'vanilla tileset 0 has a tile citing an animated character').toBeTruthy()
    const { tile, key, quad } = found!

    const source = sheet.charSheets.find(
      s => quad.charNum >= s.charBase && quad.charNum < s.charBase + s.charCount,
    )!
    const colors = sheet.cgramRows.find(r => r.row === quad.colorRow)!.colors
    const cell = compositeIndices(
      new Uint8Array(Buffer.from(source.indicesBase64, 'base64')),
      (quad.charNum - source.charBase) * 64,
      64,
      colors.slice(0, source.maxColorIndex + 1),
    )

    const atlas = decodeRgba(sheet.rgbaBase64)
    const x = (tile.id % sheet.tilesPerRow) * 16 + (key === 'tr' || key === 'br' ? 8 : 0)
    const y = Math.floor(tile.id / sheet.tilesPerRow) * 16 + (key === 'bl' || key === 'br' ? 8 : 0)
    const rendered = cropRegion(atlas, sheet.width, x, y, 8, 8)

    // Compared where the character actually draws: index 0 is the backdrop,
    // which the atlas fills with the level's own color and a standalone cell
    // leaves transparent, so those pixels are a different question.
    let opaque = 0
    for (let i = 0; i < 64; i++) {
      if (cell[i * 4 + 3] === 0) continue
      opaque++
      expect([cell[i * 4], cell[i * 4 + 1], cell[i * 4 + 2]]).toEqual([
        rendered[i * 4],
        rendered[i * 4 + 1],
        rendered[i * 4 + 2],
      ])
    }
    expect(opaque).toBeGreaterThan(0)
  })
})

describe.skipIf(!romPresent)('Map16 character palettes (ROM-only)', () => {
  it('offers exactly the four sheets this tileset has loaded, labelled by slot and file', () => {
    const rom = SmwRom.open(ROM_PATH)
    const result = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const sheets = result.sheet.charSheets

    expect(sheets.map(s => s.slot)).toEqual([...MAP16_CHAR_SLOTS])

    // The labels must name what OBJECTGFXLIST says, not a guess: this is
    // the whole reason the tray is four sheets and not fifty.
    const assignment = readGfxAssignment(rom.rom, 0, 0)
    for (const sheet of sheets) {
      expect(sheet.fileIndex).toBe(assignment[sheet.slot])
      expect(sheet.fileLabel).toBe(
        `GFX${assignment[sheet.slot]!.toString(16).toUpperCase().padStart(2, '0')}`,
      )
      expect(sheet.charBase).toBe(VRAM_CHAR_BASE[sheet.slot])
      expect(sheet.charCount).toBeGreaterThan(0)
      // charCount * 64 indices, base64: a sheet with no pixels would be a
      // palette of blank click targets that still "works".
      expect(Buffer.from(sheet.indicesBase64, 'base64').length).toBe(sheet.charCount * 64)
    }
  })

  it('switching tileset changes both the palette labels and their pixels', () => {
    const rom = SmwRom.open(ROM_PATH)
    const a = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    const b = decodeMap16Sheet(rom, 5, 'fg', DEFAULT_VARIANT)
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected two sheets')

    const labelsA = a.sheet.charSheets.map(s => s.fileLabel)
    const labelsB = b.sheet.charSheets.map(s => s.fileLabel)
    expect(labelsA).not.toEqual(labelsB)

    // And the PIXELS, not just the labels: a palette that relabels without
    // re-decoding is the confidently-wrong case this feature exists to
    // avoid.
    const pixelsA = a.sheet.charSheets.map(s => s.indicesBase64)
    const pixelsB = b.sheet.charSheets.map(s => s.indicesBase64)
    expect(pixelsA).not.toEqual(pixelsB)
  })

  it('marks an animated slot from the cartridge animation data, not from its name', () => {
    const rom = SmwRom.open(ROM_PATH)
    const result = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    if (result.status !== 'ok') throw new Error('expected a sheet')
    const sheets = result.sheet.charSheets

    // Measured across all 15 tilesets on all 6 corpus ROMs, animated
    // characters land in fg1/fg2 and NEVER in an1 - the opposite of what
    // the first design assumed. At least one slot must be marked, and not
    // every slot, or the flag would carry no information.
    const animated = sheets.filter(s => s.animated)
    expect(animated.length).toBeGreaterThan(0)
    expect(animated.length).toBeLessThan(sheets.length)
    expect(animated.some(s => s.slot === 'an1')).toBe(false)

    // The palettes' characters are the cartridge's frame 0: identical to
    // what the still sheet was composited from, and never advanced.
    const stillPhase = result.sheet.charAnimation?.phases[0]
    expect(stillPhase).toBe(result.sheet.rgbaBase64)
  })

  it('reports the highest index the loaded characters actually use, not a depth-derived 15', () => {
    const rom = SmwRom.open(ROM_PATH)
    const result = decodeMap16Sheet(rom, 0, 'fg', DEFAULT_VARIANT)
    if (result.status !== 'ok') throw new Error('expected a sheet')
    const sheet = result.sheet

    // PER SHEET, not one maximum across all four: a 3bpp sheet can only
    // produce 0-7, and a shared maximum would let a 4bpp sheet add eight
    // swatches the 3bpp one can never reach. All four vanilla slots measure
    // 7, so this case pins the derivation rather than the number.
    for (const charSheet of sheet.charSheets) {
      let observed = 0
      for (const index of Buffer.from(charSheet.indicesBase64, 'base64')) {
        if (index > observed) observed = index
      }
      expect(charSheet.maxColorIndex).toBe(observed)
      // A color row holds 16 colors; this is how many of them the swatch
      // strip may offer.
      expect(charSheet.maxColorIndex).toBeLessThan(16)
    }
  })
})
