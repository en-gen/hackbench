/**
 * dispatch.ts -- Routes objects to handlers by reading the ROM pointer tables.
 *
 * The game's dispatch chain for standard objects:
 *   CODE_0DA415 (tileset dispatch) → per-tileset handler (e.g. CODE_0DA44B)
 *       which itself holds a pointer table (ADDR_TILESET0_HANDLERS).
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
  ADDR_TILESET0_HANDLERS, STANDARD_HANDLER_COUNT,
  readLongPointer, readLongPointerTable,
} from './romData'
import {
  handle_0DA8C3, handle_0DAA26, handle_0DAAB4, handle_0DAB0D, handle_0DAB3E,
  handle_0DB075,
  handle_0DB1C8, handle_0DB1D4, handle_0DB224,
  handle_0DB3BD, handle_0DB3E3, handle_0DB42D, handle_0DB461,
  handle_0DB51F, handle_0DB547, handle_0DB571, handle_0DB5B7,
} from './standardHandlers'
import {
  handle_0DA512, handle_0DA53D, handle_0DA57B,
  handle_0DA64D, handle_0DA656, handle_0DA673, handle_0DA68E, handle_0DA6D1,
  handle_0DB2CA,
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
  0x0DB3BD: handle_0DB3BD,
  0x0DB3E3: handle_0DB3E3,
  0x0DB42D: handle_0DB42D,
  0x0DB461: handle_0DB461,
  0x0DB51F: handle_0DB51F,
  0x0DB547: handle_0DB547,
  0x0DB571: handle_0DB571,
  0x0DB5B7: handle_0DB5B7,
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
  0x0DB2CA: handle_0DB2CA,
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
  if (handler) handler(cur)
  // else: unmapped extended handler -- silently no-op.
}

/**
 * Resolve a standard-object handler via the tileset dispatch → tileset-specific
 * table → object-number lookup chain.
 */
export function dispatchStandard(cur: Cursor): void {
  if (cur.objNo < 1 || cur.objNo > STANDARD_HANDLER_COUNT) return

  // Step 1: tileset-specific dispatch routine address.
  const tilesetIdx = cur.tileset & 0x0F
  if (tilesetIdx >= TILESET_DISPATCH_COUNT) return
  const tilesetHandlerAddr = readLongPointer(cur.rom, ADDR_TILESET_DISPATCH + tilesetIdx * 3)
  if (tilesetHandlerAddr === null) return
  const tilesetSnesAddr = tilesetHandlerAddr & 0xFFFFFF

  // Step 2: only CODE_0DA44B (tilesets 0, 7, 12) is fully mapped. Other
  // tileset-specific dispatchers fall through for now.
  if (tilesetSnesAddr !== 0x0DA44B) {
    // TODO: port CODE_0DC190, CODE_0DCD90, CODE_0DD990, CODE_0DE890.
    // For now, do nothing — unhandled tileset objects stay as empty ($25).
    return
  }

  // Step 3: look up handler pointer for this object number (1-based index).
  const handlerPtrTable = readLongPointerTable(
    cur.rom, ADDR_TILESET0_HANDLERS, STANDARD_HANDLER_COUNT,
  )
  const handlerAddr = handlerPtrTable[cur.objNo - 1] & 0xFFFFFF
  const handler = STANDARD_HANDLERS[handlerAddr]
  if (handler) handler(cur)
  // else: unmapped handler -- silently no-op.
}
