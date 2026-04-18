/**
 * For every object in level $002, show: parsed objNum, the per-tileset
 * dispatcher + handler SNES address we look up, and whether we have a port
 * for that handler.
 */
import { describe, it } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { STANDARD_HANDLERS, EXTENDED_HANDLERS } from '../../../src/rom/objectHandlers/dispatch'
import {
  ADDR_TILESET_DISPATCH, ADDR_EXTENDED_DISPATCH,
  readLongPointer, readLongPointerTable,
  STANDARD_HANDLER_COUNT,
} from '../../../src/rom/objectHandlers/romData'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const hx = (n: number, w = 6) => '$' + n.toString(16).padStart(w, '0').toUpperCase()

describe.skipIf(!existsSync(ROM_PATH))('level $002 per-object dispatch trace', () => {
  it('shows handler address + ported status for each object', () => {
    const rom = SmwRom.open(ROM_PATH)
    const rawL1 = rom.getLevelRawData(0x002)!
    const { header, objects } = parseLevelObjects(rawL1)
    const tilesetIdx = header.objectTileset & 0x0F
    const dispatcherAddr = readLongPointer(rom.rom, ADDR_TILESET_DISPATCH + tilesetIdx * 3)!
    const stdTable = readLongPointerTable(rom.rom, (dispatcherAddr & 0xFFFFFF) + 10, STANDARD_HANDLER_COUNT)

    console.log(`\nlevel $002 objectTileset=${tilesetIdx} dispatcher=${hx(dispatcherAddr & 0xFFFFFF)}`)

    const summary: Record<string, { addr: number; count: number; ported: boolean; kind: string }> = {}
    for (const o of objects) {
      let addr: number
      let kind: string
      if (o.type === 'extended') {
        const ext = readLongPointer(rom.rom, ADDR_EXTENDED_DISPATCH + (o.objectNumber & 0xFF) * 3)
        addr = (ext ?? 0) & 0xFFFFFF
        kind = 'ext'
      } else {
        addr = stdTable[o.objectNumber - 1] & 0xFFFFFF
        kind = 'std'
      }
      const ported = kind === 'ext' ? addr in EXTENDED_HANDLERS : addr in STANDARD_HANDLERS
      const key = `${kind}:${hx(addr)}`
      if (!(key in summary)) summary[key] = { addr, count: 0, ported, kind }
      summary[key].count++
    }

    const rows = Object.entries(summary).sort(([, a], [, b]) => b.count - a.count)
    console.log(`\nhandler usage:`)
    console.log(`  count  kind  addr       ported`)
    for (const [key, v] of rows) {
      console.log(`  ${String(v.count).padStart(5)}  ${v.kind.padEnd(4)}  ${hx(v.addr)}  ${v.ported ? 'YES' : 'no'}`)
    }

    const portedStd = rows.filter(([, v]) => v.kind === 'std' && v.ported).reduce((s, [, v]) => s + v.count, 0)
    const unportedStd = rows.filter(([, v]) => v.kind === 'std' && !v.ported).reduce((s, [, v]) => s + v.count, 0)
    const portedExt = rows.filter(([, v]) => v.kind === 'ext' && v.ported).reduce((s, [, v]) => s + v.count, 0)
    const unportedExt = rows.filter(([, v]) => v.kind === 'ext' && !v.ported).reduce((s, [, v]) => s + v.count, 0)
    console.log(`\nstd: ${portedStd} ported / ${unportedStd} unported     ext: ${portedExt} ported / ${unportedExt} unported`)
  })
})
