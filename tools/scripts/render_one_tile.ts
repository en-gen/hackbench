/**
 * Render a single 8x8 tile from level $104 (Yoshi's House) to verify the GFX pipeline.
 *
 * Target tile (from Lunar Magic):
 *   Column 0, Row 48 (8x8 coords) = approximately Map16 col 0, row 24
 *   Tile index: $1EC (VRAM char number, in AN1 slot $180-$1FF)
 *   Palette index: 2
 *   No flip, no priority
 *
 * Run: npx tsx tools/scripts/render_one_tile.ts
 */

import { SmwRom } from '../src/rom/SmwRom'
import { loadVram, getCharPixels, readGfxAssignment, VRAM_CHAR_BASE } from '../src/rom/GfxLoader'
import { loadRomPalettes, buildLevelCgram } from '../src/rom/PaletteLoader'

const ROM_PATH = 'test/roms/Super Mario World (USA).vanilla.sfc'
const LEVEL_INDEX = 0x104
const TARGET_CHAR = 0x1EC
const TARGET_PALETTE_ROW = 2

const rom = SmwRom.open(ROM_PATH)

// Get the tileset for level $104
const tilesetId = rom.getGfxTilesetId(LEVEL_INDEX)
const rawL1 = rom.getLevelRawData(LEVEL_INDEX)
const spriteSet = rawL1 ? rawL1[3] & 0x0F : 0
const bgPalette = rawL1 ? (rawL1[0] >> 5) & 0x7 : 0
const bgColor = rawL1 ? (rawL1[1] >> 5) & 0x7 : 0

console.log(`Level $${LEVEL_INDEX.toString(16).toUpperCase()}:`)
console.log(`  tilesetId = ${tilesetId}`)
console.log(`  spriteSet = ${spriteSet}`)
console.log(`  bgPalette = ${bgPalette}`)
console.log(`  bgColor = ${bgColor}`)
console.log()

// Show GFX file assignments
const assignment = readGfxAssignment(rom.rom, tilesetId, spriteSet)
console.log('GFX file assignments:')
for (const [slot, fileIdx] of Object.entries(assignment)) {
  const base = VRAM_CHAR_BASE[slot as keyof typeof VRAM_CHAR_BASE]
  const hexIdx = fileIdx !== undefined ? `GFX${fileIdx.toString(16).toUpperCase().padStart(2, '0')}` : 'none'
  console.log(`  ${slot.padEnd(4)} = ${hexIdx} (file index ${fileIdx}) → chars $${base.toString(16).toUpperCase()}-$${(base + 0x7F).toString(16).toUpperCase()}`)
}
console.log()

// Load VRAM
const vram = loadVram(rom.rom, tilesetId, spriteSet)

// Look up target char
const pixels = getCharPixels(vram, TARGET_CHAR)
if (!pixels) {
  console.error(`ERROR: Char $${TARGET_CHAR.toString(16).toUpperCase()} not found in VRAM!`)
  console.log(`AN1 slot has ${vram.an1?.length ?? 0} tiles loaded`)
  console.log(`Target char $1EC is at AN1 offset ${TARGET_CHAR - VRAM_CHAR_BASE.an1} (AN1 base = $${VRAM_CHAR_BASE.an1.toString(16)})`)
  process.exit(1)
}

console.log(`Char $${TARGET_CHAR.toString(16).toUpperCase()} found! (AN1 slot, offset ${TARGET_CHAR - VRAM_CHAR_BASE.an1})`)
console.log(`Raw palette indices (8x8 grid):`)
for (let row = 0; row < 8; row++) {
  const indices = Array.from(pixels.slice(row * 8, row * 8 + 8))
  console.log(`  ${indices.map(i => i.toString(16).padStart(1, '0')).join(' ')}`)
}
console.log()

// Load palette and show the colors for palette row 2
const romPalettes = loadRomPalettes(rom.rom, bgColor)
const cgram = buildLevelCgram(romPalettes, bgPalette, 0, 0, 0)
const paletteRow = cgram.rows[TARGET_PALETTE_ROW]
if (paletteRow) {
  console.log(`Palette row ${TARGET_PALETTE_ROW} (RGBA):`)
  for (let i = 0; i < 16; i++) {
    const c = paletteRow[i]
    console.log(`  [${i.toString(16)}] = rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`)
  }
}
console.log()

// Render the tile as RGBA
console.log(`Rendered tile (RGBA color blocks):`)
for (let row = 0; row < 8; row++) {
  const colors: string[] = []
  for (let col = 0; col < 8; col++) {
    const palIdx = pixels[row * 8 + col]
    const rgba = paletteRow[palIdx]
    if (palIdx === 0) {
      colors.push('  .  ')  // transparent
    } else {
      colors.push(`${rgba[0].toString().padStart(3)},${rgba[1].toString().padStart(3)},${rgba[2].toString().padStart(3)}`)
    }
  }
  console.log(`  ${colors.join(' | ')}`)
}

// Also show which GFX file the AN1 slot loaded
const an1FileIdx = assignment.an1
console.log()
console.log(`AN1 slot loaded GFX file index ${an1FileIdx} (GFX${an1FileIdx?.toString(16).toUpperCase().padStart(2, '0')})`)
console.log(`Char $1EC = tile ${TARGET_CHAR - VRAM_CHAR_BASE.an1} within that file (0-indexed)`)
