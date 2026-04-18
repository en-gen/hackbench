/**
 * Trace all objects for a level and show what each handler needs to do.
 * This tells us exactly which handlers we need to port.
 */
import { SmwRom } from '../src/rom/SmwRom'
import { parseLevelObjects } from '../src/rom/LevelParser'

const ROM_PATH = process.env.HOME
  ? `${process.env.HOME}/Super Mario World (USA).sfc`
  : `${process.env.USERPROFILE}/Super Mario World (USA).sfc`

const rom = SmwRom.open(ROM_PATH)

// Check multiple levels
const levels = [0x104, 0x105, 0x001, 0x002, 0x003, 0x00D, 0x115]

for (const idx of levels) {
  const raw = rom.getLevelRawData(idx)
  if (!raw) { console.log(`Level $${idx.toString(16)}: no data`); continue }

  const { header, objects } = parseLevelObjects(raw)
  const screens = header.levelLength + 1

  console.log(`\nLevel $${idx.toString(16).toUpperCase()} (${screens} screens, tileset ${header.bgTypeId}):`)
  console.log(`  ${objects.length} objects:`)

  // Count by type
  const extCounts = new Map<number, number>()
  const stdCounts = new Map<number, number>()

  for (const obj of objects) {
    if (obj.objectType === 0) {
      // Extended - param is the ext type
      extCounts.set(obj.param, (extCounts.get(obj.param) || 0) + 1)
    } else {
      stdCounts.set(obj.objectType, (stdCounts.get(obj.objectType) || 0) + 1)
    }
  }

  if (extCounts.size > 0) {
    console.log('  Extended objects:')
    for (const [ext, count] of [...extCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    ext $${ext.toString(16).padStart(2, '0')} × ${count}`)
    }
  }
  if (stdCounts.size > 0) {
    console.log('  Standard objects:')
    for (const [obj, count] of [...stdCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    obj $${obj.toString(16).padStart(2, '0')} × ${count}`)
    }
  }
}
