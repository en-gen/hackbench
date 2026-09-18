/**
 * Yoshi Egg ($2C) - buildYoshiEggLayout and the SpriteFactory branch that uses it.
 *
 * The ROM-gated block pins the YoshiPal bytes the layout is derived from, so a
 * change in the ROM fails loudly and separately from a change in the
 * derivation. The layout expectations are written as literals on purpose: a
 * test that recomputes them with the implementation's own formula could not
 * go red on a wrong selector.
 *
 * Two deliberate properties of the synthetic fixture:
 *   - yoshiPal holds four DISTINCT bytes. Vanilla's $09,$07,$05,$07 repeats
 *     $07 at indices 1 and 3, so a mutation permuting those two would pass.
 *   - tilemap/tilemapOffset are poisoned with non-zero values. The resting
 *     char is the ASM immediate $00, never a table read, so any re-introduced
 *     SprTilemap lookup shows up as a wrong char.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  buildSpriteLayout,
  buildYoshiEggLayout,
  readSpriteTileTables,
  YOSHI_EGG_ID,
  type SpriteTileTables,
} from '../../../src/rom/SpriteTileLoader'
import { RomFile } from '../../../src/rom/RomFile'
import { buildSprites } from '../../../src/rom/model/SpriteFactory'
import { StaticSpriteAppearance } from '../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import type { Char } from '../../../src/rom/model/chars/Char'
import type { Tile } from '../../../src/rom/model/tiles/Tile'

const ROM_PATH   = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

// ── synthetic tables ─────────────────────────────────────────────────────────

/** Poison values. buildYoshiEggLayout must not read SprTilemap at all, so
 *  every entry it could reach is non-zero and they all differ from each other. */
const POISON_TILEMAP_OFFSET = 0x94
const POISON_BASE_CHAR      = 0x40

/** Four distinct bytes, unlike vanilla's $09,$07,$05,$07 which repeats $07.
 *  Decoded: palettes 8/9/10/11, char-high set on all four. */
const SYN_YOSHI_PAL = [0x01, 0x03, 0x05, 0x07] as const

function makeTables(overrides: Partial<SpriteTileTables> = {}): SpriteTileTables {
  const tilemap       = new Uint8Array(0xFC)
  const tilemapOffset = new Uint8Array(0x54)
  tilemapOffset[YOSHI_EGG_ID] = POISON_TILEMAP_OFFSET
  tilemap[POISON_TILEMAP_OFFSET] = POISON_BASE_CHAR
  tilemapOffset[YOSHI_EGG_ID - 1] = 0x10
  tilemapOffset[YOSHI_EGG_ID + 1] = 0x20
  tilemap[0x10] = 0x66
  tilemap[0x20] = 0x77
  return {
    tilemap,
    tilemapOffset,
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    gfxProp: new Array(24).fill(0),
    spriteAttr: new Uint8Array(0x100),
    spr0to13Prop: new Uint8Array(0x14),
    yoshiPal: Uint8Array.from(SYN_YOSHI_PAL),
    ...overrides,
  }
}

/** All four corners of an unflipped base-$00 big-tile, charHigh $100. */
const UNFLIPPED_CHARS = [0x500, 0x501, 0x510, 0x511]
const FLIPX_CHARS     = [0x501, 0x500, 0x511, 0x510]
const FLIPY_CHARS     = [0x510, 0x511, 0x500, 0x501]
const FLIPXY_CHARS    = [0x511, 0x510, 0x501, 0x500]

describe('buildYoshiEggLayout - palette selection by X position', () => {
  // InitYoshiEgg indexes YoshiPal with (SpriteXPosLow >> 4) & 3.
  // SYN_YOSHI_PAL = $01/$03/$05/$07 → palette bits 0/1/2/3 → CGRAM rows 8/9/10/11.
  // Four distinct rows, so permuting any two indices goes red.
  it.each([
    { pixelX: 0x00, row: 8 },
    { pixelX: 0x10, row: 9 },
    { pixelX: 0x20, row: 10 },
    { pixelX: 0x30, row: 11 },
    { pixelX: 0x40, row: 8 },    // wraps: index 4 & 3 = 0
    { pixelX: 0x8F, row: 8 },    // low nibble ignored
    { pixelX: 0xF0, row: 11 },
    { pixelX: 0x130, row: 11 },  // bits above 7 cannot reach the index either
  ])('pixelX $$pixelX → CGRAM row $row', ({ pixelX, row }) => {
    const layout = buildYoshiEggLayout(makeTables(), pixelX)
    expect(layout.tiles.map(t => t.palette)).toEqual([row, row, row, row])
  })

  it('clears char-high when the chosen YoshiPal byte has bit 0 clear', () => {
    const tables = makeTables({ yoshiPal: Uint8Array.from([0x08, 0x08, 0x08, 0x08]) })
    const layout = buildYoshiEggLayout(tables, 0x00)
    expect(layout.tiles.map(t => t.charNum)).toEqual([0x401, 0x400, 0x411, 0x410])
  })
})

describe('buildYoshiEggLayout - char is the ASM immediate, not SprTilemap', () => {
  // CODE_01F78D (bank_01.asm:16057) stamps LDA #$00 over the char
  // SubSprGfx2Entry1 took from SprTilemap, so the table is dead for $2C.
  it('ignores a poisoned SprTilemap entirely', () => {
    const layout = buildYoshiEggLayout(makeTables(), 0x00)
    // Poison base char is $40; a table read would give [$541,$540,$551,$550].
    expect(layout.tiles.map(t => t.charNum)).toEqual(FLIPX_CHARS)
  })

  it('is unaffected by a completely different SprTilemap', () => {
    const tilemap = new Uint8Array(0xFC).fill(0xAA)
    const tilemapOffset = new Uint8Array(0x54).fill(0x7F)
    const a = buildYoshiEggLayout(makeTables(), 0x00)
    const b = buildYoshiEggLayout(makeTables({ tilemap, tilemapOffset }), 0x00)
    expect(b.tiles.map(t => t.charNum)).toEqual(a.tiles.map(t => t.charNum))
  })
})

describe('buildYoshiEggLayout - mirrored 16x16 big-tile', () => {
  const layout = buildYoshiEggLayout(makeTables(), 0x00)

  it('is a single 16x16 unit of four 8x8 corners', () => {
    expect(layout.spriteId).toBe(0x2C)
    expect(layout.height).toBe(16)
    expect(layout.tiles).toHaveLength(4)
  })

  it('swaps the columns of the large-OBJ expansion', () => {
    expect(layout.tiles.map(t => t.charNum)).toEqual(FLIPX_CHARS)
  })

  it('mirrors every 8x8 char and flips none vertically', () => {
    expect(layout.tiles.map(t => t.flipX)).toEqual([true, true, true, true])
    expect(layout.tiles.map(t => t.flipY)).toEqual([false, false, false, false])
  })

  it('places corners at GeneralSprDispX/Y', () => {
    expect(layout.tiles.map(t => t.dx)).toEqual([0, 8, 0, 8])
    expect(layout.tiles.map(t => t.dy)).toEqual([0, 0, 8, 8])
  })
})

describe('buildYoshiEggLayout - flip comes from the attribute, not a literal', () => {
  // InitYoshiEgg (bank_01.asm:463-472) stores the YoshiPal byte UNMASKED, so
  // bits 4-7 are live. SubSprGfx2Entry1 (bank_01.asm:4171) EORs OBJ_XFlip
  // ($40, rammap.asm:527) rather than ORing it, so bit 6 CANCELS the mirror.
  // Vanilla's four entries are all under $10, so these cases only arise on a
  // hack, which is exactly why hardcoding flipX: true could not be caught.
  const fourOf = (b: number) => Uint8Array.from([b, b, b, b])
  const layoutFor = (attrByte: number) =>
    buildYoshiEggLayout(makeTables({ yoshiPal: fourOf(attrByte) }), 0x00)

  it.each([
    { attr: 0x09, flipX: true,  flipY: false, chars: FLIPX_CHARS  },
    { attr: 0x49, flipX: false, flipY: false, chars: UNFLIPPED_CHARS },
    { attr: 0x89, flipX: true,  flipY: true,  chars: FLIPXY_CHARS },
    { attr: 0xC9, flipX: false, flipY: true,  chars: FLIPY_CHARS  },
  ])('attr $$attr → flipX $flipX, flipY $flipY', ({ attr, flipX, flipY, chars }) => {
    const layout = layoutFor(attr)
    expect(layout.tiles.map(t => t.flipX)).toEqual([flipX, flipX, flipX, flipX])
    expect(layout.tiles.map(t => t.flipY)).toEqual([flipY, flipY, flipY, flipY])
    expect(layout.tiles.map(t => t.charNum)).toEqual(chars)
  })

  it('bits 4-7 do not disturb the palette or the char-high bit', () => {
    // $09 and $F9 differ only above bit 3, which is where palette stops.
    const plain = layoutFor(0x09)
    const noisy = layoutFor(0xF9)
    expect(noisy.tiles.map(t => t.palette)).toEqual(plain.tiles.map(t => t.palette))
    expect(noisy.tiles.every(t => t.charNum >= 0x500)).toBe(true)
  })

  it('OAM priority bits are deliberately not modelled', () => {
    // $29 sets priority 2 in bits 5-4. SpriteSubtile has no priority field and
    // no other layout in SpriteTileLoader models one, so $29 must decode
    // exactly like $09. Documented in docs/smw-sprite-2c-yoshi-egg.md.
    expect(layoutFor(0x29).tiles).toEqual(layoutFor(0x09).tiles)
  })
})

describe('buildYoshiEggLayout - ?? fallback branches', () => {
  it('empty yoshiPal → attr 0 → palette 8, charHigh 0, still mirrored', () => {
    const layout = buildYoshiEggLayout(makeTables({ yoshiPal: new Uint8Array(0) }), 0x00)
    expect(layout.tiles.map(t => t.palette)).toEqual([8, 8, 8, 8])
    expect(layout.tiles.map(t => t.charNum)).toEqual([0x401, 0x400, 0x411, 0x410])
    expect(layout.tiles.map(t => t.flipX)).toEqual([true, true, true, true])
  })

  it('empty disp tables → zero corner offsets', () => {
    const layout = buildYoshiEggLayout(makeTables({ dispX: [], dispY: [] }), 0x00)
    expect(layout.tiles.map(t => t.charNum)).toEqual(FLIPX_CHARS)
    expect(layout.tiles.map(t => t.dx)).toEqual([0, 0, 0, 0])
    expect(layout.tiles.map(t => t.dy)).toEqual([0, 0, 0, 0])
  })
})

// ── real ROM ─────────────────────────────────────────────────────────────────

// describe.skipIf still runs the describe body at collection time, so the ROM
// must only be opened inside a test or hook.
let romCache: RomFile | undefined
function loadRom(): RomFile {
  romCache ??= new RomFile(ROM_PATH, readFileSync(ROM_PATH))
  return romCache
}
function loadTables(): SpriteTileTables {
  return readSpriteTileTables(loadRom())!
}

describe.skipIf(!romPresent)('Yoshi Egg $2C (vanilla US ROM)', () => {

  it('YoshiPal ($01:8335) is the four attribute bytes InitYoshiEgg picks from', () => {
    const tables = loadTables()
    expect(Array.from(tables.yoshiPal)).toEqual([0x09, 0x07, 0x05, 0x07])
  })

  it('every vanilla YoshiPal byte leaves attribute bits 4-7 clear', () => {
    // Scope note for the flip derivation: it is exercised above with bits 4-7
    // set, but in THIS ROM they are always clear, so the egg is always
    // mirrored, never V-flipped, and never carries an OAM priority.
    const tables = loadTables()
    expect(Array.from(tables.yoshiPal).every(b => (b & 0xF0) === 0)).toBe(true)
  })

  it('Sprite166EVals[$2C] is dead data for this sprite', () => {
    // $3B & $0F = $0B → palette bits 5 → CGRAM row 13. InitYoshiEgg overwrites
    // it before the egg is ever drawn, so the generic path picks the wrong row.
    const tables = loadTables()
    expect(tables.spriteAttr[YOSHI_EGG_ID]).toBe(0x0B)
    const generic = buildSpriteLayout(tables, YOSHI_EGG_ID)!
    expect(generic.tiles.map(t => t.palette)).toEqual([13, 13, 13, 13])
    expect(generic.tiles.map(t => t.flipX)).toEqual([false, false, false, false])
  })

  it('resting layout is char $00 mirrored, on the palette for that column', () => {
    const layout = buildYoshiEggLayout(loadTables(), 0x00)
    expect(layout.tiles.map(t => t.charNum)).toEqual([0x501, 0x500, 0x511, 0x510])
    expect(layout.tiles.map(t => t.palette)).toEqual([12, 12, 12, 12])
    expect(layout.tiles.map(t => t.flipX)).toEqual([true, true, true, true])
  })

  it('palette cycles across every four 16px columns', () => {
    const tables = loadTables()
    const rows = [0, 1, 2, 3, 4, 5, 6, 7].map(col =>
      buildYoshiEggLayout(tables, (col * 16) & 0xFF).tiles[0].palette)
    expect(rows).toEqual([12, 11, 10, 11, 12, 11, 10, 11])
  })
})

describe.skipIf(!romPresent)('buildSprites - $2C uses the Yoshi Egg layout', () => {
  const NO_CHARS = new Map<number, Char>()
  const NO_TILES = new Map<number, Tile>()
  const MARIO    = { x: 0, y: 0 }
  const egg = (x: number): LevelSprite =>
    ({ screen: 0, x, y: 5, spriteId: YOSHI_EGG_ID, extraBit: false, raw: [0, 0, YOSHI_EGG_ID] })

  it('emits a static appearance with no idle animation', () => {
    const r = buildSprites(loadRom(), [egg(0)], NO_CHARS, [], MARIO, NO_TILES)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(YOSHI_EGG_ID)
    expect(r[0].appearance).toBeInstanceOf(StaticSpriteAppearance)
    // The hatch sequence is armed by Mario proximity, not EffFrame, so there
    // is nothing for the editor to tick.
    expect(r[0].appearance.tickAnimation).toBeUndefined()
  })

  it('carries the column-dependent palette and the mirror into the parts', () => {
    const r = buildSprites(loadRom(), [egg(0), egg(1), egg(2), egg(3)], NO_CHARS, [], MARIO, NO_TILES)
    const parts = r.map(s => (s.appearance as StaticSpriteAppearance).parts)
    expect(parts.map(p => p[0].palette)).toEqual([12, 11, 10, 11])
    expect(parts.every(p => p.every(q => q.flipX))).toBe(true)
  })
})
