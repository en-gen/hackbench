/**
 * Compare ROM-decoded GFX (3bpp) vs LM .bin exports (4bpp) for GFX08.
 * This tells us if our 3bpp decoder produces the same pixels as the
 * ground truth VRAM data.
 */
import { RomFile } from '../src/rom/RomFile'
import { loadGfxFile, loadGfxFileBin, getGfxBinDir } from '../src/rom/GfxLoader'

const rom = RomFile.load('test/roms/Super Mario World (USA).vanilla.sfc')
const binDir = getGfxBinDir(rom)!

// GFX08 = AN1 slot for tileset 4 (Yoshi's House level-specific tiles)
const fileIndex = 8
const romSheet = loadGfxFile(rom, fileIndex)  // 3bpp from ROM
const binSheet = loadGfxFileBin(binDir, fileIndex)!  // 4bpp from .bin

console.log(`GFX08: ROM decoded ${romSheet.length} tiles, .bin decoded ${binSheet.length} tiles`)

// Compare tile by tile
let totalMatch = 0, totalMismatch = 0
const mismatches: number[] = []
for (let t = 0; t < Math.min(romSheet.length, binSheet.length); t++) {
  let match = true
  for (let p = 0; p < 64; p++) {
    if (romSheet[t][p] !== binSheet[t][p]) {
      match = false
      break
    }
  }
  if (match) totalMatch++
  else {
    totalMismatch++
    mismatches.push(t)
  }
}

console.log(`Match: ${totalMatch}, Mismatch: ${totalMismatch}`)

if (mismatches.length > 0) {
  // Show first few mismatching tiles
  for (const t of mismatches.slice(0, 3)) {
    console.log(`\nTile ${t} (char $${(0x180 + t).toString(16)}):`)
    console.log('  ROM:', Array.from(romSheet[t].slice(0, 16)).join(','))
    console.log('  BIN:', Array.from(binSheet[t].slice(0, 16)).join(','))
  }
} else {
  console.log('\nAll tiles match! 3bpp ROM decode = 4bpp .bin decode')
}
