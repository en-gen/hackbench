/**
 * Trace the rendering pipeline for specific Map16 tiles in level $104.
 * Shows: Map16 ID → subtile char numbers → VRAM slot → GFX file → pixel data
 */
import { SmwRom } from '../src/rom/SmwRom'
import { loadAllMap16 } from '../src/rom/Map16'
import { loadVram, readGfxAssignment, getCharPixels, VRAM_CHAR_BASE } from '../src/rom/GfxLoader'

const rom = SmwRom.open('test/roms/Super Mario World (USA).sfc')
const map16 = loadAllMap16(rom.rom)

const tilesetId = rom.getGfxTilesetId(0x104)
const rawL1 = rom.getLevelRawData(0x104)!
const spriteSet = rawL1[3] & 0x0F

console.log(`Level $104: tileset=${tilesetId} spriteSet=${spriteSet}`)
console.log()

const assignment = readGfxAssignment(rom.rom, tilesetId, spriteSet)
console.log('GFX file assignments:')
for (const [slot, fileIdx] of Object.entries(assignment)) {
  if (fileIdx === undefined) continue
  const base = VRAM_CHAR_BASE[slot as keyof typeof VRAM_CHAR_BASE]
  console.log(`  ${slot}: GFX${fileIdx.toString(16).toUpperCase().padStart(2, '0')} → chars $${base.toString(16).toUpperCase()}-$${(base + 0x7F).toString(16).toUpperCase()}`)
}

const vram = loadVram(rom.rom, tilesetId, spriteSet)
console.log()

// Trace specific Map16 tiles from ground truth
const testTiles = [0xCF, 0xD3, 0xDD, 0x0F, 0xE5, 0xEA, 0xCB]
for (const id of testTiles) {
  const t = map16[id]
  console.log(`Map16 $${id.toString(16).toUpperCase()}:`)
  for (const [label, sub] of [['TL', t.tl], ['BL', t.bl], ['TR', t.tr], ['BR', t.br]] as const) {
    const charNum = sub.charNum
    const slotEntry = Object.entries(VRAM_CHAR_BASE).find(
      ([, base]) => charNum >= base && charNum < base + 128
    )
    const slotName = slotEntry ? slotEntry[0] : 'NONE'
    const pixels = getCharPixels(vram, charNum)
    const nonZero = pixels ? pixels.filter(p => p > 0).length : 0
    console.log(`  ${label}: char=$${charNum.toString(16).padStart(3, '0')} pal=${sub.palette} flip=${sub.flipX ? 'X' : ''}${sub.flipY ? 'Y' : ''} → slot=${slotName} pixels=${pixels ? nonZero + '/64' : 'MISSING'}`)
  }
  console.log()
}
