/**
 * Synthetic (no ROM) coverage for the RENDERING half of the switch button art
 * (map16-decode.ts): where each pressed tile lands, which name table and row
 * each tile draws from, and what the button row holds when a read refuses.
 */
import { describe, it, expect } from 'vitest'
import { PIXELS_PER_TILE, type RgbaColor } from '../../../src/rom/GraphicsDecoder'
import { type VramState, type GfxSheet } from '../../../src/rom/GfxLoader'
import type { Map16Tile, SubTile } from '../../../src/rom/Map16'
import type { PSwitchButtonArt } from '../../../src/rom/PSwitchButtonArt'
import type { ActiveLevelPalette } from '../../../src/rom/PaletteLoader'
import { RomFile } from '../../../src/rom/RomFile'
import {
  buildSwitchButtonArt,
  renderPSwitchButtonImages,
} from '../../../theia/extension/src/node/map16-decode'
import { pswitchRom } from '../support/syntheticPSwitch'

/** Every row and index its own opaque color; index 0 transparent. */
const color = (row: number, i: number): RgbaColor =>
  i === 0 ? [0, 0, 0, 0] : [row * 16 + i, 100, 200, 255]
function stubPalette(): ActiveLevelPalette {
  const rows = Array.from({ length: 16 }, (_, row) =>
    Array.from({ length: 16 }, (_, i) => color(row, i)),
  )
  return { colors: rows.flat(), rows, bgVariantIndex: 0, fgVariantIndex: 0, spritePaletteIndex: 0 }
}

// Char i of each sprite slot is solid in its own index, shifted per slot so the four
// slots never agree: a quadrant drawn from the wrong char or slot shows the wrong color.
const SHIFT = { sp1: 0, sp2: 3, sp3: 7, sp4: 11 } as const
const indexOf = (slot: keyof typeof SHIFT, char: number): number => ((char + SHIFT[slot]) % 15) + 1
const solidSheet = (slot: keyof typeof SHIFT): GfxSheet =>
  Array.from({ length: 0x80 }, (_, c) => new Uint8Array(PIXELS_PER_TILE).fill(indexOf(slot, c)))

/** Left half index 1, right half index 2: an x-flip shows in the pixels. */
function asymmetricChar(): Uint8Array {
  return Uint8Array.from({ length: PIXELS_PER_TILE }, (_, i) => (i % 8 < 4 ? 1 : 2))
}

function buildVram(): VramState {
  return {
    sp1: solidSheet('sp1'),
    sp2: solidSheet('sp2'),
    sp3: solidSheet('sp3'),
    sp4: solidSheet('sp4'),
  }
}

const ART: PSwitchButtonArt = {
  unpressedTile: 0x24,
  pressedTile: 0x60,
  xOffset: 6,
  yOffset: 5,
  tile1Mask: 0xfe,
  spriteProperties: 0,
  blueAttr: 0x06,
  silverAttr: 0x02,
}

function pixel(base64: string, x: number, y: number): RgbaColor {
  const buf = Buffer.from(base64, 'base64')
  const i = (y * 16 + x) * 4
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!]
}
const TRANSPARENT: RgbaColor = [0, 0, 0, 0]
const palette = stubPalette()

describe('renderPSwitchButtonImages', () => {
  it('groups the unpressed 16x16 as chars N, N+1, N+$10, N+$11, each in its own quadrant', () => {
    const { offRgba } = renderPSwitchButtonImages(buildVram(), palette, ART, 0x06)
    const row = 11
    expect(pixel(offRgba, 0, 0)).toEqual(color(row, indexOf('sp1', 0x24)))
    expect(pixel(offRgba, 8, 0)).toEqual(color(row, indexOf('sp1', 0x25)))
    expect(pixel(offRgba, 0, 8)).toEqual(color(row, indexOf('sp1', 0x34)))
    expect(pixel(offRgba, 8, 8)).toEqual(color(row, indexOf('sp1', 0x35)))
  })

  it('draws the pressed pair at the read X and Y, the second tile x-flipped', () => {
    const vram = buildVram()
    vram.sp1![0x60] = asymmetricChar()
    const { onRgba } = renderPSwitchButtonImages(vram, palette, ART, 0x06)
    const [top, bottom] = [ART.yOffset, ART.yOffset + 7]
    expect(pixel(onRgba, 0, top - 1)).toEqual(TRANSPARENT)
    expect(pixel(onRgba, 0, top)).toEqual(color(11, 1)) // tile 1, unflipped
    expect(pixel(onRgba, 0, bottom)).toEqual(color(11, 1))
    expect(pixel(onRgba, 0, bottom + 1)).toEqual(TRANSPARENT)
    // Tile 2 at x=6..13, flipped: its last column is the char's first.
    expect(pixel(onRgba, 8, top)).toEqual(color(11, 2))
    expect(pixel(onRgba, 13, top)).toEqual(color(11, 1))
    expect(pixel(onRgba, 14, top)).toEqual(TRANSPARENT)
  })

  it('draws from SP3/SP4 when PSwitchPal sets the name table, but tile 1 stays on SP1/SP2', () => {
    const vram = buildVram()
    const hole = new Uint8Array(PIXELS_PER_TILE).fill(indexOf('sp1', 0x60))
    for (let y = 0; y < 8; y++) hole[y * 8 + 6] = 0
    vram.sp1![0x60] = hole
    const art = { ...ART, xOffset: 4 }
    const { offRgba, onRgba } = renderPSwitchButtonImages(vram, palette, art, 0x07)
    expect(pixel(offRgba, 0, 0)).toEqual(color(11, indexOf('sp3', 0x24)))
    const y = art.yOffset
    // Overlap at x=4..7: the lower OAM slot, tile 1, wins where it is opaque...
    expect(pixel(onRgba, 5, y)).toEqual(color(11, indexOf('sp1', 0x60)))
    // ...and tile 2 (SP3, the AND #$FE never reaches it) shows through its hole.
    expect(pixel(onRgba, 6, y)).toEqual(color(11, indexOf('sp3', 0x60)))
    expect(pixel(onRgba, 9, y)).toEqual(color(11, indexOf('sp3', 0x60)))
  })

  it('a different PSwitchPal row gives different colors from the same chars', () => {
    const vram = buildVram()
    const blue = renderPSwitchButtonImages(vram, palette, ART, 0x06)
    const silver = renderPSwitchButtonImages(vram, palette, ART, 0x02)
    expect(pixel(silver.offRgba, 0, 0)).toEqual(color(9, indexOf('sp1', 0x24)))
    expect(blue.onRgba).not.toBe(silver.onRgba)
  })
})

describe('buildSwitchButtonArt', () => {
  const sub: SubTile = { charNum: 0, palette: 0, priority: false, flipX: false, flipY: false }
  const onOffTile: Map16Tile = { id: 0x112, tl: sub, tr: sub, bl: sub, br: sub }
  const onOffAlt = { kinds: ['onOff' as const], altRgbaBase64: 'b25PZmY=', hidden: false }

  it('has no P-switch art when the read refuses, and says why for both', () => {
    const empty = new RomFile('stub.sfc', Buffer.alloc(0x80000))
    const r = buildSwitchButtonArt(empty, [], new Map(), buildVram(), palette)
    expect(r.art.blue).toBeUndefined()
    expect(r.art.silver).toBeUndefined()
    expect(r.unavailable.blue).toMatch(/CMP #\$3E/)
    expect(r.unavailable.silver).toBe(r.unavailable.blue)
  })

  it('draws blue from PSwitchPal[0] and silver from PSwitchPal[1]', () => {
    const vram = buildVram()
    const rom = pswitchRom({ blueAttr: 0x0a, silverAttr: 0x0c })
    const r = buildSwitchButtonArt(rom, [], new Map(), vram, palette)
    expect(r.unavailable.blue).toBeUndefined()
    const art = { ...ART, xOffset: 8, yOffset: 8, unpressedTile: 0x42, pressedTile: 0xfe }
    expect(r.art.blue).toEqual(
      renderPSwitchButtonImages(vram, palette, { ...art, blueAttr: 0x0a, silverAttr: 0x0c }, 0x0a),
    )
    expect(r.art.silver).toEqual(
      renderPSwitchButtonImages(vram, palette, { ...art, blueAttr: 0x0a, silverAttr: 0x0c }, 0x0c),
    )
  })

  it('takes ON/OFF from tile $112 and its own alternate, and says why when there is none', () => {
    const rom = pswitchRom()
    const withAlt = buildSwitchButtonArt(
      rom,
      [onOffTile],
      new Map([[0x112, [onOffAlt]]]),
      buildVram(),
      palette,
    )
    expect(withAlt.art.onOff?.onRgba).toBe(onOffAlt.altRgbaBase64)
    const without = buildSwitchButtonArt(rom, [onOffTile], new Map(), buildVram(), palette)
    expect(without.art.onOff).toBeUndefined()
    expect(without.unavailable.onOff).toMatch(/\$112/)
  })
})
