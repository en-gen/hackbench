/**
 * Which maps hold the Yoshi wings block (#1229). The derivation is docs/rom/block-contents.md, "Yoshi wings".
 *
 * Block $125 spawns by the X column it stands in (bank_02.asm:1199-1212); the column that gives
 * sprite $7E with SpriteTableC2 = 2 is not assumed but found by running the game's own item block
 * spawn once per column of its period (CODE_0288DC, the #566 exception). Yoshi touching that sprite
 * with C2 = 2 sets player animation 8 (bank_01.asm:15555-15566, 15944-15959), and YoshiWingsAni
 * then sets YoshiHeavenFlag (bank_00.asm:8295-8331). That path is fingerprinted: a ROM that edits
 * it is refused, with a note, and Yoshi Heaven stays where BonusEntrances put it.
 *
 * Layer 1 only. A Layer 2 block takes its column from the scroll position
 * (bank_02.asm:1184-1198), so no fixed column is knowable there.
 */
import { createHash } from 'crypto'
import { fingerprint } from './Fingerprint'
import { spawnInputs } from './BlockSpawnInputs'
import { readBlockContentTables, resolveBlockContents, isUnavailable } from './BlockContents'
import { cachedByVersion, type RomFile } from './RomFile'
import type { SmwRom } from './SmwRom'
import { parseLevelHeader, parseLevelObjects, isLevelModeVertical } from './LevelParser'
import { expandMap, SWITCH_FLAGS_CLEARED } from './ObjectExpander'
import { runOnce } from './sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from './sprites/interp/SpriteSeed'
import type { DispatcherSpan } from './sprites/interp/SpriteDispatch'

/** The Map16 tile the map view's block indicators also read as the item block (BlockContents). */
export const WINGS_TILE = 0x125
/** Sprite $7E: the flying red coin that Yoshi's touch turns into wings. */
export const WINGS_SPRITE = 0x7e
const WINGS_C2 = 2
/** The block's X pixel bits 4-5 pick the spawn (bank_02.asm:1199-1212): 4 columns, then it repeats. */
const PERIOD = 4

/** SHA-256 over the Yoshi-touch test (bank_01.asm:15555-15566, $01:F3DB-F3F6), the same test on the other
 *  touch path (15944-15959, $01:F6B4-F6DC), YoshiWingsAni (bank_00.asm:8295-8331, $00:C7FD-C847) and its
 *  slot in the ProcessPlayerAnimation table (bank_00.asm:7994, $00:C5A9). Vanilla US only, measured. */
export const WINGS_PATH: readonly (readonly [addr: number, length: number])[] = Object.freeze([
  [0x01f3db, 28],
  [0x01f6b4, 41],
  [0x00c7fd, 75],
  [0x00c5a9, 2],
])
export const WINGS_PATH_DIGESTS: readonly string[] = Object.freeze([
  'f2e84d9ab5aa3cb0c8d5cf0bee0ec9fcbe308b938e1000c501d11a66e8f255bd',
])

/** What the spawn left in the slot it picked. */
export interface Spawned {
  number: number
  c2: number
}

/** Test hooks, so a synthetic ROM brings its own builds of what is gated. */
export interface WingsSeams {
  digests?: readonly string[]
  /** Replaces the run of the game's spawn for one column (a synthetic tree has no sprite code). */
  spawn?: (col: number) => Spawned | string
  /** Replaces the Layer 1 grid of a slot (a synthetic ROM has no object handlers). */
  grid?: (slot: number) => number[][] | null
  dispatcher?: DispatcherSpan
  /** The sprite number and content index the spawn run is asked for; the game's own by default. */
  sprite?: number
  content?: number
}

export type WingsColumns = { columns: ReadonlySet<number>; note?: undefined } | { note: string }

function pathMismatch(rom: RomFile, digests: readonly string[]): string | null {
  const parts = WINGS_PATH.map(([addr, length]) => rom.readAt(addr, length))
  if (parts.some(p => p === null)) return 'the Yoshi wings code is not readable.'
  const fp = fingerprint(Buffer.concat(parts as Uint8Array[]))
  return digests.includes(fp!)
    ? null
    : 'the code that turns the wings into a Yoshi Heaven trip is not stock.'
}

const wanted = (seams: WingsSeams): number => seams.sprite ?? WINGS_SPRITE

/** Runs CODE_0288DC for a block at column `col` and reads back the sprite it made. */
function runSpawn(rom: RomFile, col: number, seams: WingsSeams, content: number): Spawned | string {
  let got: Spawned | undefined
  const m = runOnce(
    rom,
    wanted(seams),
    withSeed({ slot: 3, mainPasses: 1 }, SPRITE_SEED),
    {
      spawn: { inputs: spawnInputs(content, col * 16, 0), dispatcher: seams.dispatcher },
      probe: (pass, w) => {
        if (pass !== -1) return
        const slot = Array.from({ length: 12 }, (_, i) => i).find(i => w[0x14c8 + i])
        if (slot !== undefined) got = { number: w[0x9e + slot]!, c2: w[0xc2 + slot]! }
      },
    },
  )
  return m.refusal ?? got ?? 'the item block spawn made no sprite.'
}

/**
 * What one ROM's bytes answered, kept by a hash of the bytes. The Maps server hands every load a
 * fresh copy of the working copy, so an identity or version key never hits there; a hash of
 * a few MB costs far less than the four spawn runs and the grids it saves (docs/rom/block-contents.md).
 */
interface Answers {
  columns?: WingsColumns
  holders: Map<number, boolean>
}
const answers = new Map<string, Answers>()
const ANSWERS_KEPT = 4
const keys = new WeakMap<RomFile, { version: number; value: string }>()

function answersFor(rom: RomFile): Answers {
  const key = cachedByVersion(keys, rom, () =>
    createHash('sha1')
      .update(rom.buffer)
      .update(JSON.stringify(rom.dataBanks ?? null))
      .digest('hex'),
  )
  let hit = answers.get(key)
  if (!hit) {
    if (answers.size >= ANSWERS_KEPT) answers.delete(answers.keys().next().value!)
    answers.set(key, (hit = { holders: new Map() }))
  }
  return hit
}

/**
 * The columns (mod 4) of block $125 that give the wings, read from the ROM. A refusal says why in
 * plain words; the caller then adds no link. Cached per ROM version: one run per column per ROM.
 */
export function wingsColumns(rom: RomFile, seams: WingsSeams = {}): WingsColumns {
  const compute = (): WingsColumns => {
    const stock = pathMismatch(rom, seams.digests ?? WINGS_PATH_DIGESTS)
    if (stock) return { note: stock }
    let content = seams.content
    if (content === undefined && !seams.spawn) {
      const tables = readBlockContentTables(rom)
      const c = resolveBlockContents(WINGS_TILE, 0, tables)
      const first = c && !isUnavailable(c) ? c.alternatives[0]?.content : undefined
      if (first?.kind !== 'sprite') return { note: "this ROM's block contents could not be read." }
      content = first.index
    }
    const columns = new Set<number>()
    for (let col = 0; col < PERIOD; col++) {
      const r = seams.spawn ? seams.spawn(col) : runSpawn(rom, col, seams, content!)
      if (typeof r === 'string') return { note: `the item block spawn was refused: ${r}` }
      if (r.number === wanted(seams) && r.c2 === WINGS_C2) columns.add(col)
    }
    return { columns }
  }
  if (seams.spawn || seams.digests || seams.dispatcher) return compute()
  const mine = answersFor(rom)
  return (mine.columns ??= compute())
}

/** The Layer 1 grid of a slot as the map view builds it, or null when it cannot be read. */
function layer1Grid(rom: SmwRom, slot: number): number[][] | null {
  const raw = rom.getLevelRawData(slot)
  if (!raw) return null
  const table = rom.requireVerticalTable()
  const h = parseLevelHeader(raw)
  const vertical = isLevelModeVertical(h.levelMode, table)
  const objects = parseLevelObjects(raw, table).objects
  return expandMap(objects, h.levelLength, rom.rom, h.objectTileset, vertical, h.levelMode, slot, SWITCH_FLAGS_CLEARED, null) // prettier-ignore
}

/** Whether `slot`'s Layer 1 holds block $125 at a column that gives the wings. */
export function holdsWings(
  rom: SmwRom,
  slot: number,
  columns: ReadonlySet<number>,
  seams: WingsSeams = {},
): boolean {
  const seen = seams.grid ? new Map<number, boolean>() : answersFor(rom.rom).holders
  const hit = seen.get(slot)
  if (hit !== undefined) return hit
  const read = seams.grid ?? ((s: number) => layer1Grid(rom, s))
  let grid: number[][] | null = null
  try {
    grid = read(slot)
  } catch {
    // an unreadable stream reads as no block; the tree already warns on it
  }
  const holds = !!grid?.some(row =>
    row.some((id, x) => id === WINGS_TILE && columns.has(x % PERIOD)),
  )
  seen.set(slot, holds)
  return holds
}
