/**
 * Print the cells that differ between our ObjectExpander output and the Mesen
 * fixture for one level. Usage:
 *   npx tsx tools/scripts/diff_cells.ts 00a [max]
 */
import { readFileSync } from 'fs'
import { SmwRom } from '../../src/rom/SmwRom'
import { parseLevelObjects, SCREEN_W } from '../../src/rom/LevelParser'
import { expandMap, TILE_EMPTY } from '../../src/rom/ObjectExpander'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`
// HB_MAPS_DIR lets a run point at a scratch copy, matching gen_diff_images.
const MAPS_DIR =
  process.env.HB_MAPS_DIR ??
  `${process.env.USERPROFILE ?? process.env.HOME}/OneDrive/hackbench-fixtures/maps`
const arg = process.argv[2]
const max = Number(process.argv[3] ?? 40)
if (!arg) {
  console.error('Usage: npx tsx tools/scripts/diff_cells.ts <hex> [maxLines]')
  process.exit(1)
}
const levelNum = parseInt(arg, 16)

const rom = SmwRom.open(ROM_PATH)
const raw = rom.getLevelRawData(levelNum)!
const { header, objects } = parseLevelObjects(raw, rom.requireVerticalTable())
const ourGrid = expandMap(
  objects,
  header.levelLength,
  rom.rom,
  header.objectTileset,
  false,
  header.levelMode,
  levelNum,
)

const text = readFileSync(`${MAPS_DIR}/${arg}/map16.txt`, 'utf8')
let minCol = 0,
  maxCol = 0
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/min_col=(\d+)\s+max_col=(\d+)/)
  if (m) {
    minCol = Number(m[1])
    maxCol = Number(m[2])
    break
  }
}
const rows: Record<number, (number | null)[]> = {}
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^r\s*(\d+):\s*(.*)/)
  if (!m) continue
  const row = Number(m[1])
  rows[row] = m[2]
    .trim()
    .split(/\s+/)
    .map(t => (t === '???' ? null : t === '.' ? TILE_EMPTY : parseInt(t, 16)))
}

// Cap comparison at the level's declared width. The Mesen walker reads
// WRAM unconditionally, so fixture columns beyond levelLength*16 contain
// data from adjacent WRAM regions (overworld event tilemap, etc.), not
// actual level tiles. Comparing against them always produces false diffs.
const levelMaxCol = header.levelLength * SCREEN_W - 1
const cappedMaxCol = Math.min(maxCol, levelMaxCol)
const cols = cappedMaxCol - minCol + 1
let shown = 0
const byExpected = new Map<string, number>()
const byActual = new Map<string, number>()
let totalDiffs = 0
for (let r = 0; r < 27; r++) {
  const rowArr = rows[r] ?? []
  for (let c = 0; c < cols; c++) {
    const expected = rowArr[c]
    if (expected == null) continue
    const actual = ourGrid[r]?.[minCol + c] ?? TILE_EMPTY
    if (actual !== expected) {
      totalDiffs++
      const exK = expected.toString(16).padStart(3, '0')
      const acK = actual.toString(16).padStart(3, '0')
      byExpected.set(exK, (byExpected.get(exK) ?? 0) + 1)
      byActual.set(acK, (byActual.get(acK) ?? 0) + 1)
      if (shown < max) {
        console.log(
          `  r=${r.toString().padStart(2)} c=${(minCol + c).toString().padStart(3)}  expected=$${exK}  actual=$${acK}`,
        )
        shown++
      }
    }
  }
}
console.log(`\ntotal diffs: ${totalDiffs}`)
console.log('\nmost common expected tiles (we got something else):')
for (const [k, v] of [...byExpected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  $${k}  x${v}`)
}
console.log('\nmost common actual tiles (where expected was different):')
for (const [k, v] of [...byActual.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  $${k}  x${v}`)
}
