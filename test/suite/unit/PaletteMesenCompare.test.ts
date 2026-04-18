/**
 * A/B compare our buildLevelCgram output vs Mesen2 CGRAM dump.
 *
 * The CGRAM dump is 512 bytes = 256 BGR555 words (16 rows x 16 colors).
 * We compare our ROM-derived palette against the actual SNES hardware state.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadRomPalettes, buildLevelCgram } from '../../../src/rom/PaletteLoader'
import { bgr555ToRgba as toRgba } from '../../../src/rom/GraphicsDecoder'

const ROM_PATH   = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const CGRAM_PATH = resolve(__dirname, '../../../tools/mesen/Debugger/Super Mario World (USA) - SnesCgRam.dmp')
const romPresent   = existsSync(ROM_PATH)
const cgramPresent = existsSync(CGRAM_PATH)

describe('Palette vs Mesen CGRAM', () => {
  if (!romPresent || !cgramPresent) {
    it.skip('ROM or CGRAM dump not available', () => {})
    return
  }

  const rom = SmwRom.open(ROM_PATH)
  const cgramBuf = readFileSync(CGRAM_PATH)

  // We don't know which level/variant the CGRAM was captured from.
  // Try the most common: tileset 0, BG variant 0, FG variant 0.
  // If mismatches cluster in specific rows, we can identify the variant.

  it('compare all 256 CGRAM colors (variant 0/0/0)', () => {
    const palettes = loadRomPalettes(rom.rom)
    const cgram = buildLevelCgram(palettes, 0, 0, 0, 0)

    let matches = 0, mismatches = 0

    console.log('\nCGRAM comparison (our vs Mesen):')
    for (let row = 0; row < 16; row++) {
      const rowMismatches: string[] = []
      for (let col = 0; col < 16; col++) {
        const idx = row * 16 + col
        const mesenWord = cgramBuf[idx * 2] | (cgramBuf[idx * 2 + 1] << 8)
        const mesenRgba = toRgba(mesenWord)

        const ourRgba = cgram.rows[row][col]

        const match = ourRgba[0] === mesenRgba[0] &&
                      ourRgba[1] === mesenRgba[1] &&
                      ourRgba[2] === mesenRgba[2]

        if (match) {
          matches++
        } else {
          mismatches++
          const ourHex = `#${ourRgba[0].toString(16).padStart(2,'0')}${ourRgba[1].toString(16).padStart(2,'0')}${ourRgba[2].toString(16).padStart(2,'0')}`
          const mesHex = `#${mesenRgba[0].toString(16).padStart(2,'0')}${mesenRgba[1].toString(16).padStart(2,'0')}${mesenRgba[2].toString(16).padStart(2,'0')}`
          const mesBgr = `$${mesenWord.toString(16).padStart(4,'0')}`
          rowMismatches.push(`col${col}: our=${ourHex} mesen=${mesHex} (${mesBgr})`)
        }
      }
      if (rowMismatches.length > 0) {
        console.log(`  Row ${row.toString().padStart(2)}: ${rowMismatches.length} mismatches`)
        for (const m of rowMismatches) console.log(`    ${m}`)
      } else {
        console.log(`  Row ${row.toString().padStart(2)}: ✓ all 16 match`)
      }
    }

    console.log(`\n  TOTAL: ${matches} match, ${mismatches} mismatch out of 256`)
  })
})
