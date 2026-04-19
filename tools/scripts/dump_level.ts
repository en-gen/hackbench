/**
 * Dump a level's header and parsed object stream, noting which handler each
 * object dispatches to and whether we have a port for it. Usage:
 *   npx tsx tools/scripts/dump_level.ts 00a
 */
import { SmwRom } from '../../src/rom/SmwRom'
import { parseLevelObjects } from '../../src/rom/LevelParser'
import { STANDARD_HANDLERS, EXTENDED_HANDLERS } from '../../src/rom/objectHandlers/dispatch'
import {
  ADDR_EXTENDED_DISPATCH, ADDR_TILESET_DISPATCH,
  readLongPointer, readLongPointerTable, STANDARD_HANDLER_COUNT,
} from '../../src/rom/objectHandlers/romData'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`
const arg = process.argv[2]
if (!arg) {
  console.error('Usage: npx tsx tools/scripts/dump_level.ts <hex>')
  process.exit(1)
}
const levelNum = parseInt(arg, 16)

const rom = SmwRom.open(ROM_PATH)
const raw = rom.getLevelRawData(levelNum)
if (!raw) { console.error('No L1 data for level'); process.exit(1) }

const { header, objects } = parseLevelObjects(raw)

console.log(`Level $${arg.toUpperCase()}  header bytes: ${header.raw.map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
console.log(`  objectTileset=${header.objectTileset}  spriteSet=${header.spriteSet}`)
console.log(`  fgPalette=${header.fgPalette}  bgPalette=${header.bgPalette}  spritePalette=${header.spritePalette}`)
console.log(`  levelMode=${header.levelMode}  screens=${header.levelLength}`)
console.log(`  levelLength=${header.levelLength}  bgColor=${header.bgColor}`)
console.log()

const tilesetIdx = header.objectTileset & 0x0F
const dispatcherAddr = readLongPointer(rom.rom, ADDR_TILESET_DISPATCH + tilesetIdx * 3)! & 0xFFFFFF
const handlerTableAddr = dispatcherAddr + 10
const handlerPtrTable = readLongPointerTable(rom.rom, handlerTableAddr, STANDARD_HANDLER_COUNT)

type HandlerInfo = { snesAddr: number; ported: boolean }
function resolveStandard(objNo: number): HandlerInfo | null {
  if (objNo < 1 || objNo > STANDARD_HANDLER_COUNT) return null
  const addr = handlerPtrTable[objNo - 1] & 0xFFFFFF
  return { snesAddr: addr, ported: STANDARD_HANDLERS[addr] !== undefined }
}
function resolveExtended(extNo: number): HandlerInfo | null {
  const addr = readLongPointer(rom.rom, ADDR_EXTENDED_DISPATCH + extNo * 3)
  if (addr === null) return null
  const snesAddr = addr & 0xFFFFFF
  return { snesAddr, ported: EXTENDED_HANDLERS[snesAddr] !== undefined }
}

console.log(`Objects (${objects.length}):`)
const missingStd = new Map<number, { objNo: number; count: number }>()
const missingExt = new Map<number, { extNo: number; count: number }>()
for (const [i, o] of objects.entries()) {
  const rawStr = o.raw.map(b => b.toString(16).padStart(2, '0')).join(' ')
  if (o.type === 'standard') {
    const info = resolveStandard(o.objectNumber)
    const addrStr = info ? `$${info.snesAddr.toString(16).padStart(6, '0').toUpperCase()}` : '---'
    const flag = info?.ported ? 'OK' : 'MISSING'
    console.log(`  [${i.toString().padStart(3)}] std  obj=$${o.objectNumber.toString(16).padStart(2, '0')}  set=$${o.settings.toString(16).padStart(2, '0')}  pos=(${o.x},${o.y})  screen=${o.screen}  raw=[${rawStr}]  -> ${addrStr} ${flag}`)
    if (info && !info.ported) {
      const cur = missingStd.get(info.snesAddr) ?? { objNo: o.objectNumber, count: 0 }
      cur.count++
      missingStd.set(info.snesAddr, cur)
    }
  } else {
    const info = resolveExtended(o.settings)
    const addrStr = info ? `$${info.snesAddr.toString(16).padStart(6, '0').toUpperCase()}` : '---'
    const flag = info?.ported ? 'OK' : 'MISSING'
    console.log(`  [${i.toString().padStart(3)}] ext  ext=$${o.settings.toString(16).padStart(2, '0')}  pos=(${o.x},${o.y})  screen=${o.screen}  raw=[${rawStr}]  -> ${addrStr} ${flag}`)
    if (info && !info.ported) {
      const cur = missingExt.get(info.snesAddr) ?? { extNo: o.settings, count: 0 }
      cur.count++
      missingExt.set(info.snesAddr, cur)
    }
  }
}

console.log()
console.log(`Unimplemented standard handlers used by this level:`)
for (const [addr, info] of [...missingStd.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  $${addr.toString(16).padStart(6, '0').toUpperCase()}  obj=$${info.objNo.toString(16).padStart(2, '0')}  x${info.count}`)
}
console.log(`Unimplemented extended handlers used by this level:`)
for (const [addr, info] of [...missingExt.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  $${addr.toString(16).padStart(6, '0').toUpperCase()}  ext=$${info.extNo.toString(16).padStart(2, '0')}  x${info.count}`)
}
