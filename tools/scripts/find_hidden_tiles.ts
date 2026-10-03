/**
 * Scan all 512 maps for P-switch-gated hidden tiles and report which
 * maps contain each. Usage:
 *   npx tsx tools/scripts/find_hidden_tiles.ts
 *
 * Tiles:
 *   $27 hidden door top       (Blue P-switch)
 *   $28 hidden door bottom    (Blue P-switch)
 *   $29 invisible ? block     (Blue P-switch)
 *   $2A P-switch coin         (Blue P-switch)
 *   $2F invisible coin        (Silver P-switch)
 */
import { SmwRom } from '../../src/rom/SmwRom'
import { parseLevelObjects } from '../../src/rom/LevelParser'
import { expandMap, SWITCH_FLAGS_UNCLEARED } from '../../src/rom/ObjectExpander'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`
const TARGETS = [0x27, 0x28, 0x29, 0x2a, 0x2f]
const LABEL: Record<number, string> = {
  0x27: 'door-top',
  0x28: 'door-bot',
  0x29: 'inv-?blk',
  0x2a: 'psw-coin',
  0x2f: 'inv-coin',
}

const rom = SmwRom.open(ROM_PATH)
const verticalTable = rom.requireVerticalTable()

type Hit = { count: number; cells: string[] }
const byMap = new Map<number, Map<number, Hit>>()
const byTile = new Map<number, number[]>() // tileId -> list of map nums

for (let lv = 0; lv < 0x200; lv++) {
  const raw = rom.getLevelRawData(lv)
  if (!raw) continue
  let grid
  try {
    const { header, objects } = parseLevelObjects(raw, verticalTable)
    grid = expandMap(
      objects,
      header.levelLength,
      rom.rom,
      header.objectTileset & 0x0f,
      false,
      header.levelMode,
      undefined,
      SWITCH_FLAGS_UNCLEARED,
      null,
    )
  } catch {
    continue
  }
  const perMap = new Map<number, Hit>()
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const t = grid[r][c]
      if (!TARGETS.includes(t)) continue
      const h = perMap.get(t) ?? { count: 0, cells: [] }
      h.count++
      if (h.cells.length < 3) h.cells.push(`(${c},${r})`)
      perMap.set(t, h)
    }
  }
  if (perMap.size > 0) {
    byMap.set(lv, perMap)
    for (const t of perMap.keys()) {
      const arr = byTile.get(t) ?? []
      arr.push(lv)
      byTile.set(t, arr)
    }
  }
}

console.log(`\nMaps containing P-switch-gated hidden tiles:\n`)
for (const [lv, hits] of [...byMap.entries()].sort((a, b) => a[0] - b[0])) {
  const parts: string[] = []
  for (const t of TARGETS) {
    const h = hits.get(t)
    if (h)
      parts.push(`$${t.toString(16).toUpperCase()}(${LABEL[t]})×${h.count} ${h.cells.join(',')}`)
  }
  console.log(`  map $${lv.toString(16).toUpperCase().padStart(3, '0')}: ${parts.join('  ')}`)
}

console.log(`\nSummary by tile:`)
for (const t of TARGETS) {
  const maps = byTile.get(t) ?? []
  const list = maps.map(m => `$${m.toString(16).toUpperCase().padStart(3, '0')}`).join(', ')
  console.log(
    `  $${t.toString(16).toUpperCase()} ${LABEL[t].padEnd(9)} ${maps.length.toString().padStart(3)} map(s): ${list || '(none)'}`,
  )
}
