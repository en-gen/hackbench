/**
 * Everything a map's L2 (background) is drawn from, read from the ROM in one
 * place, beside `buildL1Inputs`. Both kinds the game loads: a preset image
 * (L2 pointer bank byte $FF, CODE_05801E) tiled across the map, and an object
 * stream expanded like L1's. The result is data, not pixels: ids into a Map16
 * table, plus the shift that puts L2 where the game shows it.
 */
import type { MapEntrances, SmwRom } from '../SmwRom'
import type { RomFile } from '../RomFile'
import { entrancePositionGate } from '../SubmapFlagGate'
import { hex2, hex3s as hex3 } from '../hex'
import {
  isPresetPtr,
  l2ObjectGate,
  isSkippedLevelMode,
  l2PaletteOrForTileset,
  L2_EMPTY_TILE,
  loadL2Objects,
  loadL2Preset,
  readInitialLayer2YPos,
  readL2Pointer,
  tilePresetGrid,
} from '../L2Loader'
import { chooseEntranceNoted, readInitialLayer1YPos } from '../L3Loader'
import { isLevelModeVerticalL2, SCREEN_H_VERT, SCREEN_W_VERT } from '../LevelParser'
import { readL2UploaderTable } from '../L2UploaderTable'
import { loadMap16Tiles, readL2Map16Table, type Map16Tile } from '../Map16'
import type { L1Inputs } from './L1Model'

export interface L2Inputs {
  kind: 'image' | 'objects'
  /** Map16 ids in the L1 grid's own layout (screens side by side, or stacked when vertical); null where empty. */
  grid: (number | null)[][]
  /** Definitions by id, with the tileset-3 palette OR already applied. */
  tiles: readonly (Map16Tile | undefined)[]
  /**
   * Pixels the grid sits below its row, `Layer1YPos - Layer2YPos` at level start (#113), image or
   * objects alike: Layer2YPos comes from DATA_05D70C either way (bank_05.asm:7323-7328).
   */
  dy: number
  /** Dispatch-path notes from the object build (#493), deduped by the caller; absent for an image. */
  unverified?: string[]
  /** Why `dy` is unverified: the entrances that reach the map start L2 at different heights (#505). */
  note?: string
}

export type L2Result = { ok: true; l2: L2Inputs } | { ok: false; reason: string }

/**
 * The OR the strip uploader applies to every L2 object-stream subtile in
 * tileset 3 (bank_05.asm:1387-1391, 1503-1507), onto each definition.
 */
function withPaletteOr(tiles: readonly Map16Tile[], mask: number): Map16Tile[] {
  if (mask === 0) return [...tiles]
  const sub = (s: Map16Tile['tl']) => ({ ...s, palette: s.palette | mask })
  return tiles.map(t => ({ ...t, tl: sub(t.tl), tr: sub(t.tr), bl: sub(t.bl), br: sub(t.br) }))
}

/** One way into a map, in the order the view prefers when they disagree. */
type EntryPath = { kind: 'overworld' | 'exit' | 'midway' } | { kind: 'secondary'; id: number }

const PATH_WORDS = { overworld: 'from the overworld', exit: 'by a screen exit', midway: 'from the midway point' } // prettier-ignore
const pathWords = (p: EntryPath): string => (p.kind === 'secondary' ? `through secondary entrance ${hex3(p.id)}` : PATH_WORDS[p.kind]) // prettier-ignore

/**
 * `Layer1YPos - Layer2YPos` as the level load leaves them for one way in. Low bytes: a primary
 * entry indexes DATA_05D708/D70C with F400 bits 3-2 / 1-0 (bank_05.asm:7323-7335), a secondary one
 * with that entrance's FA00 bits 5-4 / 7-6 (:7120-7146). High bytes: only when F600 bit 5 makes the
 * ScreenMode vertical (:7292-7299, 7379-7381), from `_1 & $1F`, `_1` being F600 or the entrance's
 * FC00 (:7147-7148, 7336-7337, 7376-7388); L2's only when VertLayer2Setting != 3 (:7390-7393).
 * The midway restart jumps past both high-byte writes, which stay 0 (:7287-7288, 7362-7373).
 */
function entryDy(rom: RomFile, index: number, path: EntryPath): number {
  const byte = (addr: number) => rom.readByte(addr) ?? 0
  const sec = path.kind === 'secondary'
  const lows = byte(sec ? 0x05fa00 + path.id : 0x05f400 + index)
  const l1 = byte(0x05d708 + ((lows >> (sec ? 4 : 2)) & 3))
  const l2 = byte(0x05d70c + ((lows >> (sec ? 6 : 0)) & 3))
  const vertical = (byte(0x05f600 + index) & 0x20) !== 0
  if (!vertical || path.kind === 'midway') return l1 - l2
  const high = (sec ? byte(0x05fc00 + path.id) : byte(0x05f600 + index)) & 0x1f
  const l2High = byte(0x05d710 + (byte(0x05f000 + index) >> 4)) === 3 ? 0 : high // :7268-7277
  return ((high << 8) | l1) - ((l2High << 8) | l2)
}

/**
 * The map's `dy` from the entrances that reach it, or null when none is known (an orphan, a bonus
 * map, an unavailable exit graph). Disagreeing entrances draw the one `chooseEntrance` names and say so.
 */
function dyFromEntrances(
  rom: RomFile,
  index: number,
  via?: MapEntrances,
): { dy: number; note?: string } | null {
  if (!via) return null
  // A midway restart needs MidwayFlag, which the tape (Map16 $038) sets only while DisableMidway,
  // F400[map] >> 4 at the overworld entry, is nonzero (bank_00.asm:13042-13050; bank_05.asm:7349-7357).
  const midway = (rom.readByte(0x05f400 + index) ?? 0) >> 4 !== 0
  const paths: EntryPath[] = [
    ...(via.overworld ? [{ kind: 'overworld' as const }] : []),
    ...(via.primary ? [{ kind: 'exit' as const }] : []),
    ...(via.overworld && midway ? [{ kind: 'midway' as const }] : []),
    ...via.secondary.map(id => ({ kind: 'secondary' as const, id })),
  ]
  if (paths.length === 0) return null
  // The drawn path is the one L3Model's camera uses, from the same chooser (#861): null is the
  // primary entry (the first primary path), else the secondary id it names. Never an ordering of
  // our own, so the two views cannot drift apart on a non-ascending entrance list.
  const { entrance: chosen, note: routeNote } = chooseEntranceNoted(via)
  const at = chosen === null ? 0 : paths.findIndex(p => p.kind === 'secondary' && p.id === chosen)
  const ordered = [paths[at]!, ...paths.filter((_, i) => i !== at)]
  const dys = ordered.map(p => entryDy(rom, index, p))
  const differ = ordered.filter((_, i) => dys[i] !== dys[0]).map(pathWords)
  const differNote = differ.length === 0 ? undefined : `drawn as entered ${pathWords(ordered[0]!)}; entered ${differ.join(', ')} it starts at a different height.` // prettier-ignore
  const note = [differNote, routeNote].filter(Boolean).join(' ') || undefined
  return note ? { dy: dys[0]!, note } : { dy: dys[0]! }
}

/**
 * Read one map's L2, or why it cannot be read. Never a vanilla fallback. `entrances` is how the
 * game enters the map (`SmwRom.buildLevelExitGraph`); `startGate` names why the level-load code
 * is not stock, or null. Without entrances (graph unavailable) the position is the primary entrance's
 * F400/F600, never a secondary entrance's row.
 */
export function buildL2Inputs(
  rom: SmwRom,
  index: number,
  l1: L1Inputs,
  entrances?: MapEntrances,
  startGate: (rom: RomFile) => string | null = rom => entrancePositionGate(rom),
): L2Result {
  const refuse = (reason: string): L2Result => ({ ok: false, reason })
  const ptr = readL2Pointer(rom.rom, index)
  if (ptr === null) return refuse(`The L2 pointer of map ${hex3(index)} is outside the ROM`)
  const { screenCount: screens, isVertical, header } = l1
  // The level-start relation `Layer1YPos - Layer2YPos`, the view's representative frame; later
  // vertical scrolling moves L2 against L1 when VertLayer2Setting != 1. The high bytes follow the
  // ScreenMode the entry code builds from F600 bits 5-6 (bank_05.asm:7292-7299, 7379-7381), not the
  // VerticalTable, which the header parse applies later (:552-553). With no known entrance
  // (so none is chosen), the primary entrance's F400/F600.
  const entryVertical = ((rom.rom.readByte(0x05f600 + index) ?? 0) & 0x20) !== 0
  const known = dyFromEntrances(rom.rom, index, entrances)
  const dy = (): number => known?.dy ?? readInitialLayer1YPos(rom.rom, index, entryVertical) - readInitialLayer2YPos(rom.rom, index, entryVertical) // prettier-ignore
  // The tables are the game's only while the code reading them is stock (LEVEL_START_Y): if not,
  // the best reading still draws, said to be unverified.
  const gate = startGate(rom.rom)
  const why = [
    gate,
    known?.note && gate ? `${known.note[0]!.toUpperCase()}${known.note.slice(1)}` : known?.note,
  ].filter(Boolean)
  const note = why.length ? `Background height unverified: ${why.join(' ')}` : undefined
  const preset = isPresetPtr(ptr)
  // Order (D51 B, #506): develop's #637 gate owns the object-stream path in the ten skipped modes,
  // so it runs before the table; a preset ($FF) pointer is an image in every mode, skipped or not
  // (the image routine runs for modes $00/$0A, bank_05.asm:1104, 1114, independent of LoadLevel's
  // skips, :444-457), and goes straight to the table. The table decides every other case.
  if (!preset) {
    const objectGate = l2ObjectGate(rom.rom, header.levelMode)
    if (objectGate === 'unrecognized') {
      return refuse(`Layer 2 not drawn: the mode-skip chain of this ROM is not recognized (level mode $${hex2(header.levelMode)})`) // prettier-ignore
    }
    if (objectGate === 'skipped') {
      return refuse(`The game loads no layer 2 objects in level mode $${hex2(header.levelMode)}`)
    }
  }
  // A hijacked check site leaves a skipped mode's stream behaviour as it was (gate 'loads'); the
  // table has nothing to add there.
  const hijackedSkip = !preset && isSkippedLevelMode(header.levelMode)
  // The game picks the uploader by level mode (bank_05.asm:1099-1135); the pointer's bank byte must
  // agree with it, or the game would draw the map differently (#506). That is the level-load upload
  // (CODE_058955) only; scroll-time uploads go through CODE_058883, which is not checked here.
  if (!hijackedSkip) {
    const uploaders = readL2UploaderTable(rom.rom)
    if (!uploaders.ok) return refuse(uploaders.reason)
    const mode = header.levelMode & 0x1f
    const entry = uploaders.entries[mode]!
    const modeName = `level mode $${mode.toString(16).padStart(2, '0')}`
    if (entry.kind === 'unrecognized') {
      return refuse(`The L2 uploader for ${modeName} (at $${entry.target.toString(16)}) is not a routine this reader recognizes`) // prettier-ignore
    }
    if (entry.kind === 'none') return refuse(`${modeName} uploads no L2`)
    if (preset !== (entry.kind === 'image')) {
      return refuse(`${modeName} uploads an L2 ${entry.kind === 'image' ? 'image' : 'object stream'}, but the L2 pointer of ${hex3(index)} is ${preset ? 'an image' : 'an object stream'}`) // prettier-ignore
    }
  }
  try {
    if (preset) {
      const image = loadL2Preset(rom.rom, ptr)
      if (!image) return refuse(`The background image at the L2 pointer of ${hex3(index)} cannot be read`) // prettier-ignore
      const table = readL2Map16Table(rom.rom)
      if (!table.ok) return refuse(`The background's Map16 table cannot be read: ${table.reason}`)
      const cols = isVertical ? SCREEN_W_VERT : screens * 16
      const rows = isVertical ? screens * SCREEN_H_VERT : 27
      return {
        ok: true,
        l2: { kind: 'image', grid: tilePresetGrid(image, cols, rows), tiles: loadMap16Tiles(rom.rom, table.value), dy: dy(), note }, // prettier-ignore
      }
    }
    // After the gate and the table, before the orientation check: modes $0A and $0D would otherwise be refused for a layout mismatch the game never meets.
    const vertical = rom.getVerticalTable()
    if (!vertical.ok) return refuse(vertical.reason)
    const l2Vertical = isLevelModeVerticalL2(header.levelMode, vertical.table)
    if (l2Vertical !== isVertical) {
      return refuse(`L2 is ${l2Vertical ? 'vertical' : 'horizontal'} but L1 is ${isVertical ? 'vertical' : 'horizontal'}; the two cannot share one screen layout`) // prettier-ignore
    }
    const objects = loadL2Objects(rom.rom, ptr, screens, header.objectTileset, l2Vertical)
    if (!objects) return refuse(`The L2 object stream of ${hex3(index)} cannot be read`)
    return {
      ok: true,
      l2: {
        kind: 'objects',
        grid: objects.grid.map(row => row.map(id => (id === L2_EMPTY_TILE ? null : id))),
        tiles: withPaletteOr(l1.map16.tiles, l2PaletteOrForTileset(header.objectTileset)),
        dy: dy(),
        unverified: objects.unverified,
        note,
      },
    }
  } catch (err) {
    return refuse(`The background of ${hex3(index)} could not be read: ${(err as Error).message}`)
  }
}
