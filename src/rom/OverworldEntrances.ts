/**
 * OverworldEntrances.ts -- the overworld entrance index
 * (docs/ideas/level-classification.md, second tier).
 *
 * Vocabulary follows the project glossary (PR #322):
 *   slot       one of the 512 pointer-table indices, occupied or not
 *   map        a slot holding real data; the editable unit
 *   level      what the player enters from the overworld: an entry map plus
 *              its sub areas
 *   entry map  the map a launch tile starts
 *
 * This module answers "which slot does each overworld tile start, and where
 * does that tile live". The set of entry maps falls out of the index; it is
 * not the deliverable. One entry map identifies one level.
 *
 * Nothing here is an index-range guess. Every entrance comes from the
 * overworld Layer-1 Map16 stream in ROM, walked the way the game walks it.
 *
 * ── The three steps the game takes, and this module mirrors ─────────────
 *
 * 1. `CODE_04DC09` (bank_04.asm:5637) MVN-copies `OWL1TileData`
 *    (SNES $0CF7DF, $800 bytes) into `Map16TilesLow` ($7EC800), then calls
 *    `CODE_04D7F2`.
 *
 * 2. `CODE_04D7F2` (bank_04.asm:5263) seeds a counter to 1
 *    (`LDY #$0001 / STY _0`, bank_04.asm:5285-5286) and walks all $800
 *    bytes in buffer order. A byte in `[$56,$80]` (`CMP #$56 / BCC skip`,
 *    `CMP #$81 / BCS skip`, bank_04.asm:5297-5300) gets the current counter
 *    written to `OWLayer1Translevel` and the counter is bumped. The bump is
 *    `INC.B _0` (bank_04.asm:5306) -- 8-bit, so numbering wraps at $FF.
 *
 * 3. `CODE_05D8A2` (bank_05.asm:7216-7226) turns a translevel into a slot
 *    through TWO INDEPENDENT gates:
 *      - low byte:  `CMP #$25 / BCC + / SEC / SBC #$24`
 *      - high byte: `LDA OWPlayerSubmap,Y / BEQ + / LDA #$01`, i.e. it comes
 *        from the player's submap, NOT from the translevel.
 *    They are independent: a translevel >= $25 reached while standing on the
 *    main map yields a $0xx slot, colliding with a low translevel. Vanilla
 *    never does this; a hack could.
 *
 * The buffer index itself carries the submap gate. `CODE_05D83E`
 * (bank_05.asm:7164-7212) builds the `OWLayer1Translevel` index from the
 * player's overworld tile position as
 *
 *     index = (Ylow4 << 4) | Xlow4 | (Xbit4 << 8) | (Ybit4 << 9)
 *
 * and then adds $400 when `OWPlayerSubmap` is non-zero. So buffer indices
 * $000-$3FF are the main map (high byte 0) and $400-$7FF are the sub-maps
 * (high byte 1). Inverting that recovers an exact 32x32 tile coordinate per
 * entrance -- see {@link decodeBufferIndex}.
 *
 * ── Which tiles actually start a map ────────────────────────────────────
 *
 * Carrying a translevel is not the same as starting a map. The A-press
 * handler `OWPU_ABXY` (bank_04.asm:1750) reads the LIVE Map16 tile out of
 * `Map16TilesLow` and branches before `OWPU_EnterLevel`:
 *   - tile $5F          -> star warp        (bank_04.asm:1752-1754)
 *   - tile $82 or $5B   -> pipe warp        (bank_04.asm:1767-1771)
 *   - tile >= $81       -> nothing          (bank_04.asm:1784-1786)
 *   - anything else     -> OWPU_EnterLevel  (bank_04.asm:1787)
 *
 * Tile $5A is deliberately absent from that list. It fails every compare
 * and does fall through to `OWPU_EnterLevel`. Two reviews have now cited
 * that fall-through as refuting the rule below; it does not touch it. The
 * rule is NOT a claim about the handler's branch structure. It is the claim
 * that the byte is no longer $5A by the time a player can press A on it.
 *
 * `OWPU_ABXY` reads `Map16TilesLow` AFTER the overworld event system has
 * rewritten it, and this module reads the pristine ROM stream, so the two
 * disagree by design. `CODE_04DA49` (bank_04.asm:5387), which `CODE_04D7F2`
 * runs over all 111 events immediately after the translevel walk
 * (bank_04.asm:5310-5314), takes that event's `Map16TilesLow` offset from
 * `DATA_04D85D` (bank_04.asm:5319), matches the byte sitting there against
 * `DATA_04DA1D` (bank_04.asm:5377-5385, compared at :5417) and stores the
 * paired `DATA_04DA33` byte back (:5424-5425). A FROM tile whose TO tile is
 * a warp tile is a warp node in its pre-activation state and never starts a
 * map. The pairing is read per ROM through {@link warpPrecursorTiles},
 * never hardcoded: across this repo's six carts the only such pair is
 * $5A -> $5F, but a hack may choose others and this follows the cart.
 *
 * Corroboration from a second, independently authored table, measured on
 * `Super Mario World (USA).vanilla.sfc`, one cart, this revision: each of
 * its 7 pristine $5A tiles is a registered star-warp SOURCE position in the
 * paired `DATA_048431` / `DATA_048467` (bank_04.asm:491, :500) that
 * `CODE_048509` (bank_04.asm:527) searches from the $5F and $82/$5B
 * branches (called at :1756 and :1773), and each also sits at an offset
 * listed in `DATA_04D85D`. Both tables agree on all 7. Per-tile evidence
 * and the warp-table accounting: docs/ideas/level-classification.md.
 *
 * Not settled by the cart: whether every one of those events is triggered
 * in normal play, since activation lives in save state. The classification
 * does not rest on it. 5 of the 7 slots a $5A tile would name hold this
 * cart's filler L1 pointer, against 2 of the 79 tiles that do start a map.
 *
 * Translevel numbering is unaffected by any of this, because step 2 runs on
 * the pristine copy before the event pass on every overworld load.
 *
 * ── Fail-closed on ROMs built with another editor ───────────────────────
 *
 * Third-party overworld editors replace the high-byte gate: `$05D8B1` holds
 * the `BEQ` opcode $F0 in a stock ROM (bank_05.asm:7224) and $22 (JSL) once
 * patched. Measured over this repo's six-ROM corpus, the two stock ROMs hold
 * $F0 and the four edited ones hold $22 -- an empirical corpus observation,
 * not an ASM claim. On any ROM where that byte is not $F0 the translevel ->
 * slot mapping is computed by code this module does not decode, so the
 * derivation reports itself unavailable and emits nothing. No map can then
 * be identified as an entry map; every map stays unclassified and fully
 * editable, which is the point of ordering the tiers this way.
 */

import type { RomFile } from './RomFile'
import type { SmwRom } from './SmwRom'
import { buildLevelCatalog, type LevelCatalog } from './LevelCatalog'
import { loadOverworldEvents } from './OverworldEvents'
import {
  OW_ADDR,
  OW_L1_MAP16_BYTES,
  OW_SUBAREA_TILES_W,
  OW_SUBAREA_TILES_H,
  loadOverworldAreas,
} from './OverworldLoader'

/** Map16 tile numbers that `CODE_04D7F2` grants a translevel, inclusive. */
export const TRANSLEVEL_TILE_MIN = 0x56
export const TRANSLEVEL_TILE_MAX = 0x80
/** `OWPU_ABXY` diverts these two before `OWPU_EnterLevel`. */
export const STAR_WARP_TILE = 0x5F
export const PIPE_WARP_TILE = 0x5B
/** `CODE_05D8A2`'s low-byte gate. */
export const TRANSLEVEL_BIAS_THRESHOLD = 0x25
export const TRANSLEVEL_BIAS = 0x24
/** Slot offset applied when the player is on a sub-map. */
export const SUBMAP_SLOT_BASE = 0x100
/** Buffer index at which the sub-map half of `OWLayer1Translevel` starts. */
export const SUBMAP_BUFFER_BASE = 0x400
/** `$05D8B1`: `BEQ` in a stock ROM, `JSL` once an overworld editor patched it. */
export const OW_PATCH_PROBE_ADDR = 0x05D8B1
export const OW_PATCH_PROBE_STOCK_BYTE = 0xF0

/**
 * What happens when the player presses A on this tile.
 *   `map`         starts the slot named by `slot`
 *   `starWarp`    tile is $5F
 *   `pipeWarp`    tile is $5B
 *   `pendingWarp` an overworld event swaps this tile into a warp tile, so it
 *                 is a warp node before activation and never starts a map
 */
export type EntranceAction = 'map' | 'starWarp' | 'pipeWarp' | 'pendingWarp'

export interface OverworldEntrance {
  /** Pointer-table slot this tile starts. The ROM assigns one even when
   *  `action` is a warp, so it is still reported. */
  slot: number
  /** Translevel assigned by `CODE_04D7F2`, 1-based, 8-bit. */
  translevel: number
  /** Byte offset into `OWL1TileData` / `OWLayer1Translevel`, $000-$7FF. */
  bufferIndex: number
  /** SNES address of the `OWL1TileData` byte -- the byte an editor rewrites. */
  tileDataAddress: number
  /** 0 = main-map buffer half, 1 = sub-map half. This IS the high-byte gate. */
  layout: 0 | 1
  /** Tile column 0-31 within the layout's 32x32 Map16 grid. */
  tileX: number
  /** Tile row 0-31. */
  tileY: number
  /** `OWPlayerSubmap` value: 0 for layout 0 (exact). For layout 1 this is
   *  INFERRED from the per-area camera windows and is not used to compute
   *  `slot` -- see {@link submapWindows}. `null` when no window contains
   *  the tile. */
  submap: number | null
  /** Map16 tile number read from `OWL1TileData`. */
  map16Tile: number
  action: EntranceAction
  /** True when `slot` holds real data, i.e. is a map rather than filler. */
  isMap: boolean
}

export interface OverworldEntranceIndex {
  /** Every tile the overworld grants a translevel, in buffer order. */
  entrances: OverworldEntrance[]
  /** Distinct slots started by a launch tile and holding real data. One
   *  entry map identifies one level. */
  entryMaps: number[]
  /** False means the derivation is blind; both lists are then empty. */
  overworldReadable: boolean
  notes: string[]
}

/** Invert `CODE_05D83E`'s index formula (bank_05.asm:7170-7195). */
export function decodeBufferIndex(bufferIndex: number): {
  layout: 0 | 1
  tileX: number
  tileY: number
} {
  const layout: 0 | 1 = bufferIndex >= SUBMAP_BUFFER_BASE ? 1 : 0
  const rel = bufferIndex & 0x3FF
  return {
    layout,
    tileX: (((rel >> 8) & 0x01) << 4) | (rel & 0x0F),
    tileY: (((rel >> 9) & 0x01) << 4) | ((rel >> 4) & 0x0F),
  }
}

/**
 * Tiles that an overworld event turns into a warp tile, read from this
 * ROM's own `DATA_04DA1D` / `DATA_04DA33` pair (bank_04.asm:5377-5385) via
 * OverworldEvents.ts. Such a tile is a warp node awaiting activation, so it
 * never reaches `OWPU_EnterLevel`.
 *
 * One step only: a tile swapped into a warp precursor rather than into a
 * warp is not followed. Vanilla has no such chain.
 */
export function warpPrecursorTiles(rom: RomFile): Map<number, number> {
  const { fromTiles, toTiles } = loadOverworldEvents(rom)
  const out = new Map<number, number>()
  for (let i = 0; i < fromTiles.length; i++) {
    const to = toTiles[i]
    if (to === STAR_WARP_TILE || to === PIPE_WARP_TILE) out.set(fromTiles[i]!, to)
  }
  return out
}

interface SubmapWindow {
  submap: number
  rowStart: number
  colStart: number
}

/**
 * Per-sub-map window over the layout-1 tile grid, in Map16 tiles.
 *
 * Origin comes from the per-area camera tables `DATA_00A06B` /
 * `DATA_00A079` (bank_00.asm:4242, :4246) using the same ceil rule that
 * `areaBufferRegion` in OverworldLoader.ts documents, halved because one
 * Map16 tile is 2x2 SNES BG tiles. Starts are deliberately left signed
 * rather than wrapped mod 32: the negative origins (Yoshi's Island and
 * Valley of Bowser sit at camera -17/-40) would otherwise wrap to the far
 * edge and swallow the bottom-row sub-maps.
 *
 * This is the one inference in this module. It never feeds `slot`.
 */
function submapWindows(rom: RomFile): SubmapWindow[] {
  return loadOverworldAreas(rom)
    .filter(area => area.index !== 0)
    .map(area => ({
      submap: area.index,
      rowStart: Math.floor(Math.ceil(area.cameraY / 8) / 2),
      colStart: Math.floor(Math.ceil(area.cameraX / 8) / 2),
    }))
}

const WINDOW_COLS = OW_SUBAREA_TILES_W / 2
const WINDOW_ROWS = OW_SUBAREA_TILES_H / 2

/** First window in sub-map order containing the tile. Adjacent windows
 *  overlap by 3 rows in vanilla; first-match resolves to the upper one,
 *  which is the one whose authored content reaches that row. */
function submapForTile(windows: SubmapWindow[], tileX: number, tileY: number): number | null {
  for (const w of windows) {
    const dr = tileY - w.rowStart
    const dc = tileX - w.colStart
    if (dr >= 0 && dr < WINDOW_ROWS && dc >= 0 && dc < WINDOW_COLS) return w.submap
  }
  return null
}

function classifyTile(tile: number, precursors: Map<number, number>): EntranceAction {
  if (tile === STAR_WARP_TILE) return 'starWarp'
  if (tile === PIPE_WARP_TILE) return 'pipeWarp'
  if (precursors.has(tile)) return 'pendingWarp'
  return 'map'
}

function unavailable(notes: string[]): OverworldEntranceIndex {
  return { entrances: [], entryMaps: [], overworldReadable: false, notes }
}

/**
 * Derive the overworld entrance index, and from it the set of entry maps.
 *
 * Returns `overworldReadable: false` with empty lists rather than a guess
 * whenever the overworld cannot be trusted. Callers must read that as
 * "unknown", not "none": no map has been shown to be unreachable, only
 * unclassified.
 *
 * @param catalog Tier 1 catalog; built here when omitted. Supplies the
 *   per-ROM filler L1 pointer that decides `isMap`.
 */
export function deriveOverworldEntrances(
  rom: SmwRom,
  catalog?: LevelCatalog,
): OverworldEntranceIndex {
  const probe = rom.rom.readByte(OW_PATCH_PROBE_ADDR)
  if (probe !== OW_PATCH_PROBE_STOCK_BYTE) {
    return unavailable([
      `Overworld not readable: $${OW_PATCH_PROBE_ADDR.toString(16).toUpperCase()} holds ` +
      `0x${(probe ?? 0).toString(16).padStart(2, '0')}, not the stock 0xF0. This ROM's ` +
      'overworld was rebuilt by another editor, which replaces the translevel-to-slot ' +
      'mapping with code HackBench does not decode. No entry maps can be identified, so ' +
      'every map is left unclassified and stays fully editable. To get the overworld ' +
      'grouping, start from an unmodified ROM.',
    ])
  }

  const stream = rom.rom.readAt(OW_ADDR.L1_TILEDATA, OW_L1_MAP16_BYTES)
  if (!stream) {
    return unavailable([
      'Overworld not readable: the Layer-1 tile stream at SNES ' +
      `$${OW_ADDR.L1_TILEDATA.toString(16).toUpperCase()} could not be read ` +
      `(${OW_L1_MAP16_BYTES} bytes). No entry maps can be identified, so every map is ` +
      'left unclassified.',
    ])
  }

  const cat = catalog ?? buildLevelCatalog(rom)
  const windows = submapWindows(rom.rom)
  const precursors = warpPrecursorTiles(rom.rom)
  const entrances: OverworldEntrance[] = []
  let counter = 1
  let wrapped = false
  let mainMapBiased = 0

  for (let bufferIndex = 0; bufferIndex < OW_L1_MAP16_BYTES; bufferIndex++) {
    const map16Tile = stream[bufferIndex]!
    if (map16Tile < TRANSLEVEL_TILE_MIN || map16Tile > TRANSLEVEL_TILE_MAX) continue

    const translevel = counter & 0xFF
    counter = (counter + 1) & 0xFF
    if (counter === 0) wrapped = true

    const { layout, tileX, tileY } = decodeBufferIndex(bufferIndex)
    const biased = translevel >= TRANSLEVEL_BIAS_THRESHOLD
    if (biased && layout === 0) mainMapBiased++
    const slot = (layout === 1 ? SUBMAP_SLOT_BASE : 0)
               + (biased ? translevel - TRANSLEVEL_BIAS : translevel)

    entrances.push({
      slot,
      translevel,
      bufferIndex,
      tileDataAddress: OW_ADDR.L1_TILEDATA + bufferIndex,
      layout,
      tileX,
      tileY,
      submap: layout === 0 ? 0 : submapForTile(windows, tileX, tileY),
      map16Tile,
      action: classifyTile(map16Tile, precursors),
      isMap: cat.entries[slot]?.isReal ?? false,
    })
  }

  const launching = entrances.filter(e => e.action === 'map')
  const entryMaps = [...new Set(launching.filter(e => e.isMap).map(e => e.slot))]
    .sort((a, b) => a - b)

  const notes: string[] = []
  const live = entrances.filter(e => e.action === 'starWarp' || e.action === 'pipeWarp').length
  const pending = entrances.filter(e => e.action === 'pendingWarp').length
  const dead = launching.length - launching.filter(e => e.isMap).length
  notes.push(
    `${entrances.length} overworld tiles carry a translevel. ${live} are warp tiles ` +
    `($5B/$5F, bank_04.asm:1752-1771) and ${pending} more are swapped into warp tiles by ` +
    'an overworld event (DATA_04DA1D/DATA_04DA33, bank_04.asm:5377-5385), so neither ' +
    `group starts a map. Of the ${launching.length} that do, ${dead} name a slot whose ` +
    'L1 pointer is this ROM\'s filler, so no map exists there.',
  )
  if (precursors.size > 0) {
    const pairs = [...precursors.entries()]
      .map(([from, to]) => `$${from.toString(16).toUpperCase()}->$${to.toString(16).toUpperCase()}`)
      .join(', ')
    notes.push(`Event tile swaps producing a warp tile, read from this ROM: ${pairs}.`)
  }
  const unplaced = entrances.filter(e => e.submap === null).length
  if (unplaced > 0) {
    notes.push(
      `${unplaced} sub-map entrances fall outside every camera-derived sub-map window, so ` +
      'their `submap` is null. `layout`, `tileX`, `tileY` and `tileDataAddress` are exact ' +
      'regardless; only `submap` is inferred.',
    )
  }
  if (wrapped) {
    notes.push(
      'The translevel counter wrapped past $FF (`INC.B _0`, bank_04.asm:5306 is an 8-bit ' +
      'increment). Slots after the wrap collide with earlier ones, exactly as they would ' +
      'in-game.',
    )
  }
  if (mainMapBiased > 0) {
    notes.push(
      `${mainMapBiased} main-map entrances have a translevel >= $25, so CODE_05D8A2's ` +
      'low-byte gate subtracts $24 while its high-byte gate keeps them on the main map. ' +
      'Their slots collide with low-translevel main-map entrances. The two gates are ' +
      'independent (bank_05.asm:7217-7226); this is what the ROM does.',
    )
  }

  return { entrances, entryMaps, overworldReadable: true, notes }
}
