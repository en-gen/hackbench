/**
 * The Map16 view's pure browser decisions, with no cartridge and no DOM.
 *
 * Every case here builds its own DTO. These are the rules a Playwright run
 * exercises through pixels; proving them at this level is what makes the
 * UI test a check on wiring rather than the only proof the rule exists.
 */
import { describe, it, expect } from 'vitest'
import {
  charSheetForChar,
  charSourceLabel,
  map16WidgetId,
  rowColorsFor,
  swatchCountFor,
  tileFrameCount,
  toggleKinds,
  SWITCH_ORDER,
  activeFor,
  previewAlternate,
  withHiddenTiles,
  BrowsedSheetCache,
  screenDoor,
} from '../../../theia/extension/src/browser/map16-view-model'
import { HIDDEN_TILE_DIM_ALPHA, hiddenPixelStrength } from '../../../src/rom/render/HiddenTiles'
import {
  compositeIndices,
  cropRegion,
  parseCssHex,
  QUADRANT_ORIGIN,
} from '../../../theia/extension/src/browser/map16-pixels'
import type {
  Map16CharSheetDto,
  Map16SheetDto,
} from '../../../theia/extension/src/common/map16-protocol'

const SHEETS: Map16CharSheetDto[] = [
  {
    slot: 'fg1',
    fileIndex: 0x20,
    fileLabel: 'GFX20',
    charBase: 0x000,
    charCount: 128,
    indicesBase64: '',
    maxColorIndex: 15,
    animated: false,
  },
  {
    slot: 'fg3',
    fileIndex: 0x25,
    fileLabel: 'GFX25',
    charBase: 0x100,
    charCount: 128,
    indicesBase64: '',
    maxColorIndex: 7,
    animated: false,
  },
  {
    slot: 'an1',
    fileIndex: 0x21,
    fileLabel: 'GFX21',
    charBase: 0x180,
    charCount: 128,
    indicesBase64: '',
    maxColorIndex: 7,
    animated: true,
  },
]

describe('map16WidgetId', () => {
  it('gives the two layers different ids, so both tabs can be open at once', () => {
    expect(map16WidgetId('fg')).not.toBe(map16WidgetId('bg'))
  })
})

describe('charSheetForChar / charSourceLabel', () => {
  it('names the slot and file a loaded character comes from', () => {
    expect(charSourceLabel(SHEETS, 0x182)).toBe('an1 - GFX21')
    expect(charSourceLabel(SHEETS, 0x100)).toBe('fg3 - GFX25')
    expect(charSourceLabel(SHEETS, 0x000)).toBe('fg1 - GFX20')
  })

  it('resolves the LAST character of a sheet, so the bound is off-by-one correct', () => {
    expect(charSheetForChar(SHEETS, 0x17f)?.slot).toBe('fg3')
    expect(charSheetForChar(SHEETS, 0x180)?.slot).toBe('an1')
  })

  it('says a character is not loaded rather than guessing at a file for it', () => {
    // $080-$0FF is fg2, which this tileset does not carry, and $200+ is
    // tilemap space rather than character space.
    expect(charSourceLabel(SHEETS, 0x090)).toBe('not loaded by this tileset')
    expect(charSourceLabel(SHEETS, 0x300)).toBe('not loaded by this tileset')
    expect(charSheetForChar(SHEETS, 0x300)).toBeUndefined()
  })
})

describe('swatchCountFor', () => {
  /**
   * PER SHEET. `SHEETS` deliberately mixes a 4bpp sheet (fg1, indices up to
   * 15) with two that only reach 7: a maximum taken across all three - what
   * this view used to do - would offer eight colors a character in fg3 can
   * never index. All four vanilla slots measure 7, so the corpus cannot
   * show this and the fixture has to.
   */
  it('offers only the indices the character own sheet can produce', () => {
    expect(swatchCountFor(SHEETS, 0x000)).toBe(16) // fg1, 4bpp
    expect(swatchCountFor(SHEETS, 0x100)).toBe(8) // fg3, 3bpp
    expect(swatchCountFor(SHEETS, 0x180)).toBe(8) // an1, 3bpp
  })

  it('offers the widest any loaded sheet reaches for a character none holds', () => {
    // The source label beside it already says the character is not loaded,
    // so this is a display choice about an already-flagged character rather
    // than a guess at which sheet it came from.
    expect(swatchCountFor(SHEETS, 0x300)).toBe(16)
    expect(swatchCountFor(SHEETS, undefined)).toBe(16)
  })

  it('offers one swatch when nothing is loaded, never a full row', () => {
    expect(swatchCountFor([], 0x100)).toBe(1)
  })
})

function sheetWith(rows: number[], charSheets: Map16CharSheetDto[] = []): Map16SheetDto {
  const colors = Array.from({ length: 16 }, (_, i) => `#${i.toString(16).repeat(6)}`)
  return {
    cgramRows: rows.map(row => ({ row, colors })),
    layer: 'fg',
    tileset: 0,
    paletteVariant: { bg: 0, fg: 0 },
    citedColorRows: rows,
    charSheets,
    tilesPerRow: 16,
    width: 256,
    height: 512,
    rgbaBase64: '',
    tiles: [],
    pipeVariantsIgnored: true,
  }
}

describe('rowColorsFor', () => {
  it('reads the named row out of the CGRAM the sheet was composited with', () => {
    expect(rowColorsFor(sheetWith([2, 3]), 2)).toHaveLength(16)
  })

  it('falls back to the first CITED row, never to row 0 by assumption', () => {
    const sheet = sheetWith([4, 7])
    // Row 0 is not cited here; asking for it must not silently produce a
    // strip that no character in the sheet reads.
    expect(rowColorsFor(sheet, undefined)).toEqual(rowColorsFor(sheet, 4))
  })

  it('yields no colors when the sheet cites no row at all', () => {
    expect(rowColorsFor(sheetWith([]), 0)).toEqual([])
  })
})

describe('tileFrameCount', () => {
  /**
   * Derived from what the TILE does, never from a slot name. The first
   * design was going to call `an1` the animated slot and freeze it;
   * measured on all 15 tilesets of all 6 corpus ROMs, animated characters
   * land in fg1/fg2 and never in an1, so it would have frozen the wrong
   * thing and shown the wrong frame count.
   */
  function animating(ids: number[]): Map16SheetDto {
    const sheet = sheetWith([0])
    return {
      ...sheet,
      charAnimation: { frameCount: 4, intervalMs: 133, phases: [], animatedTileIds: ids },
    }
  }

  it('shows ONE frame for a tile that cites no animated character', () => {
    expect(tileFrameCount(animating([0x000]), 0x001)).toBe(1)
  })

  it('shows the cartridge own frame count for a tile that cites one', () => {
    expect(tileFrameCount(animating([0x000]), 0x000)).toBe(4)
  })

  it('shows ONE frame when the sheet has no animation model at all', () => {
    expect(tileFrameCount(sheetWith([0]), 0x000)).toBe(1)
  })
})

describe('compositeIndices', () => {
  const colors = ['#000000', '#ff0000', '#00ff00']

  it('paints index 0 as transparent, not as the row first color', () => {
    const out = compositeIndices(new Uint8Array([0, 1]), 0, 2, colors)
    expect(out[3]).toBe(0) // alpha of index 0
    expect([out[4], out[5], out[6], out[7]]).toEqual([255, 0, 0, 255])
  })

  it('leaves an index the row cannot reach transparent rather than clamping it', () => {
    // Clamping would paint a plausible color for something the sheet can
    // never index, which hides the mismatch instead of showing it.
    const out = compositeIndices(new Uint8Array([9]), 0, 1, colors)
    expect(out[3]).toBe(0)
  })

  it('reads from the given offset, so one buffer holds every character', () => {
    const out = compositeIndices(new Uint8Array([1, 2]), 1, 1, colors)
    expect([out[0], out[1], out[2]]).toEqual([0, 255, 0])
  })
})

describe('parseCssHex', () => {
  it('expands a six-digit hex color', () => {
    expect(parseCssHex('#1a2b3c')).toEqual([0x1a, 0x2b, 0x3c])
  })

  it('refuses anything else rather than half-parsing it', () => {
    expect(parseCssHex('rgb(1,2,3)')).toEqual([0, 0, 0])
    expect(parseCssHex('#abc')).toEqual([0, 0, 0])
  })
})

describe('cropRegion / QUADRANT_ORIGIN', () => {
  it('crops the quadrant each key names out of a tile-shaped buffer', () => {
    // A 16x16 atlas whose red channel is the pixel index, so a crop can be
    // identified by its own contents rather than by its size alone.
    const atlas = new Uint8ClampedArray(16 * 16 * 4)
    for (let i = 0; i < 16 * 16; i++) atlas[i * 4] = i & 0xff

    const tr = cropRegion(atlas, 16, QUADRANT_ORIGIN.tr!.x, QUADRANT_ORIGIN.tr!.y, 8, 8)
    expect(tr[0]).toBe(8) // first pixel of the top-right 8x8
    const bl = cropRegion(atlas, 16, QUADRANT_ORIGIN.bl!.x, QUADRANT_ORIGIN.bl!.y, 8, 8)
    expect(bl[0]).toBe((8 * 16) & 0xff)
    expect(tr).toHaveLength(8 * 8 * 4)
  })
})

describe('toggleKinds', () => {
  const alt = (...kinds: ('blue' | 'silver' | 'onOff')[]) => ({
    kinds,
    altRgbaBase64: '',
    hidden: false,
  })

  it('lists single switches blue, silver, ON/OFF, whatever order they arrive in', () => {
    // Sorted by name, as the combo keys are: blue, onOff, silver.
    const alternates = [
      alt('blue'),
      alt('onOff'),
      alt('blue', 'onOff'),
      alt('silver'),
      alt('blue', 'silver'),
    ]
    expect(toggleKinds(alternates)).toEqual(['blue', 'silver', 'onOff'])
    expect(SWITCH_ORDER).toEqual(['blue', 'silver', 'onOff'])
  })

  it('never lists a combo as a toggle', () => {
    expect(toggleKinds([alt('blue', 'silver')])).toEqual([])
    expect(toggleKinds(undefined)).toEqual([])
  })
})

describe('previewAlternate', () => {
  const alt = (kinds: ('blue' | 'silver' | 'onOff')[], hidden = false) => ({
    kinds,
    altRgbaBase64: kinds.join('+'),
    hidden,
  })

  it('ignores a switch left on from a tile state that no longer has it', () => {
    // Blue was turned on, then the tileset changed and this tile follows only silver.
    const alternates = [alt(['silver'])]
    const active = new Set(['blue', 'silver'] as const)
    expect(activeFor(alternates, active)).toEqual(['silver'])
    expect(previewAlternate(alternates, active)).toEqual({ alt: alternates[0], hidden: false })
  })

  it('matches a combo by set, and falls back to a hidden single, flagged hidden', () => {
    const alternates = [alt(['blue'], true), alt(['silver']), alt(['blue', 'silver'])]
    expect(previewAlternate(alternates, new Set(['silver', 'blue'] as const))?.alt).toBe(
      alternates[2],
    )
    expect(previewAlternate(alternates, new Set())).toEqual({ alt: alternates[0], hidden: true })
    expect(previewAlternate([alt(['silver'])], new Set())).toBeUndefined()
  })

  it('a switch that blanks the tile (e.g. $094 under ON/OFF) shows its own picture in the screen door', () => {
    const alternates = [alt(['onOff'])]
    const blank = () => true
    expect(previewAlternate(alternates, new Set(['onOff'] as const), blank)).toEqual({ alt: undefined, hidden: true }) // prettier-ignore
    expect(previewAlternate(alternates, new Set(), blank)).toBeUndefined() // off: the tile as it is
  })
})

describe('withHiddenTiles', () => {
  // 2 tiles a row, 2 rows. Tile 3 (row 2, column 2) is hidden; tile 2 beside it is blank
  // and not hidden. The switched-on art is two opaque pixels, (3, 1) on the screen door's
  // full squares and (4, 1) on its dim ones, so a transposed, mis-rowed, channel-dropping
  // or parity-flipped copy lands somewhere else, in another color or at the other strength.
  const TPR = 2
  const width = TPR * 16
  const art = new Uint8ClampedArray(16 * 16 * 4)
  art.set([10, 20, 30, 255], (1 * 16 + 3) * 4)
  art.set([40, 50, 60, 255], (1 * 16 + 4) * 4)
  const alt = (hidden: boolean) => [{ kinds: ['blue' as const], altRgbaBase64: 'art', hidden }]
  const sheetOf = (hidden: boolean) => ({
    width,
    tilesPerRow: TPR,
    tiles: [2, 3].map(id => ({ id, alternates: alt(hidden && id === 3) })),
  })
  const at = (px: Uint8ClampedArray, x: number, y: number): number[] => [
    ...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
  ]
  const drawn = (px: Uint8ClampedArray): number =>
    px.filter((v, i) => i % 4 === 3 && v !== 0).length

  it("draws a hidden tile's switched-on art in the soft screen door, exactly in place, and nothing else", () => {
    const atlas = new Uint8ClampedArray(width * 32 * 4)
    const out = withHiddenTiles(atlas, sheetOf(true), () => art)
    expect(at(out, 16 + 3, 16 + 1)).toEqual([10, 20, 30, 255])
    expect(at(out, 16 + 4, 16 + 1)).toEqual([40, 50, 60, 64])
    expect(drawn(out)).toBe(2)
    expect(drawn(atlas)).toBe(0) // the decoded phase itself is never written
  })

  it('never covers a pixel an animation frame draws', () => {
    const atlas = new Uint8ClampedArray(width * 32 * 4)
    atlas.set([1, 2, 3, 255], ((16 + 1) * width + 16 + 3) * 4)
    const out = withHiddenTiles(atlas, sheetOf(true), () => art)
    expect(at(out, 16 + 3, 16 + 1)).toEqual([1, 2, 3, 255])
  })
})

describe('BrowsedSheetCache', () => {
  const TPR = 2
  const width = TPR * 16
  const art = new Uint8ClampedArray(16 * 16 * 4).fill(255)
  const sheetOf = (hidden: boolean) => ({
    width,
    tilesPerRow: TPR,
    tiles: [{ id: 0, alternates: [{ kinds: ['blue' as const], altRgbaBase64: 'art', hidden }] }],
  })
  const decode = (b: string) => (b === 'art' ? art : new Uint8ClampedArray(width * 16 * 4))

  it('shows the NEW overlay after a reload whose still atlas is byte-identical', () => {
    const cache = new BrowsedSheetCache()
    expect(cache.pixels(sheetOf(false), 'atlas', decode)[3]).toBe(0)
    // Same phase bytes, but the reload now marks tile 0 hidden.
    expect(cache.pixels(sheetOf(true), 'atlas', decode)[3]).toBe(255)
  })

  it('reuses a phase within one sheet', () => {
    const cache = new BrowsedSheetCache()
    const sheet = sheetOf(true)
    expect(cache.pixels(sheet, 'atlas', decode)).toBe(cache.pixels(sheet, 'atlas', decode))
  })
})

describe('soft screen door', () => {
  it("dims at 25%, the owner-chosen strength for a hidden tile's off pixels", () => {
    expect(HIDDEN_TILE_DIM_ALPHA).toBe(0.25)
  })

  it('is a checkerboard on tile pixels, full where x + y is even', () => {
    expect([0, 1, 2, 3].map(x => hiddenPixelStrength(x, 0))).toEqual([1, 0.25, 1, 0.25])
    expect([0, 1, 2, 3].map(x => hiddenPixelStrength(x, 1))).toEqual([0.25, 1, 0.25, 1])
  })

  it('screenDoor keeps every color, scales only alpha, and leaves its input alone', () => {
    const tile = new Uint8ClampedArray(16 * 16 * 4)
    for (let i = 0; i < 16 * 16; i++) tile.set([i, 255 - i, 7, 255], i * 4)
    const out = screenDoor(tile)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const i = y * 16 + x
        expect([...out.subarray(i * 4, i * 4 + 4)]).toEqual([
          i,
          255 - i,
          7,
          (x + y) % 2 === 0 ? 255 : 64,
        ])
      }
    expect(tile[3 + 4]).toBe(255)
  })
})
