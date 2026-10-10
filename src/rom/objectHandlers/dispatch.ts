/**
 * dispatch.ts -- Routes objects to handlers by reading the ROM pointer tables.
 *
 * The game's dispatch chain for standard objects:
 *   CODE_0DA415 (tileset dispatch) → per-tileset dispatcher routine
 *       (one of $0DA44B, $0DC190, $0DCD90, $0DD990, $0DE890)
 *       which itself holds a 63-entry pointer table immediately after its
 *       10-byte preamble.
 *
 * Each entry in those tables is a 24-bit SNES pointer to a handler routine. We
 * read the pointer from the ROM, then look it up in a TypeScript map keyed by
 * that same SNES address. This way, ROM hacks that repoint a handler to a fresh
 * routine will correctly fall through to TILE_UNKNOWN until we port that routine.
 */

import { Cursor, refuseUnported } from './cursor'
import type { RomFile } from '../RomFile'
import { mirror } from '../addressing'
import {
  ADDR_EXTENDED_DISPATCH,
  EXTENDED_DISPATCH_COUNT,
  ADDR_TILESET_DISPATCH,
  TILESET_DISPATCH_COUNT,
  STANDARD_HANDLER_COUNT,
  readLongPointer,
  readLongPointerTable,
} from './romData'
import {
  handle_0DA8C3,
  handle_0DAA26,
  handle_0DAAB4,
  handle_0DAB0D,
  handle_0DAB3E,
  handle_0DB075,
  handle_0DB1C8,
  handle_0DB1D4,
  handle_0DB224,
  handle_0DB336,
  handle_0DB3BD,
  handle_0DB3E3,
  handle_0DB42D,
  handle_0DB461,
  handle_0DB49E,
  handle_0DB51F,
  handle_0DB547,
  handle_0DB571,
  handle_0DB5B7,
  handle_0DB73F,
  handle_0DB7AA,
  handle_0DB863,
  handle_0DB916,
  handle_0DB91E,
  handle_0DB966,
  handle_0DB9C0,
  handle_0DBA0A,
  handle_0DBA4C,
  handle_0DBADC,
  handle_0DB604,
  handle_0DBB2C,
  handle_0DBB63,
  handle_0DC341,
  handle_0DC42E,
  handle_0DC44F,
  handle_0DC478,
  handle_0DC4C9,
  handle_0DC4EF,
  handle_0DC58A,
  handle_0DC5D8,
  handle_0DCEF2,
  handle_0DCF12,
  handle_0DCF33,
  handle_0DCF53,
  handle_0DD070,
  handle_0DD103,
  handle_0DD145,
  handle_0DD182,
  handle_0DD1A5,
  handle_0DD1D9,
  handle_0DD24E,
  handle_0DDAC8,
  handle_0DDAF2,
  handle_0DDCA9,
  handle_0DDCEA,
  handle_0DDD2E,
  handle_0DDD5C,
  handle_0DDD87,
  handle_0DE135,
  handle_0DECC9,
  handle_0DED12,
  handle_0DED43,
  handle_0DED6B,
  handle_0DED99,
  handle_0DEDB9,
  handle_0DEDDB,
  handle_0DEE17,
  handle_0DEE52,
  handle_0DEE89,
  handle_0DEEC0,
  handle_0DEF67,
  handle_0DF02B,
  handle_0DB6C3,
  handle_0DB705,
  handle_0DEF45,
  handle_0DEFA8,
  handle_0DF066,
  handle_0DF06C,
  handle_0DDF3A,
} from './standardHandlers'
import {
  handle_0DA512,
  handle_0DA53D,
  handle_0DA57B,
  handle_0DA64D,
  handle_0DA656,
  handle_0DA673,
  handle_0DA68E,
  handle_0DA6D1,
  handle_0DA71B,
  handle_0DA760,
  handle_0DA7C1,
  handle_0DA7E7,
  handle_0DB2CA,
  handle_0DB583,
  handle_0DB58B,
  handle_0DB6E3,
  handle_0DC259,
  handle_0DC31E,
  handle_0DDAA2,
  handle_0DCE67,
  handle_0DCE94,
  handle_0DCEA6,
  handle_0DCEC0,
  handle_0DCEDA,
  handle_0DDA57,
  handle_0DE95F,
  handle_0DE9ED,
  handle_0DEABF,
  handle_0DEC33,
  handle_0DEC5C,
  handle_0DEC8E,
  handle_0DE971,
  handle_0DE9AA,
  handle_0DEA3E,
  handle_0DE0AE,
  handle_0DDA68,
  handle_0DDA80,
  handle_0DEB6A,
  handle_0DEC68,
  handle_0DC2E9,
  handle_0DECC1,
  handle_0DA80D,
  handle_0DA846,
  handle_0DA87D,
} from './extendedHandlers'

/** A handler writes tiles into `cur.grid` based on `cur.objNo` and `cur.size`. */
export type HandlerFn = (cur: Cursor) => void

/** Map of ROM handler addresses → ported TS function. Unmapped addresses are stubs. */
export const STANDARD_HANDLERS: Record<number, HandlerFn> = {
  0x0da8c3: handle_0DA8C3,
  0x0daa26: handle_0DAA26,
  0x0daab4: handle_0DAAB4,
  0x0dab0d: handle_0DAB0D,
  0x0dab3e: handle_0DAB3E,
  0x0db075: handle_0DB075,
  0x0db1c8: handle_0DB1C8,
  0x0db1d4: handle_0DB1D4,
  0x0db224: handle_0DB224,
  0x0db336: handle_0DB336,
  0x0db3bd: handle_0DB3BD,
  0x0db3e3: handle_0DB3E3,
  0x0db42d: handle_0DB42D,
  0x0db461: handle_0DB461,
  0x0db49e: handle_0DB49E,
  0x0db51f: handle_0DB51F,
  0x0db547: handle_0DB547,
  0x0db5b7: handle_0DB5B7,
  0x0db73f: handle_0DB73F,
  0x0db7aa: handle_0DB7AA,
  0x0db863: handle_0DB863,
  0x0db916: handle_0DB916,
  0x0db91e: handle_0DB91E,
  0x0db966: handle_0DB966,
  0x0db9c0: handle_0DB9C0,
  0x0dba0a: handle_0DBA0A,
  0x0dba4c: handle_0DBA4C,
  0x0dbadc: handle_0DBADC,
  0x0db604: handle_0DB604,
  0x0dbb2c: handle_0DBB2C,
  0x0dbb63: handle_0DBB63,
  0x0dc341: handle_0DC341,
  0x0dc42e: handle_0DC42E,
  0x0dc44f: handle_0DC44F,
  0x0dc478: handle_0DC478,
  0x0dc4c9: handle_0DC4C9,
  0x0dc4ef: handle_0DC4EF,
  0x0dc58a: handle_0DC58A,
  0x0dc5d8: handle_0DC5D8,
  0x0dcef2: handle_0DCEF2,
  0x0dcf12: handle_0DCF12,
  0x0dcf33: handle_0DCF33,
  0x0dcf53: handle_0DCF53,
  0x0dd070: handle_0DD070,
  0x0dd103: handle_0DD103,
  0x0dd145: handle_0DD145,
  0x0dd182: handle_0DD182,
  0x0dd1a5: handle_0DD1A5,
  0x0dd1d9: handle_0DD1D9,
  0x0dd24e: handle_0DD24E,
  0x0ddac8: handle_0DDAC8,
  0x0ddaf2: handle_0DDAF2,
  0x0ddca9: handle_0DDCA9,
  0x0ddcea: handle_0DDCEA,
  0x0ddd2e: handle_0DDD2E,
  0x0ddd5c: handle_0DDD5C,
  0x0ddd87: handle_0DDD87,
  0x0de135: handle_0DE135,
  0x0decc9: handle_0DECC9,
  0x0ded12: handle_0DED12,
  0x0ded43: handle_0DED43,
  0x0ded6b: handle_0DED6B,
  0x0ded99: handle_0DED99,
  0x0dedb9: handle_0DEDB9,
  0x0deddb: handle_0DEDDB,
  0x0dee17: handle_0DEE17,
  0x0dee52: handle_0DEE52,
  0x0dee89: handle_0DEE89,
  0x0deec0: handle_0DEEC0,
  0x0def67: handle_0DEF67,
  0x0df02b: handle_0DF02B,
  0x0db6c3: handle_0DB6C3,
  0x0db705: handle_0DB705,
  0x0def45: handle_0DEF45,
  0x0defa8: handle_0DEFA8,
  0x0df066: handle_0DF066,
  0x0df06c: handle_0DF06C,
  0x0ddf3a: handle_0DDF3A,
}

export const EXTENDED_HANDLERS: Record<number, HandlerFn> = {
  0x0da512: handle_0DA512,
  0x0da53d: handle_0DA53D,
  0x0da57b: handle_0DA57B,
  0x0da64d: handle_0DA64D,
  0x0da656: handle_0DA656,
  0x0da673: handle_0DA673,
  0x0da68e: handle_0DA68E,
  0x0da6d1: handle_0DA6D1,
  0x0da71b: handle_0DA71B,
  0x0da760: handle_0DA760,
  0x0da7c1: handle_0DA7C1,
  0x0da7e7: handle_0DA7E7,
  0x0db2ca: handle_0DB2CA,
  0x0db571: handle_0DB571,
  0x0db583: handle_0DB583,
  0x0db58b: handle_0DB58B,
  0x0db6e3: handle_0DB6E3,
  0x0dc259: handle_0DC259,
  0x0dc31e: handle_0DC31E,
  0x0dda57: handle_0DDA57,
  0x0dce67: handle_0DCE67,
  0x0dce94: handle_0DCE94,
  0x0dcea6: handle_0DCEA6,
  0x0dcec0: handle_0DCEC0,
  0x0dceda: handle_0DCEDA,
  0x0ddaa2: handle_0DDAA2,
  0x0de95f: handle_0DE95F,
  0x0de9ed: handle_0DE9ED,
  0x0deabf: handle_0DEABF,
  0x0dec33: handle_0DEC33,
  0x0dec5c: handle_0DEC5C,
  0x0dec8e: handle_0DEC8E,
  0x0de971: handle_0DE971,
  0x0de9aa: handle_0DE9AA,
  0x0dea3e: handle_0DEA3E,
  0x0de0ae: handle_0DE0AE,
  0x0dda68: handle_0DDA68,
  0x0dda80: handle_0DDA80,
  0x0deb6a: handle_0DEB6A,
  0x0dec68: handle_0DEC68,
  0x0dc2e9: handle_0DC2E9,
  0x0decc1: handle_0DECC1,
  0x0da80d: handle_0DA80D,
  0x0da846: handle_0DA846,
  0x0da87d: handle_0DA87D,
}

/**
 * Literal pins on the dispatch path the tables hang off, so a table is only
 * trusted while the code that reads it is still reached (#302). Reading bytes,
 * not running them: a JML hook or a replaced preamble fails the pin and the
 * map says so, while still drawing from the stock tables. Pins from
 * bank_0D.asm: CODE_0DA106 (1056-1060), CODE_0DA415 (1324-1327), and the
 * per-tileset dispatchers' shared preamble (CODE_0DA44B, 1345-1350). The
 * trailing `22 FA 86 00` is JSL ExecutePtrLong (bank_00.asm:864), whose bank byte may be $80 (the same code through the FastROM mirror); $59/$5A
 * are LvlLoadObjSize/LvlLoadObjNo and $1931 is ObjectTileset (rammap.asm).
 * Deliberately unpinned hops: $0586E3-$0586F0, CODE_0DA100 (1051-1054),
 * CODE_0DA40F (1319-1322) and ExecutePtrLong itself. Over 105 ROMs none gets
 * past these pins through them: each is stock, an equivalent $8D form, or one
 * of the 2 broken ROMs that fail every pin anyway.
 */
const PIN_EXTENDED = [0xe2, 0x30, 0xa5, 0x59, 0xaa, 0x22, 0xfa, 0x86, 0x00]
const PIN_TILESET = [0xe2, 0x30, 0xad, 0x31, 0x19, 0x22, 0xfa, 0x86, 0x00]
const PIN_DISPATCHER = [0xe2, 0x30, 0xa6, 0x5a, 0xca, 0x8a, 0x22, 0xfa, 0x86, 0x00]

const pathChecks = new WeakMap<RomFile, { version: number; found: Map<number, string | null> }>()

/** What differs from `pin` at `addr`, or null when it matches. Once per ROM version and address. */
function pathFinding(rom: RomFile, addr: number, pin: number[]): string | null {
  let c = pathChecks.get(rom)
  if (!c || c.version !== rom.version) pathChecks.set(rom, (c = { version: rom.version, found: new Map() })) // prettier-ignore
  const cached = c.found.get(addr)
  if (cached !== undefined) return cached
  const got = rom.readAt(addr, pin.length)
  const bytes = got ? Array.from(got) : []
  let found: string | null = null
  if (
    bytes.length !== pin.length ||
    bytes.some((b, i) => (i === pin.length - 1 ? b & 0x7f : b) !== pin[i])
  ) {
    const h = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
    const target = bytes[0] === 0x5c ? ` (JML $${h(bytes[3])}${h(bytes[2])}${h(bytes[1])})` : ''
    found = `Object dispatch at $${addr.toString(16).toUpperCase().padStart(6, '0')} is not the stock routine${target}, found ${bytes.map(h).join(' ') || 'nothing'}: objects are drawn from the stock tables, not verified against this ROM.` // prettier-ignore
  }
  c.found.set(addr, found)
  return found
}

function notePath(cur: Cursor, addr: number, pin: number[]): void {
  const found = pathFinding(cur.rom, addr, pin)
  const sink = cur.draw?.unverified
  if (found && sink && !sink.includes(found)) sink.push(found)
}

/**
 * Resolve an extended-object handler. The extended-object number is in
 * `cur.objNo` (for extended objects we store `settings` there per LevelParser).
 * Actually in the ASM, LvlLoadObjSize (settings byte) is the extended selector,
 * so the caller must place that in cur.objNo before dispatching.
 */
export function dispatchExtended(cur: Cursor): void {
  notePath(cur, 0x0da106, PIN_EXTENDED)
  const idx = cur.objNo & 0xff
  if (idx >= EXTENDED_DISPATCH_COUNT) return
  const addr = readLongPointer(cur.rom, ADDR_EXTENDED_DISPATCH + idx * 3)
  if (addr === null || addr === 0) return
  const snesAddr = mirror(addr)
  const handler = EXTENDED_HANDLERS[snesAddr]
  if (handler) {
    cur.handlerAddr = snesAddr
    handler(cur)
  } else refuseUnported(cur, snesAddr)
}

/**
 * Every per-tileset dispatcher in bank_0D has the identical 10-byte preamble:
 *
 *   SEP #$30         ; 2 bytes
 *   LDX.B LvlLoadObjNo ; 2 bytes
 *   DEX              ; 1 byte
 *   TXA              ; 1 byte
 *   JSL ExecutePtrLong ; 4 bytes
 *
 * The 63-entry `dl` handler pointer table immediately follows. Known dispatcher
 * addresses: $0DA44B (tilesets 0, 7, 12), $0DC190 (1), $0DCD90 (2, 6, 8),
 * $0DD990 (3, 9, 10, 11, 14), $0DE890 (4, 5, 13). The first ~45 pointer slots
 * are shared across all five dispatchers; slots 46-63 hold the tileset-specific
 * object handlers.
 */
const DISPATCHER_PREAMBLE_SIZE = 10

/**
 * Resolve a standard-object handler via the tileset dispatch → tileset-specific
 * table → object-number lookup chain. Works for any of the five dispatchers
 * because their layout is identical; individual handler addresses that we have
 * not ported yet are reported through `cur.refusals` and draw nothing.
 */
export function dispatchStandard(cur: Cursor): void {
  if (cur.objNo < 1 || cur.objNo > STANDARD_HANDLER_COUNT) return

  // Step 1: tileset-specific dispatcher routine address.
  const tilesetIdx = cur.tileset & 0x0f
  if (tilesetIdx >= TILESET_DISPATCH_COUNT) return
  const tilesetHandlerAddr = readLongPointer(cur.rom, ADDR_TILESET_DISPATCH + tilesetIdx * 3)
  if (tilesetHandlerAddr === null) return
  const dispatcherSnesAddr = tilesetHandlerAddr & 0xffffff
  notePath(cur, 0x0da415, PIN_TILESET)
  notePath(cur, dispatcherSnesAddr, PIN_DISPATCHER)

  // Step 2: the handler pointer table lives immediately after the dispatcher's
  // 10-byte preamble. Look up this tileset's entry for the 1-based objNo.
  const handlerTableAddr = dispatcherSnesAddr + DISPATCHER_PREAMBLE_SIZE
  const handlerPtrTable = readLongPointerTable(cur.rom, handlerTableAddr, STANDARD_HANDLER_COUNT)
  const handlerAddr = mirror(handlerPtrTable[cur.objNo - 1])
  const handler = STANDARD_HANDLERS[handlerAddr]
  if (handler) {
    cur.handlerAddr = handlerAddr
    handler(cur)
  } else refuseUnported(cur, handlerAddr)
}

/**
 * Every object this ROM's own dispatch tables route to `handler`, for one
 * tileset: extended numbers from the extended table, standard numbers from
 * the tileset's dispatcher table. Additive and read-only, the same reads the
 * two dispatchers above make, so a caller can ask what an object DRAWS
 * without knowing which number the ROM gives it.
 */
export function objectsDispatchedTo(
  rom: RomFile,
  tileset: number,
  handler: HandlerFn,
): { type: 'extended' | 'standard'; objectNumber: number }[] {
  const out: { type: 'extended' | 'standard'; objectNumber: number }[] = []
  for (let i = 0; i < EXTENDED_DISPATCH_COUNT; i++) {
    const addr = readLongPointer(rom, ADDR_EXTENDED_DISPATCH + i * 3)
    if (addr && EXTENDED_HANDLERS[mirror(addr)] === handler) {
      out.push({ type: 'extended', objectNumber: i })
    }
  }
  const t = tileset & 0x0f
  const dispatcher = t < TILESET_DISPATCH_COUNT ? readLongPointer(rom, ADDR_TILESET_DISPATCH + t * 3) : null // prettier-ignore
  if (dispatcher === null) return out
  const table = readLongPointerTable(rom, (dispatcher & 0xffffff) + DISPATCHER_PREAMBLE_SIZE, STANDARD_HANDLER_COUNT) // prettier-ignore
  table.forEach((addr, i) => {
    if (STANDARD_HANDLERS[mirror(addr)] === handler) out.push({ type: 'standard', objectNumber: i + 1 }) // prettier-ignore
  })
  return out
}
