/**
 * OverworldEvents.ts -- Event-driven overworld tile swaps.
 *
 * The overworld's analog to P-switch state. As the player clears levels,
 * defeats Reznor, presses switch palaces, etc., bits in `OWEventsActivated`
 * are set; each activated bit can swap one Map16 cell on the overworld
 * (e.g. the Donut Plains 1 dot turns from yellow to red, the Vanilla Dome
 * dome opens, the bridge appears after the Yellow Switch Palace).
 *
 * Source routine: `CODE_04DA49` at `bank_04.asm:5387-5450`. Tables:
 *   - `DATA_04D85D` (`bank_04.asm:5319`): 120 word entries — each is the
 *     `Map16TilesLow` byte offset to check for this event.
 *   - `DATA_04D93D` (`bank_04.asm:5348`): 120 word entries — secondary
 *     positions (purpose not fully decoded here; may target the L2 tilemap
 *     for animated swaps). Surfaced for completeness.
 *   - `DATA_04DA1D` (`bank_04.asm:5378`): "from" tile list, 22 bytes.
 *   - `DATA_04DA33` (`bank_04.asm:5382`): "to" tile list, 22 bytes (paired
 *     with `DATA_04DA1D` by index).
 *   - `DATA_04E44B` (`bank_04.asm:6062`): 8-byte bit-mask table
 *     `db $80,$40,$20,$10,$08,$04,$02,$01` — bits stored MSB-first within
 *     each byte of `OWEventsActivated`.
 *
 * The OW load runs `CODE_04E453` for `_F = 0..$6E` (111 events), which calls
 * `CODE_04DA49` for each. We surface 120 bits to match `OWEventsActivated`'s
 * 15-byte width; bits past 110 are unused in vanilla but included so the
 * struct survives ROM hacks that extend the table.
 */

import { RomFile } from './RomFile'

// ── ROM addresses ────────────────────────────────────────────────────────────

export const OW_EVENT_ADDR = {
  /** DATA_04D85D — primary position table, 120 word entries. */
  POSITION_TABLE_PRIMARY:   0x04D85D,
  /** DATA_04D93D — secondary position table (L2 swap?), 120 word entries. */
  POSITION_TABLE_SECONDARY: 0x04D93D,
  /** DATA_04DA1D — "from" tile list, 22 bytes. */
  FROM_LIST: 0x04DA1D,
  /** DATA_04DA33 — "to" tile list, 22 bytes (paired with FROM_LIST). */
  TO_LIST:   0x04DA33,
} as const

// ── Constants from asm ───────────────────────────────────────────────────────

/** OWEventsActivated is 15 bytes (rammap.asm:2048) → 120 event bits. */
export const OW_EVENT_COUNT = 120
/** Number of (from, to) pairs in the swap tables. */
export const OW_EVENT_SWAP_PAIRS = 22

// ── Types ────────────────────────────────────────────────────────────────────

export interface OwEvent {
  /** Bit index 0..119 (MSB-first within each byte of OWEventsActivated). */
  bitIndex: number
  /** Byte offset within Map16TilesLow that this event watches. */
  primaryOffset: number
  /** Secondary offset (DATA_04D93D — probably L2 tilemap; not fully decoded). */
  secondaryOffset: number
}

export interface OwEventTables {
  events: OwEvent[]               // 120 entries
  fromTiles: Uint8Array            // 22 entries
  toTiles: Uint8Array              // 22 entries
}

// ── ROM read ─────────────────────────────────────────────────────────────────

export function loadOverworldEvents(rom: RomFile): OwEventTables {
  const primaryBuf  = rom.readAt(OW_EVENT_ADDR.POSITION_TABLE_PRIMARY,   OW_EVENT_COUNT * 2)
  const secondaryBuf = rom.readAt(OW_EVENT_ADDR.POSITION_TABLE_SECONDARY, OW_EVENT_COUNT * 2)
  const fromBuf     = rom.readAt(OW_EVENT_ADDR.FROM_LIST, OW_EVENT_SWAP_PAIRS)
  const toBuf       = rom.readAt(OW_EVENT_ADDR.TO_LIST,   OW_EVENT_SWAP_PAIRS)

  const events: OwEvent[] = []
  for (let i = 0; i < OW_EVENT_COUNT; i++) {
    events.push({
      bitIndex: i,
      primaryOffset:   primaryBuf?.readUInt16LE(i * 2)   ?? 0,
      secondaryOffset: secondaryBuf?.readUInt16LE(i * 2) ?? 0,
    })
  }

  return {
    events,
    fromTiles: fromBuf ? Uint8Array.from(fromBuf) : new Uint8Array(OW_EVENT_SWAP_PAIRS),
    toTiles:   toBuf   ? Uint8Array.from(toBuf)   : new Uint8Array(OW_EVENT_SWAP_PAIRS),
  }
}

// ── Activation bit handling ──────────────────────────────────────────────────

/**
 * Test whether a given event index is set in `activatedBytes`.
 *
 * `OWEventsActivated` is 15 bytes; bit numbering is MSB-first within each
 * byte (per `DATA_04E44B`). Event 0 = byte 0 bit 7, event 7 = byte 0 bit 0,
 * event 8 = byte 1 bit 7, …
 */
export function isEventActivated(
  activatedBytes: Uint8Array,
  bitIndex: number,
): boolean {
  if (bitIndex < 0 || bitIndex >= OW_EVENT_COUNT) return false
  const byte = activatedBytes[bitIndex >> 3] ?? 0
  const mask = 0x80 >> (bitIndex & 7)
  return (byte & mask) !== 0
}

/** All 120 bits set — convenience for the viewer's "switch state on" toggle. */
export function allEventsActivated(): Uint8Array {
  return new Uint8Array(15).fill(0xFF)
}

/** All 120 bits cleared — initial state. */
export function noEventsActivated(): Uint8Array {
  return new Uint8Array(15)
}

// ── Apply swaps ──────────────────────────────────────────────────────────────

/**
 * Apply event-driven tile swaps to a copy of `Map16TilesLow`.
 *
 * For each activated event, look up its primary `Map16TilesLow` offset,
 * find the current tile there, and if it matches an entry in `fromTiles`,
 * replace it with the paired entry from `toTiles`. Returns a new buffer
 * (the input is not mutated).
 *
 * Mirrors `CODE_04DA49` (`bank_04.asm:5387-5450`). The "match the LAST
 * entry" special case in the asm (`CPX #$0015 / BNE` at `:5426`) — which
 * also writes the next byte — is left unimplemented in this initial
 * version because it's only relevant to one tile pair (`$54 → $23`) and
 * the secondary write target isn't yet decoded; track as a follow-up.
 */
export function applyEventSwaps(
  map16Tiles: Uint8Array,
  tables: OwEventTables,
  activatedBytes: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(map16Tiles)
  for (const ev of tables.events) {
    if (!isEventActivated(activatedBytes, ev.bitIndex)) continue
    if (ev.primaryOffset === 0) continue  // empty/unused slot
    const off = ev.primaryOffset & 0xFFFF
    if (off >= out.length) continue
    const current = out[off]
    for (let i = 0; i < tables.fromTiles.length; i++) {
      if (tables.fromTiles[i] === current) {
        out[off] = tables.toTiles[i]
        break
      }
    }
  }
  return out
}
