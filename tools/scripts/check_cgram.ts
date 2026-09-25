/**
 * Palette regression verdict: compare our buildLevelCgram derivation against
 * the PPU CGRAM that Mesen actually held at level entry.
 *
 * Input is a capture root produced by tools/scripts/run_headless_capture.ps1
 * (one <hex> subdirectory per level, each holding frame_0000_cgram.bin).
 * Nothing is written anywhere; this only reads and prints.
 *
 *   npx tsx tools/scripts/check_cgram.ts <capture-root> [--frame 0000] [--verbose]
 *
 * Exit 0 = every level agreed on every compared index. Exit 1 = at least one
 * disagreed. Exit 2 = nothing was compared (no captures found), which is a
 * failure too: see docs/spikes/cgram-oracle.md on why "compared zero things" must
 * never report success.
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { SmwRom } from '../../src/rom/SmwRom'
import { parseLevelObjects } from '../../src/rom/LevelParser'
import { loadRomPalettes, buildLevelCgram, STOCK_COL1 } from '../../src/rom/PaletteLoader'
import { bgr555ToRgba } from '../../src/rom/GraphicsDecoder'
import {
  compareCgram,
  parseCgramCapture,
  EXCLUDED_INDICES,
  ROM_WRITTEN_INDICES,
} from '../../src/rom/CgramOracle'

const args = process.argv.slice(2)
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--frame')
const root = positional[0]
const frameIdx = args.indexOf('--frame')
const frame = frameIdx >= 0 ? args[frameIdx + 1] : '0000'
const verbose = args.includes('--verbose')
const romPath =
  process.env.HB_ROM ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

if (!root || !existsSync(root)) {
  console.error(
    `usage: check_cgram.ts <capture-root> [--frame NNNN] [--verbose]\ncapture root not found: ${root}`,
  )
  process.exit(2)
}

const rom = SmwRom.open(romPath)
const verticalTable = rom.requireVerticalTable()
const levels = readdirSync(root)
  .filter(n => /^[0-9a-f]{3}$/i.test(n))
  .filter(n => existsSync(join(root, n, `frame_${frame}_cgram.bin`)))
  .map(n => n.toLowerCase())
  .sort()

console.log(`CGRAM oracle: ${levels.length} capture(s) under ${root}, frame ${frame}`)
const writtenCompared = [...ROM_WRITTEN_INDICES].filter(i => !EXCLUDED_INDICES.has(i)).length
console.log(`compared indices: ${256 - EXCLUDED_INDICES.size} of 256 -- ${writtenCompared} the ROM provably writes (load-bearing), ${256 - EXCLUDED_INDICES.size - writtenCompared} it never writes (agreement there is weak evidence: both sides are usually zero), ${EXCLUDED_INDICES.size} excluded
`)

let failed = 0
for (const hex of levels) {
  const lvl = parseInt(hex, 16)
  const raw = rom.getLevelRawData(lvl)
  if (!raw) {
    console.log(`  $${hex.toUpperCase()}  ERROR no L1 data`)
    failed++
    continue
  }
  const { header } = parseLevelObjects(raw, verticalTable)
  const derived = buildLevelCgram(
    loadRomPalettes(rom.rom, header.bgPalette),
    header.bgPalette,
    header.fgPalette,
    header.spritePalette,
    STOCK_COL1,
  )
  const captured = parseCgramCapture(readFileSync(join(root, hex, `frame_${frame}_cgram.bin`)))
  const c = compareCgram(captured, derived.colors, bgr555ToRgba)
  if (!c.ok) failed++
  console.log(
    `  $${hex.toUpperCase()}  ${c.ok ? 'PASS' : 'FAIL'}  ` +
      `rom-written ${c.writtenCompared - c.writtenMismatched}/${c.writtenCompared}, ` +
      `never-written ${c.unwrittenCompared - c.unwrittenMismatched}/${c.unwrittenCompared}` +
      (c.ok
        ? ''
        : `  mismatch idx: ${c.mismatches.map(m => '$' + m.index.toString(16)).join(' ')}`),
  )
  if (verbose) {
    for (const m of c.mismatches) {
      console.log(
        `      $${m.index.toString(16).padStart(2, '0')} ${m.romWritten ? 'rom-written' : 'never-written'}  ` +
          `hw=${m.expected.join(',')}  ours=${m.actual.join(',')}`,
      )
    }
  }
}

if (levels.length === 0) {
  console.error('\nFAIL: no captures found -- compared nothing, which is not a pass.')
  process.exit(2)
}
console.log(`\n${levels.length - failed}/${levels.length} levels agree.`)
process.exit(failed > 0 ? 1 : 0)
