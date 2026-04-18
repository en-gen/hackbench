/**
 * Diagnostic: investigate why level $002 renders no L1 tiles.
 * Dumps raw header, parsed objects, our expanded grid, and diffs against
 * the Mesen-stitched fixture at test/levels/002/map16.txt.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { expandMap, TILE_EMPTY } from '../../../src/rom/ObjectExpander'

const ROM_PATH     = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const FIXTURE_PATH = resolve(__dirname, '../../levels/002/map16.txt')
const OUR_GRID_OUT = resolve(__dirname, '../../../tools/mesen/level_002_our_grid.txt')

function hx(n: number, w = 2) { return n.toString(16).padStart(w, '0').toUpperCase() }

describe.skipIf(!existsSync(ROM_PATH))('level $002 debug', () => {
  it('dumps state and diffs vs fixture', () => {
    const rom = SmwRom.open(ROM_PATH)

    const ptr = rom.getLevelL1Pointer(0x002)
    console.log(`\nL1 pointer for $002: ${ptr === null ? 'null' : '$' + hx(ptr, 6)}`)

    const rawL1 = rom.getLevelRawData(0x002)
    if (!rawL1) { console.log('no raw data'); return }
    console.log(`raw L1 bytes (first 64): ${Array.from(rawL1.slice(0, 64)).map(b => hx(b)).join(' ')}`)

    const { header, objects } = parseLevelObjects(rawL1)
    console.log(`header: length=${header.levelLength} mode=${header.levelMode} fgPal=${header.fgPalette} tileset=${header.objectTileset} spriteSet=${header.spriteSet}`)
    console.log(`objects parsed: ${objects.length}`)
    console.log('\nALL objects (index, type, screen, x, y, objNum, size, raw, ns, hi):')
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i]
      console.log(`  #${i.toString().padStart(2)}  ${o.type.padEnd(8)} scr=${o.screen.toString().padStart(2)} x=${o.x.toString().padStart(3)} y=${o.y.toString().padStart(2)} objNum=$${hx(o.objectNumber)} set=$${hx(o.settings)} raw=${o.raw.map(b => hx(b)).join(' ')} ns=${o.newScreen?'Y':'.'} hi=${o.highCoord?'Y':'.'}`)
    }

    const grid = expandMap(objects, header.levelLength, rom.rom, header.objectTileset)
    const cols = grid[0]?.length ?? 0
    let nonEmpty = 0
    for (const row of grid) for (const t of row) if (t !== TILE_EMPTY) nonEmpty++
    console.log(`grid: ${grid.length} rows x ${cols} cols; non-empty tiles: ${nonEmpty}`)

    // Dump our grid in the same format as the Mesen fixture for visualize_fixture_diff.py
    mkdirSync(dirname(OUR_GRID_OUT), { recursive: true })
    const lines: string[] = []
    lines.push(`# our grid level $002. col 0..${cols - 1} inclusive, rows 0..${grid.length - 1}.`)
    lines.push(`# min_col=0 max_col=${cols - 1} rows=${grid.length}`)
    for (let r = 0; r < grid.length; r++) {
      const parts = [`r${r.toString().padStart(2)}:`]
      for (let c = 0; c < cols; c++) {
        const t = grid[r][c]
        parts.push(t === TILE_EMPTY ? ' . ' : t.toString(16).padStart(3, '0'))
      }
      lines.push(parts.join(' '))
    }
    writeFileSync(OUR_GRID_OUT, lines.join('\n') + '\n', 'utf8')
    console.log(`our grid written to ${OUR_GRID_OUT}`)

    if (!existsSync(FIXTURE_PATH)) { console.log(`fixture not present: ${FIXTURE_PATH}`); return }

    const text = readFileSync(FIXTURE_PATH, 'utf8')
    let minCol = 0
    for (const l of text.split(/\r?\n/)) {
      const m = l.match(/min_col=(\d+)/)
      if (m) { minCol = Number(m[1]); break }
    }

    let observed = 0, matched = 0
    const allDiffs: { col: number; row: number; ours: number; fix: number }[] = []
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
        else allDiffs.push({ col, row, ours: actual, fix: expected })
      }
    }
    // Ignore fixture observations past the level boundary (our grid ends at screens*16).
    const inBounds = allDiffs.filter(d => d.col < cols)
    console.log(`\nobserved: ${observed}  matched: ${matched}  mismatched: ${observed - matched}  (in-bounds diffs: ${inBounds.length})`)

    // Focus on the end-of-level window that the user is looking at (screen $0F = cols 240-255).
    const endWindow = inBounds.filter(d => d.col >= 240)
    console.log(`\nend-of-level diffs (cols 240+): ${endWindow.length}`)
    for (const d of endWindow) {
      console.log(`  (col=${d.col.toString().padStart(3)}, row=${d.row.toString().padStart(2)})  ours=$${hx(d.ours, 3)}  fixture=$${hx(d.fix, 3)}`)
    }

    // Also show any in-bounds diffs elsewhere for completeness.
    const otherDiffs = inBounds.filter(d => d.col < 240)
    if (otherDiffs.length > 0) {
      console.log(`\nother in-bounds diffs: ${otherDiffs.length}`)
      for (const d of otherDiffs) {
        console.log(`  (col=${d.col.toString().padStart(3)}, row=${d.row.toString().padStart(2)})  ours=$${hx(d.ours, 3)}  fixture=$${hx(d.fix, 3)}`)
      }
    }
    expect(observed).toBeGreaterThan(0)
  })
})
