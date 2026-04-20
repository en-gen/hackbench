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

import { Cursor } from './cursor'
import {
  ADDR_EXTENDED_DISPATCH, EXTENDED_DISPATCH_COUNT,
  ADDR_TILESET_DISPATCH, TILESET_DISPATCH_COUNT,
  STANDARD_HANDLER_COUNT,
  readLongPointer, readLongPointerTable,
} from './romData'
import {
  handle_0DA8C3, handle_0DAA26, handle_0DAAB4, handle_0DAB0D, handle_0DAB3E,
  handle_0DB075,
  handle_0DB1C8, handle_0DB1D4, handle_0DB224,
  handle_0DB336,
  handle_0DB3BD, handle_0DB3E3, handle_0DB42D, handle_0DB461, handle_0DB49E,
  handle_0DB51F, handle_0DB547, handle_0DB571, handle_0DB5B7,
  handle_0DB73F, handle_0DB7AA,
  handle_0DB916, handle_0DB91E,
  handle_0DB966, handle_0DB9C0,
  handle_0DBA0A, handle_0DBA4C, handle_0DBADC,
  handle_0DC341, handle_0DC42E, handle_0DC44F, handle_0DC478,
  handle_0DC4C9, handle_0DC4EF, handle_0DC58A, handle_0DC5D8,
  handle_0DCEF2, handle_0DCF12, handle_0DCF33, handle_0DCF53,
  handle_0DD070,
  handle_0DD103, handle_0DD145,
  handle_0DD182, handle_0DD1A5,
  handle_0DD1D9, handle_0DD24E,
  handle_0DDCEA, handle_0DDD2E, handle_0DDD5C, handle_0DE135,
  handle_0DECC9, handle_0DED43, handle_0DED6B, handle_0DED99,
  handle_0DEDDB, handle_0DEE17, handle_0DEE52, handle_0DEE89, handle_0DEEC0,
} from './standardHandlers'
import {
  handle_0DA512, handle_0DA53D, handle_0DA57B,
  handle_0DA64D, handle_0DA656, handle_0DA673, handle_0DA68E, handle_0DA6D1,
  handle_0DA71B, handle_0DA760, handle_0DA7C1,
  handle_0DA7E7, handle_0DB2CA, handle_0DB583, handle_0DB58B,
  handle_0DB6E3,
  handle_0DC31E,
  handle_0DDAA2,
  handle_0DCE67, handle_0DCE94, handle_0DCEA6, handle_0DCEC0, handle_0DCEDA,
  handle_0DE95F, handle_0DEC33, handle_0DEC5C, handle_0DEC8E,
} from './extendedHandlers'

/** A handler writes tiles into `cur.grid` based on `cur.objNo` and `cur.size`. */
export type HandlerFn = (cur: Cursor) => void

/** Map of ROM handler addresses → ported TS function. Unmapped addresses are stubs. */
export const STANDARD_HANDLERS: Record<number, HandlerFn> = {
  0x0DA8C3: handle_0DA8C3,
  0x0DAA26: handle_0DAA26,
  0x0DAAB4: handle_0DAAB4,
  0x0DAB0D: handle_0DAB0D,
  0x0DAB3E: handle_0DAB3E,
  0x0DB075: handle_0DB075,
  0x0DB1C8: handle_0DB1C8,
  0x0DB1D4: handle_0DB1D4,
  0x0DB224: handle_0DB224,
  0x0DB336: handle_0DB336,
  0x0DB3BD: handle_0DB3BD,
  0x0DB3E3: handle_0DB3E3,
  0x0DB42D: handle_0DB42D,
  0x0DB461: handle_0DB461,
  0x0DB49E: handle_0DB49E,
  0x0DB51F: handle_0DB51F,
  0x0DB547: handle_0DB547,
  0x0DB571: handle_0DB571,
  0x0DB5B7: handle_0DB5B7,
  0x0DB73F: handle_0DB73F,
  0x0DB7AA: handle_0DB7AA,
  0x0DB916: handle_0DB916,
  0x0DB91E: handle_0DB91E,
  0x0DB966: handle_0DB966,
  0x0DB9C0: handle_0DB9C0,
  0x0DBA0A: handle_0DBA0A,
  0x0DBA4C: handle_0DBA4C,
  0x0DBADC: handle_0DBADC,
  0x0DC341: handle_0DC341,
  0x0DC42E: handle_0DC42E,
  0x0DC44F: handle_0DC44F,
  0x0DC478: handle_0DC478,
  0x0DC4C9: handle_0DC4C9,
  0x0DC4EF: handle_0DC4EF,
  0x0DC58A: handle_0DC58A,
  0x0DC5D8: handle_0DC5D8,
  0x0DCEF2: handle_0DCEF2,
  0x0DCF12: handle_0DCF12,
  0x0DCF33: handle_0DCF33,
  0x0DCF53: handle_0DCF53,
  0x0DD070: handle_0DD070,
  0x0DD103: handle_0DD103,
  0x0DD145: handle_0DD145,
  0x0DD182: handle_0DD182,
  0x0DD1A5: handle_0DD1A5,
  0x0DD1D9: handle_0DD1D9,
  0x0DD24E: handle_0DD24E,
  0x0DDCEA: handle_0DDCEA,
  0x0DDD2E: handle_0DDD2E,
  0x0DDD5C: handle_0DDD5C,
  0x0DE135: handle_0DE135,
  0x0DECC9: handle_0DECC9,
  0x0DED43: handle_0DED43,
  0x0DED6B: handle_0DED6B,
  0x0DED99: handle_0DED99,
  0x0DEDDB: handle_0DEDDB,
  0x0DEE17: handle_0DEE17,
  0x0DEE52: handle_0DEE52,
  0x0DEE89: handle_0DEE89,
  0x0DEEC0: handle_0DEEC0,
}

export const EXTENDED_HANDLERS: Record<number, HandlerFn> = {
  0x0DA512: handle_0DA512,
  0x0DA53D: handle_0DA53D,
  0x0DA57B: handle_0DA57B,
  0x0DA64D: handle_0DA64D,
  0x0DA656: handle_0DA656,
  0x0DA673: handle_0DA673,
  0x0DA68E: handle_0DA68E,
  0x0DA6D1: handle_0DA6D1,
  0x0DA71B: handle_0DA71B,
  0x0DA760: handle_0DA760,
  0x0DA7C1: handle_0DA7C1,
  0x0DA7E7: handle_0DA7E7,
  0x0DB2CA: handle_0DB2CA,
  0x0DB583: handle_0DB583,
  0x0DB58B: handle_0DB58B,
  0x0DB6E3: handle_0DB6E3,
  0x0DC31E: handle_0DC31E,
  0x0DCE67: handle_0DCE67,
  0x0DCE94: handle_0DCE94,
  0x0DCEA6: handle_0DCEA6,
  0x0DCEC0: handle_0DCEC0,
  0x0DCEDA: handle_0DCEDA,
  0x0DDAA2: handle_0DDAA2,
  0x0DE95F: handle_0DE95F,
  0x0DEC33: handle_0DEC33,
  0x0DEC5C: handle_0DEC5C,
  0x0DEC8E: handle_0DEC8E,
}

/**
 * Resolve an extended-object handler. The extended-object number is in
 * `cur.objNo` (for extended objects we store `settings` there per LevelParser).
 * Actually in the ASM, LvlLoadObjSize (settings byte) is the extended selector,
 * so the caller must place that in cur.objNo before dispatching.
 */
export function dispatchExtended(cur: Cursor): void {
  const idx = cur.objNo & 0xFF
  if (idx >= EXTENDED_DISPATCH_COUNT) return
  const addr = readLongPointer(cur.rom, ADDR_EXTENDED_DISPATCH + idx * 3)
  if (addr === null || addr === 0) return
  const snesAddr = addr & 0xFFFFFF
  const handler = EXTENDED_HANDLERS[snesAddr]
  if (handler) { cur.handlerAddr = snesAddr; handler(cur) }
  // else: unmapped extended handler -- silently no-op.
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
 * not ported yet silently no-op via the STANDARD_HANDLERS map.
 */
export function dispatchStandard(cur: Cursor): void {
  if (cur.objNo < 1 || cur.objNo > STANDARD_HANDLER_COUNT) return

  // Step 1: tileset-specific dispatcher routine address.
  const tilesetIdx = cur.tileset & 0x0F
  if (tilesetIdx >= TILESET_DISPATCH_COUNT) return
  const tilesetHandlerAddr = readLongPointer(cur.rom, ADDR_TILESET_DISPATCH + tilesetIdx * 3)
  if (tilesetHandlerAddr === null) return
  const dispatcherSnesAddr = tilesetHandlerAddr & 0xFFFFFF

  // Step 2: the handler pointer table lives immediately after the dispatcher's
  // 10-byte preamble. Look up this tileset's entry for the 1-based objNo.
  const handlerTableAddr = dispatcherSnesAddr + DISPATCHER_PREAMBLE_SIZE
  const handlerPtrTable = readLongPointerTable(
    cur.rom, handlerTableAddr, STANDARD_HANDLER_COUNT,
  )
  const handlerAddr = handlerPtrTable[cur.objNo - 1] & 0xFFFFFF
  const handler = STANDARD_HANDLERS[handlerAddr]
  if (handler) { cur.handlerAddr = handlerAddr; handler(cur) }
  // else: unmapped handler -- silently no-op.
}
