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
 * Operands quoted in steps 2 and 3 are vanilla's; this module reads each one.
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
 * never hardcoded: across this repo's six ROMs the only such pair is
 * $5A -> $5F, but a hack may choose others and this follows the ROM.
 *
 * Corroboration from a second, independently authored table, measured on
 * `Super Mario World (USA).vanilla.sfc`, one ROM, this revision: each of
 * its 7 pristine $5A tiles is a registered star-warp SOURCE position in the
 * paired `DATA_048431` / `DATA_048467` (bank_04.asm:491, :500) that
 * `CODE_048509` (bank_04.asm:527) searches from the $5F and $82/$5B
 * branches (called at :1756 and :1773), and each also sits at an offset
 * listed in `DATA_04D85D`. Both tables agree on all 7. Per-tile evidence
 * and the warp-table accounting: docs/ideas/level-classification.md.
 *
 * Not settled by the ROM: whether every one of those events is triggered
 * in normal play, since activation lives in save state. The classification
 * does not rest on it. 5 of the 7 slots a $5A tile would name hold this
 * ROM's filler L1 pointer, against 2 of the 79 tiles that do start a map.
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
 * not an ASM claim. SubmapFlagGate.ts checks that instruction and the path
 * into it. On any ROM where they are not stock the translevel ->
 * slot mapping is computed by code this module does not decode, so the
 * derivation reports itself unavailable and emits nothing. No map can then
 * be identified as an entry map; every map stays unclassified and fully
 * editable, which is the point of ordering the tiers this way.
 */

import type { RomFile } from './RomFile'
import type { SmwRom, OverworldRoots } from './SmwRom'
import { buildLevelCatalog, type LevelCatalog } from './LevelCatalog'
import { loadOverworldEvents } from './OverworldEvents'
import {
  OVERWORLD_ENTRY,
  OVERWORLD_INDEX_BODY,
  readTranslevelBias,
  stockCodeMismatch,
  translevelToPointerIndex,
} from './SubmapFlagGate'
import { findUnique, matchesAt, WILD, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import {
  OW_L1_MAP16_BYTES,
  OW_SUBAREA_TILES_W,
  OW_SUBAREA_TILES_H,
  loadOverworldAreas,
} from './OverworldLoader'

/** Buffer index at which the sub-map half of `OWLayer1Translevel` starts. */
export const SUBMAP_BUFFER_BASE = 0x400

/** CODE_04DC09's copy into Map16TilesLow and its call to the walk (bank_04.asm:5674-5681). */
// prettier-ignore
const WALK_CALL: BytePattern = [
  0xa9, 0xff, 0x07, // LDA #$07FF
  0xa2, WILD, WILD, // LDX #OWL1TileData
  0xa0, 0x00, 0xc8, // LDY #Map16TilesLow
  0x54, 0x7e, WILD, // MVN $7E,bank
  0xab,             // PLB
  0x20, WILD, WILD, // JSR CODE_04D7F2
  0xe2, 0x30,       // SEP #$30
  0x6b,             // RTL
]
const WALK_CALL_JSR = 13

/** CODE_04D7F2's pointer setup, entry to `LDY #start` (bank_04.asm:5264-5284),
 *  fingerprinted because it is 43 bytes. */
export const WALK_PROLOGUE_LENGTH = 43

/** Recognized builds of the two fingerprinted spans. Vanilla only, measured:
 *  the magic ROM matches both, the four hacks match neither. */
export interface OverworldFingerprints {
  entry: readonly string[]
  walk: readonly string[]
  /** BonusEntrances' CODE_05D796 span; its own stock builds when absent. */
  bonus?: readonly string[]
}
export const STOCK_OVERWORLD_FINGERPRINTS: OverworldFingerprints = Object.freeze({
  entry: OVERWORLD_INDEX_BODY.fingerprints,
  walk: Object.freeze(['8a2e57ea61a4f9e4e33c7fc744d91212eed592270a2e12c257b636745abb748e']),
})

/** The rest of the path to the tile-range compare (bank_04.asm:5285-5300). */
// prettier-ignore
const WALK: BytePattern = [
  0xa0, WILD, WILD, // LDY #start
  0x84, 0x00,       // STY _0
  0xa0, 0xff, 0x07, // LDY #$07FF
  0xa9, 0x00,       // LDA #$00
  0x97, 0x0a,       // - STA [_A],Y
  0x97, 0x0d,       // STA [_D],Y
  0x88,             // DEY
  0x10, 0xf9,       // BPL -
  0xa0, 0x00, 0x00, // LDY #$0000
  0xbb,             // TYX
  0xb7, 0x04,       // LDA [_4],Y
  0xc9, WILD,       // CMP #min
  0x90, 0x11,       // BCC +
  0xc9, WILD,       // CMP #max+1
  0xb0, 0x0d,       // BCS +
]

/** What the compare branches over, and the loop bound (bank_04.asm:5301-5309). */
// prettier-ignore
const WALK_BODY: BytePattern = [
  0xa5, 0x00,             // LDA _0
  0x97, 0x0d,             // STA [_D],Y
  0xaa,                   // TAX
  0xbf, WILD, WILD, WILD, // LDA.L DATA_04D678,X
  0x97, 0x0a,             // STA [_A],Y
  0xe6, 0x00,             // INC _0
  0xc8,                   // + INY
  0xc0, WILD, WILD,       // CPY #bound
  0xd0, 0xe3,             // BNE CODE_04D832
]

/** CODE_049132's `BRA +` over the debug warp (bank_04.asm:1730-1735). */
// prettier-ignore
const DEBUG_SKIP: BytePattern = [
  0xa5, 0x16,       // LDA byetudlrFrame
  0x29, 0x20,       // AND #$20
  0x80, WILD,       // BRA +
]

/** The L/R block the skip lands on, falling into STAR_TILE (bank_04.asm:1737-1743). */
// prettier-ignore
const LR_BLOCK: BytePattern = [
  0xa5, 0x17,       // LDA axlr0000Hold
  0x29, 0x30,       // AND #$30
  0xc9, 0x30,       // CMP #$30
  0xd0, 0x07,       // BNE +
  0xad, 0xc1, 0x13, // LDA OverworldLayer1Tile
  0xc9, 0x81,       // CMP #$81
  0xf0, WILD,       // BEQ OWPU_EnterLevel
]

/** OWPU_ABXY and the button test that branches into it (bank_04.asm:1745-1754). */
// prettier-ignore
const STAR_TILE: BytePattern = [
  0xa5, 0x16,       // LDA byetudlrFrame
  0x05, 0x18,       // ORA axlr0000Frame
  0x29, 0xc0,       // AND #$C0
  0xd0, 0x03,       // BNE OWPU_ABXY
  0x82, WILD, WILD, // BRL CODE_0491E9
  0x9c, 0x9e, 0x1b, // OWPU_ABXY: STZ SwapOverworldMusic
  0xad, 0xc1, 0x13, // LDA OverworldLayer1Tile
  0xc9, WILD,       // CMP #star
  0xd0, WILD,       // BNE OWPU_NotOnStar
]

/** OWPU_NotOnStar, read at STAR_TILE's branch target (bank_04.asm:1767-1771). */
// prettier-ignore
const PIPE_TILE: BytePattern = [
  0xad, 0xc1, 0x13, // LDA OverworldLayer1Tile
  0xc9, 0x82,       // CMP #$82
  0xf0, 0x04,       // BEQ OWPU_IsOnPipe
  0xc9, WILD,       // CMP #pipe
  0xd0, 0x11,       // BNE OWPU_NotOnPipe
]

const byteAt = (rom: RomFile, at: number): number => rom.readAtFileOffset(at, 1)![0]!

interface Walk {
  /** SNES address of the stream CODE_04DC09 copies, from its LDX and MVN operands. */
  stream: number
  /** Bytes walked, from `CPY #bound`. */
  length: number
  start: number
  min: number
  max: number
}

/** The walk's stream, tile range and starting number, read only where the call reaches them.
 *  Hack-fragility point: CODE_04DC09's own callers (bank_00.asm:2639, :4321) are not checked. */
function readWalk(rom: RomFile, prologueFingerprints: readonly string[]): Walk | null {
  const call = findUnique(rom, WALK_CALL)
  if (call === null) return null
  const word = (at: number): number => byteAt(rom, at) | (byteAt(rom, at + 1) << 8)
  const operand = word(call + WALK_CALL_JSR + 1)
  if (operand < 0x8000) return null
  const entry = (call & ~0x7fff) | (operand & 0x7fff)
  const prologue = fingerprint(rom.readAtFileOffset(entry, WALK_PROLOGUE_LENGTH))
  if (prologue === null || !prologueFingerprints.includes(prologue)) return null
  const walk = matchesAt(rom, entry + WALK_PROLOGUE_LENGTH, WALK)
  const body = matchesAt(rom, entry + WALK_PROLOGUE_LENGTH + WALK.length, WALK_BODY)
  if (!walk || !body) return null
  // OWLayer1Translevel is $800 bytes; a bound of 0 or past it is not a walk we can model.
  const length = body[15]! | (body[16]! << 8)
  if (length === 0 || length > OW_L1_MAP16_BYTES) return null
  return {
    stream: (byteAt(rom, call + 11) << 16) | word(call + 4),
    length,
    start: walk[1]!,
    min: walk[24]!,
    max: walk[28]! - 1,
  }
}

export interface WarpTiles {
  starWarpTile: number
  pipeWarpTile: number
}

/** OWPU_ABXY's two warp tiles, verified from CODE_049132's debug skip onward:
 *  through the L/R block into the star compare, whose branch target holds the
 *  pipe compare. Hack-fragility point: the route from CODE_049120 into
 *  CODE_049132 (bank_04.asm:1720-1726) is not checked. */
export function readWarpTiles(rom: RomFile): WarpTiles | null {
  const skip = findUnique(rom, DEBUG_SKIP)
  if (skip === null) return null
  const lr = skip + DEBUG_SKIP.length + ((byteAt(rom, skip + 5) << 24) >> 24)
  if (!matchesAt(rom, lr, LR_BLOCK)) return null
  const star = lr + LR_BLOCK.length
  if (!matchesAt(rom, star, STAR_TILE)) return null
  const notOnStar = star + STAR_TILE.length + ((byteAt(rom, star + 20) << 24) >> 24)
  const pipe = matchesAt(rom, notOnStar, PIPE_TILE)
  if (!pipe) return null
  return { starWarpTile: byteAt(rom, star + 18), pipeWarpTile: pipe[8]! }
}

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
  /** `isOverworldLevel`'s roots: exactly the slots the walk produced, so a gap
   *  in a hack's numbering is not one. Needs only the walk and the bias, so it
   *  survives a failed warp-tile read; null when those are unreadable. */
  roots: OverworldRoots | null
}

/** Invert `CODE_05D83E`'s index formula (bank_05.asm:7170-7195). */
export function decodeBufferIndex(bufferIndex: number): {
  layout: 0 | 1
  tileX: number
  tileY: number
} {
  const layout: 0 | 1 = bufferIndex >= SUBMAP_BUFFER_BASE ? 1 : 0
  const rel = bufferIndex & 0x3ff
  return {
    layout,
    tileX: (((rel >> 8) & 0x01) << 4) | (rel & 0x0f),
    tileY: (((rel >> 9) & 0x01) << 4) | ((rel >> 4) & 0x0f),
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
export function warpPrecursorTiles(rom: RomFile, tiles: WarpTiles): Map<number, number> {
  const out = new Map<number, number>()
  const { fromTiles, toTiles } = loadOverworldEvents(rom)
  for (let i = 0; i < fromTiles.length; i++) {
    const to = toTiles[i]
    if (to === tiles.starWarpTile || to === tiles.pipeWarpTile) out.set(fromTiles[i]!, to)
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

function classifyTile(
  tile: number,
  precursors: Map<number, number>,
  starWarpTile: number,
  pipeWarpTile: number,
): EntranceAction {
  if (tile === starWarpTile) return 'starWarp'
  if (tile === pipeWarpTile) return 'pipeWarp'
  if (precursors.has(tile)) return 'pendingWarp'
  return 'map'
}

function unavailable(notes: string[], roots: OverworldRoots | null = null): OverworldEntranceIndex {
  return { entrances: [], entryMaps: [], overworldReadable: false, notes, roots }
}

function rootsOf(walked: { layout: 0 | 1; slot: number }[]): OverworldRoots {
  const half = (layout: 0 | 1): Set<number> =>
    new Set(walked.filter(e => e.layout === layout).map(e => e.slot))
  return { main: half(0), sub: half(1) }
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
  fingerprints: OverworldFingerprints = STOCK_OVERWORLD_FINGERPRINTS,
): OverworldEntranceIndex {
  const patched = stockCodeMismatch(rom.rom, OVERWORLD_ENTRY, fingerprints.entry)
  if (patched) {
    return unavailable([
      `Overworld not readable: ${patched} This ROM's overworld was rebuilt by another ` +
        'editor, whose translevel-to-slot ' +
        'mapping is code HackBench does not decode. No entry maps can be identified, so ' +
        'every map is left unclassified and stays fully editable. To get the overworld ' +
        'grouping, start from an unmodified ROM.',
    ])
  }

  // Already proved stock above; this only reads the three operands.
  const mapping = readTranslevelBias(rom.rom, fingerprints.entry)
  if (!mapping.ok) {
    return unavailable([
      `Overworld not readable: ${mapping.reason} No entry maps can be identified.`,
    ])
  }
  const walk = readWalk(rom.rom, fingerprints.walk)
  if (!walk) {
    return unavailable([
      'Overworld not readable: CODE_04D7F2, the translevel walk, is not reached from its ' +
        'call in CODE_04DC09 through stock code (bank_04.asm:5264-5309, :5679). No entry ' +
        'maps can be identified.',
    ])
  }

  const stream = rom.rom.readAt(walk.stream, walk.length)
  if (!stream) {
    return unavailable([
      'Overworld not readable: the Layer-1 tile stream at SNES ' +
        `$${walk.stream.toString(16).toUpperCase()} could not be read ` +
        `(${walk.length} bytes). No entry maps can be identified, so every map is ` +
        'left unclassified.',
    ])
  }

  const walked: { bufferIndex: number; translevel: number; layout: 0 | 1; slot: number }[] = []
  let counter = walk.start
  let wrapped = false
  for (let bufferIndex = 0; bufferIndex < walk.length; bufferIndex++) {
    const tile = stream[bufferIndex]!
    if (tile < walk.min || tile > walk.max) continue
    const translevel = counter
    counter = (counter + 1) & 0xff
    if (counter === 0) wrapped = true
    const layout: 0 | 1 = bufferIndex >= SUBMAP_BUFFER_BASE ? 1 : 0
    const slot = translevelToPointerIndex(mapping, translevel, layout)
    walked.push({ bufferIndex, translevel, layout, slot })
  }
  const roots = rootsOf(walked)

  const warpTiles = readWarpTiles(rom.rom)
  if (!warpTiles) {
    return unavailable(
      [
        "Overworld not readable: OWPU_ABXY's warp-tile compares are not reached through " +
          'stock code (bank_04.asm:1745-1771), so which tiles start a map is unknown. The ' +
          'overworld roots are still read.',
      ],
      roots,
    )
  }

  const cat = catalog ?? buildLevelCatalog(rom)
  const windows = submapWindows(rom.rom)
  const precursors = warpPrecursorTiles(rom.rom, warpTiles)
  const entrances: OverworldEntrance[] = walked.map(({ bufferIndex, translevel, layout, slot }) => {
    const { tileX, tileY } = decodeBufferIndex(bufferIndex)
    const map16Tile = stream[bufferIndex]!
    return {
      slot,
      translevel,
      bufferIndex,
      tileDataAddress: walk.stream + bufferIndex,
      layout,
      tileX,
      tileY,
      submap: layout === 0 ? 0 : submapForTile(windows, tileX, tileY),
      map16Tile,
      action: classifyTile(map16Tile, precursors, warpTiles.starWarpTile, warpTiles.pipeWarpTile),
      isMap: cat.entries[slot]?.isReal ?? false,
    }
  })
  const mainMapBiased = entrances.filter(
    e => e.layout === 0 && e.translevel >= mapping.threshold,
  ).length

  const launching = entrances.filter(e => e.action === 'map')
  const entryMaps = [...new Set(launching.filter(e => e.isMap).map(e => e.slot))].sort(
    (a, b) => a - b,
  )

  const notes: string[] = []
  const live = entrances.filter(e => e.action === 'starWarp' || e.action === 'pipeWarp').length
  const pending = entrances.filter(e => e.action === 'pendingWarp').length
  const dead = launching.length - launching.filter(e => e.isMap).length
  notes.push(
    `${entrances.length} overworld tiles carry a translevel. ${live} are warp tiles ` +
      `($5B/$5F, bank_04.asm:1752-1771) and ${pending} more are swapped into warp tiles by ` +
      'an overworld event (DATA_04DA1D/DATA_04DA33, bank_04.asm:5377-5385), so neither ' +
      `group starts a map. Of the ${launching.length} that do, ${dead} name a slot whose ` +
      "L1 pointer is this ROM's filler, so no map exists there.",
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
    const thr = `$${mapping.threshold.toString(16).toUpperCase()}`
    notes.push(
      `${mainMapBiased} main-map entrances have a translevel >= ${thr}, so CODE_05D8A2's ` +
        `low-byte gate subtracts $${mapping.bias.toString(16).toUpperCase()} while its high-byte gate keeps them on the main map. ` +
        'Each lands on translevel minus the bias, which can be the slot of a lower ' +
        'main-map translevel. The two gates are ' +
        'independent (bank_05.asm:7217-7226); this is what the ROM does.',
    )
  }

  return { entrances, entryMaps, overworldReadable: true, notes, roots }
}
