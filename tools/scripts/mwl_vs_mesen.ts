/**
 * Extract the L1 object stream from a Lunar Magic .mwl file, run our
 * ObjectExpander on it, and diff the resulting Map16 grid against a
 * Mesen-captured fixture.
 *
 * Run: npx tsx tools/scripts/mwl_vs_mesen.ts
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../src/rom/SmwRom'
import { parseLevelObjects } from '../../src/rom/LevelParser'
import { expandMap, TILE_EMPTY } from '../../src/rom/ObjectExpander'

const MWL_PATH     = resolve('C:/Projects/frontend/tools/magic/001.mwl')
const FIXTURE_PATH = resolve('C:/Projects/frontend/test/fixtures/levels/001/map16.txt')
const ROM_PATH     = process.env.USERPROFILE + '/Super Mario World (USA).vanilla.sfc'

const mwl = readFileSync(MWL_PATH)

// MWL pointer table at offset 0x40: eight (offset, length) u32 pairs.
// Section index 1 is the L1 block.
const l1Off = mwl.readUInt32LE(0x40 + 1 * 8)
const l1Len = mwl.readUInt32LE(0x40 + 1 * 8 + 4)

// L1 block layout: 4 pad bytes + 4 bytes LM metadata, 5-byte level header, object stream, $FF terminator.
// First 4 bytes of the block are 00 00 00 00 padding; next 4 bytes (e.g. "69 ba 06 00" for lvl 1)
// are LM-specific prefix; the standard SMW 5-byte level header starts 8 bytes in.
const l1 = mwl.subarray(l1Off + 8, l1Off + l1Len)
console.log(`MWL L1 block: offset=0x${l1Off.toString(16)} len=0x${l1Len.toString(16)} (${l1Len}B)`)
console.log(`  first 16 bytes: ${Array.from(l1.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

// Compare against ROM's L1 for level $001.
const rom = SmwRom.open(ROM_PATH)
const romL1 = rom.getLevelRawData(0x001)!
console.log(`\nROM L1 (level $001): len=${romL1.length}`)
console.log(`  first 16 bytes: ${Array.from(romL1.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

// Walk both to the $FF terminator and byte-diff.
function findTerm(buf: Uint8Array): number {
  // skip 5-byte header, then 3-byte objects until b0==0xFF
  let p = 5
  while (p < buf.length && buf[p] !== 0xFF) p += 3
  return p
}
const mwlEnd = findTerm(l1)
const romEnd = findTerm(romL1)
console.log(`\nL1 streams (header+objects+FF): MWL=${mwlEnd + 1}B  ROM=${romEnd + 1}B`)

let matchBytes = 0, diffBytes = 0
const n = Math.min(mwlEnd + 1, romEnd + 1)
const firstByteDiffs: number[] = []
for (let i = 0; i < n; i++) {
  if (l1[i] === romL1[i]) matchBytes++
  else { diffBytes++; if (firstByteDiffs.length < 10) firstByteDiffs.push(i) }
}
console.log(`  byte compare (first ${n}B): match=${matchBytes}  diff=${diffBytes}`)
if (firstByteDiffs.length > 0) {
  console.log(`  first diff offsets: ${firstByteDiffs.map(o => '0x' + o.toString(16)).join(', ')}`)
}

// Expand the MWL's L1 stream and diff against the Mesen fixture.
const { header, objects } = parseLevelObjects(l1)
console.log(`\nExpanded from MWL: header=${Array.from(header.raw).map(b => '$' + b.toString(16).padStart(2, '0')).join(' ')}`)
console.log(`  ${objects.length} objects, ${header.levelLength} screens, tileset=${header.objectTileset}`)

const grid = expandMap(objects, header.levelLength, rom.rom, header.objectTileset)

const fixText = readFileSync(FIXTURE_PATH, 'utf8')
let minCol = 0
for (const l of fixText.split(/\r?\n/)) {
  const m = l.match(/min_col=(\d+)/)
  if (m) { minCol = Number(m[1]); break }
}

let observed = 0, matched = 0, mism = 0
const firstDiffs: { col: number; row: number; ours: number; fix: number }[] = []
for (const line of fixText.split(/\r?\n/)) {
  const m = line.match(/^r\s*(\d+):\s*(.*)/)
  if (!m) continue
  const row = Number(m[1])
  const tokens = m[2].trim().split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '???') continue
    const expected = tok === '.' ? TILE_EMPTY : parseInt(tok, 16)
    const col = minCol + i
    observed += 1
    const actual = grid[row]?.[col] ?? TILE_EMPTY
    if (actual === expected) matched += 1
    else { mism += 1; if (firstDiffs.length < 20) firstDiffs.push({ col, row, ours: actual, fix: expected }) }
  }
}

console.log(`\nMWL-expanded vs Mesen fixture:`)
console.log(`  observed=${observed}  matched=${matched}  mismatched=${mism}  (${((matched / observed) * 100).toFixed(2)}%)`)
if (firstDiffs.length > 0) {
  console.log(`  first ${firstDiffs.length} diffs:`)
  for (const d of firstDiffs) {
    const ours = '$' + d.ours.toString(16).padStart(3, '0').toUpperCase()
    const fix = '$' + d.fix.toString(16).padStart(3, '0').toUpperCase()
    console.log(`    col=${d.col.toString().padStart(3)} row=${d.row.toString().padStart(2)}  ours=${ours}  fixture=${fix}`)
  }
}
