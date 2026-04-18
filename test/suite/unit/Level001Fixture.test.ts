/**
 * Diff our TS port's expansion of level $001 against the Mesen-captured
 * fixture at test/fixtures/level_001_map16.txt. Not asserted strictly
 * (fixture has `???` unobserved cells and one collected dragon coin); just
 * prints diff count.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { expandMap, TILE_EMPTY } from '../../../src/rom/ObjectExpander'

const ROM_PATH     = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const FIXTURE_PATH = resolve(__dirname, '../../fixtures/level_001_map16.txt')

describe.skipIf(!existsSync(ROM_PATH) || !existsSync(FIXTURE_PATH))('level $001 fixture diff', () => {
  it('counts diffs vs Mesen fixture', () => {
    const rom = SmwRom.open(ROM_PATH)
    const rawL1 = rom.getLevelRawData(0x001)
    if (!rawL1) throw new Error('no level')
    const { header, objects } = parseLevelObjects(rawL1)
    const grid = expandMap(objects, header.levelLength, rom.rom, header.objectTileset)

    const text = readFileSync(FIXTURE_PATH, 'utf8')
    let minCol = 0
    for (const l of text.split(/\r?\n/)) {
      const m = l.match(/min_col=(\d+)/)
      if (m) { minCol = Number(m[1]); break }
    }

    let observed = 0, matched = 0
    const firstDiffs: { col: number; row: number; ours: number; fix: number }[] = []
    for (const line of text.split(/\r?\n/)) {
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
        else if (firstDiffs.length < 100) firstDiffs.push({ col, row, ours: actual, fix: expected })
      }
    }

    console.log(`\nobserved: ${observed}  matched: ${matched}  mismatched: ${observed - matched}`)
    if (firstDiffs.length > 0) {
      console.log(`first ${firstDiffs.length} diffs:`)
      for (const d of firstDiffs) {
        console.log(`  (col=${d.col.toString().padStart(3)}, row=${d.row.toString().padStart(2)})  ours=$${d.ours.toString(16).padStart(3, '0').toUpperCase()}  fixture=$${d.fix.toString(16).padStart(3, '0').toUpperCase()}`)
      }
    }
    expect(observed).toBeGreaterThan(0)
  })
})
