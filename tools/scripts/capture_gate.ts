/**
 * The L1 (foreground) data gate (en-gen/hackbench#205 phase 1): for each
 * map, build the Map16 grid, the Map16 definitions (with per-strip pipe
 * sets) and the L1 chars and palette from the ROM's working copy, and
 * check each one byte for byte against a Mesen capture. A mismatch names
 * the map, the table and the cell/char/color; a listed map whose capture
 * cannot be read is a failure, not a skip.
 *
 * Reads captures only through `loadLevel`/`openMap`/`pipeInfo`
 * (capture_render.ts) and the small decoders in capture_decode.ts, so this
 * is the one module allowed to import both `src/rom/` and the capture
 * tooling: the capture side otherwise imports nothing from `src/`.
 */
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SmwRom } from '../../src/rom/SmwRom'
import {
  BOSS_ARENA_SCREENS,
  SWITCH_FLAGS_UNCLEARED,
  type Refusal,
} from '../../src/rom/ObjectExpander'
import { buildL1Inputs } from '../../src/rom/model/L1Model'
import {
  decodeSubTileWord,
  encodeSubTileWord,
  pipeVariantIndex,
  PIPE_VARIANT_TILE_START,
  PIPE_VARIANT_TILE_COUNT,
  type Map16Tile,
} from '../../src/rom/Map16'
import type { AnimationData } from '../../src/rom/AnimationLoader'
import { getCharPixels, type VramState } from '../../src/rom/GfxLoader'
import { collectPaletteAnimFrames } from '../../src/rom/model/palette/PaletteFactory'
import type { RgbaColor } from '../../src/rom/GraphicsDecoder'
import { openMap, loadLevel, pipeInfo, type Reader } from './capture_render'
import * as D from './capture_decode'
import { FG_GATE_MAPS, idToCaptureName, idToHex } from './fgGateMaps'

export type Table = 'grid' | 'defs' | 'pipes' | 'chars' | 'palette'
const TABLES: Table[] = ['grid', 'defs', 'pipes', 'chars', 'palette']

export interface GateMismatch {
  table: Table
  /** A cell "c,r", a Map16 id + quadrant, a char number or a CGRAM index - table-specific. */
  cell: string
  expected: string
  actual: string
}

export interface GateResult {
  id: number
  ok: boolean
  /** Set when the capture (or a ROM read this gate needs) could not be read at all. */
  unavailable?: string
  /** Capped at `maxReported` per table (see `runGate`/`gateMap`); `totals` never is. */
  mismatches: GateMismatch[]
  totals: Record<Table, number>
  /** Foreground writes past the level's own end (bank_0D handlers bleeding into
   *  the next screen's memory) - real ROM behavior, never a mismatch. */
  overflow: string[]
  /** Builds the vanilla pipe-color bug (#571) allows, by rule - visible and bounded, never silently absorbed into "pass". */ // prettier-ignore
  allowed: AllowedDifference[]
}

/** The one place `ok` is computed: unavailable trumps everything, else zero mismatches. */
export function deriveOk(
  unavailable: string | undefined,
  mismatches: readonly GateMismatch[],
): boolean {
  return unavailable === undefined && mismatches.length === 0
}

export const hex = (n: number, w = 0) => '$' + n.toString(16).toUpperCase().padStart(w, '0')

/**
 * A SHA-256 of one table's mismatch set, order-independent (sorted by cell
 * first). Identifies a mismatch set by content without committing the
 * cells themselves - `test/suite/unit/fixtures/fgKnownFailures.json` is our
 * own derived ids, not ROM bytes, but the level layout they reconstruct is
 * still something docs/testing.md asks not to commit; this and a count are
 * enough to catch a moved cell or a changed value, never to rebuild it.
 */
/** Code-unit order, not locale order: stable across machines/locales, unlike `localeCompare`. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function hashMismatches(mismatches: readonly GateMismatch[]): string {
  const sorted = [...mismatches]
    .map(m => ({ cell: m.cell, expected: m.expected, actual: m.actual }))
    .sort((a, b) => byCodeUnit(a.cell, b.cell) || byCodeUnit(a.expected, b.expected) || byCodeUnit(a.actual, b.actual)) // prettier-ignore
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

const ZERO_TOTALS: Record<Table, number> = { grid: 0, defs: 0, pipes: 0, chars: 0, palette: 0 }

/** A whole map is unreadable: every table reads zero, `ok` follows from the reason alone. */
function unavailable(id: number, reason: string): GateResult {
  return { id, ok: deriveOk(reason, []), unavailable: reason, mismatches: [], totals: ZERO_TOTALS, overflow: [], allowed: [] } // prettier-ignore
}

export function quadWords(t: Map16Tile): number[] {
  return [t.tl, t.tr, t.bl, t.br].map(encodeSubTileWord)
}

/** `Map16Pointers[$133..$13A]`, the 8 tiles CODE_0580BD/CODE_05877E redirect per strip. */
const PIPE_LO = PIPE_VARIANT_TILE_START
const PIPE_HI = PIPE_VARIANT_TILE_START + PIPE_VARIANT_TILE_COUNT - 1

// ── Table 1: the Map16 grid ─────────────────────────────────────────────────

/**
 * How many columns (horizontal) or rows (vertical) of the grid are really
 * this level's own, honoring the boss-arena override `expandMap` itself
 * applies (bank_00.asm CODE_009925/CODE_009A17 and the .IggyLarry branch;
 * `ObjectExpander.BOSS_ARENA_SCREENS`, not duplicated here). A cell beyond
 * this bound is a handler bleeding into the next screen's memory
 * (CODE_0DEE89, bank_0D.asm:8203-8226; CODE_0DA95D, bank_0D.asm:1998-2016
 * both do this on column 16 of a 1-screen level) - real, faithful behavior.
 */
function levelExtent(levelLength: number, levelMode: number): number {
  return (levelMode === 9 || levelMode === 11 ? BOSS_ARENA_SCREENS : levelLength) * 16
}

/** Table 1: the Map16 id grid, `expandMap` vs the capture's own `map16Id`. */
export function checkGrid(
  romGrid: number[][],
  grid: Uint8Array,
  meta: D.GridMeta,
  extent: number,
  isVertical: boolean,
): { mismatches: GateMismatch[]; overflow: string[] } {
  const { cols, rows } = D.gridDims(meta)
  const mismatches: GateMismatch[] = []
  const overflow: string[] = []
  const dims = (expected: string, actual: string) =>
    mismatches.push({ table: 'grid', cell: 'dimensions', expected, actual })
  if (romGrid.length !== rows) {
    dims(`${cols}x${rows}`, `${romGrid[0]?.length ?? 0}x${romGrid.length}`)
    return { mismatches, overflow }
  }
  // The axis `extent` measures (screens) must equal what the capture itself
  // says it is - a silent mismatch here would compare fewer cells than the
  // level actually has, without ever saying so.
  const screenAxis = isVertical ? rows : cols
  if (screenAxis !== extent) dims(`${isVertical ? 'rows' : 'cols'}=${extent}`, `${isVertical ? 'rows' : 'cols'}=${screenAxis}`) // prettier-ignore
  const colBound = isVertical ? cols : Math.min(cols, extent)
  const rowBound = isVertical ? Math.min(rows, extent) : rows
  for (let r = 0; r < rows; r++) {
    const row = romGrid[r]!
    const wantCols = Math.min(cols, colBound)
    if (row.length > colBound) {
      overflow.push(`row ${r} writes col ${colBound}..${row.length - 1} past the level's own end`)
    } else if (r < rowBound && row.length < wantCols) {
      dims(`row ${r}: ${wantCols} cols`, `row ${r}: ${row.length} cols`)
    }
    for (let c = 0; c < Math.min(wantCols, row.length); c++) {
      if (r >= rowBound) continue
      const capId = D.map16Id(grid, meta, c, r)
      const romId = row[c]!
      if (capId !== romId) {
        mismatches.push({ table: 'grid', cell: `${c},${r}`, expected: hex(capId), actual: hex(romId) }) // prettier-ignore
      }
    }
  }
  return { mismatches, overflow }
}

// ── Table 2: Map16 definitions ──────────────────────────────────────────────

/**
 * Table 2: 4 words per Map16 id, bit 13 included, against the resident defs.
 * `skipPipeRange` (a MAP16AppTable is present) additionally asserts, rather
 * than skips outright, that the compiled default for `$133..$13A` is one of
 * the 4 known variants - real, just not necessarily resident during play.
 */
export function checkDefs(
  tiles: Map16Tile[],
  pipeVariants: Map16Tile[][],
  defs: Uint8Array,
  order: number[],
  skipPipeRange: boolean,
): GateMismatch[] {
  const out: GateMismatch[] = []
  const capCount = defs.length >> 3
  if (tiles.length !== capCount) {
    out.push({ table: 'defs', cell: 'length', expected: `${capCount} ids`, actual: `${tiles.length} ids` }) // prettier-ignore
  }
  for (let id = 0; id < Math.min(tiles.length, capCount); id++) {
    if (skipPipeRange && id >= PIPE_LO && id <= PIPE_HI) {
      const rom = quadWords(tiles[id]!)
      const known = pipeVariants.some(v => quadWords(v[id - PIPE_LO]!).every((w, q) => w === rom[q])) // prettier-ignore
      if (!known) {
        out.push({ table: 'defs', cell: `${hex(id)} (compiled default)`, expected: 'one of the 4 MAP16AppTable variants', actual: rom.map(w => hex(w)).join(',') }) // prettier-ignore
      }
      continue
    }
    const rom = quadWords(tiles[id]!)
    for (let q = 0; q < 4; q++) {
      const cap = D.defWord(defs, order, id, q & 1, q >> 1)
      if (rom[q] !== cap) {
        out.push({ table: 'defs', cell: `${hex(id)} q${q}`, expected: hex(cap), actual: hex(rom[q]!) }) // prettier-ignore
      }
    }
  }
  return out
}

// ── Table 3: per-strip pipe sets ────────────────────────────────────────────

/** One strip build, as `map16_pipe_writes.json` records it: words already in TL,TR,BL,BR order per id. */
export interface PipeBuild {
  strip: number
  frame: number
  words: number[]
}

export interface PipeWrites {
  lo: number
  hi: number
  /** Every build, post-`levelLoadFrame`, including negative (pre-level) strips. */
  builds: PipeBuild[]
  /** Builds `pipeInfo` could not resolve (unresolved pointers, or a NaN frame/strip) - surfaced, not dropped. */ // prettier-ignore
  unresolved: { strip: number; frame: number }[]
}

/**
 * Parse `map16_pipe_writes.json` (+ `capture_summary.json` for
 * `levelLoadFrame`) via `pipeInfo`, keeping negative strips: MapBuilder's
 * `expandMap` has no notion of "before the level start" either, so
 * `pipeVariantIndex` is asked about those strips exactly like any other.
 */
export function parsePipeWrites(rawWrites: unknown, rawSummary: unknown): PipeWrites | null {
  const loadFrameNum = D.parseNum((rawSummary as Record<string, unknown> | null)?.levelLoadFrame)
  const loadFrame = Number.isNaN(loadFrameNum) ? -Infinity : loadFrameNum
  const info = pipeInfo(rawWrites, loadFrame, { includeNegative: true })
  if (!info) return null
  const builds = Object.entries(info.builds).flatMap(([stripStr, list]) =>
    list.map(b => ({ strip: Number(stripStr), frame: b.frame, words: b.words })),
  )
  return { lo: info.lo, hi: info.hi, builds, unresolved: info.unresolved }
}

/**
 * en-gen/hackbench#205's allowed pipe differences: a vanilla SMW bug (owner
 * ruling 2026-09-26, not a HackBench defect - the pipe color is intended PER
 * SCREEN everywhere, and `pipeVariantIndex(strip)` is correct). The capture
 * faithfully records the bug, so the gate must allow exactly it, tightly
 * (round 5c's "any of the 4 variants" widening rested on a misdiagnosis of
 * $108 and is gone):
 *   - H_S0: a HORIZONTAL level's load's OWN first build of its first strip
 *     s0 (bank_05.asm:889-891 does NOT branch away for a horizontal level,
 *     so :907-909's pick runs) reads `Layer1TileUp,X` with X =
 *     `Layer1ScrollDir`, a WORD index: 0 gives f(s0) (not an exemption -
 *     matches "as today" directly), 2 gives f(s0+$1F) (exempt). Measured:
 *     all 136 of 136 horizontal s0 builds are one of exactly these two: no
 *     other variant was observed. Any other variant is a mismatch, meaning
 *     a stale index outside 0 or 2, which fails closed rather than
 *     widening again.
 *   - V_S0_DEFAULT: a VERTICAL level's load never runs the pick at all -
 *     bank_05.asm:889-891 (`LDA ScreenMode` / `BNE CODE_0587CB`) branches
 *     away BEFORE it, since `ScreenMode` is loaded from `VerticalTable`
 *     (:552-553). Its s0 build keeps whatever CODE_0581FB's own compiled
 *     Map16 defaults are for ids $133-$13A (the `JSR` at :429, the
 *     `DATA_0581BB` read at :273, its load loop at :281-316) - the SAME
 *     bytes `loadMap16`/`loadMap16WithPipeVariants` already produce for
 *     those ids, read from the ROM here too, never hardcoded. Exempt only
 *     when that default differs from f(s0) (measured: 6 of 7 vertical
 *     maps); when it equals f(s0) outright the build is already an
 *     ordinary "as today" match (measured: 1 of 7, no exemption needed).
 *   - VERTICAL (post-load): a vertical level's builds outside the load
 *     PASS, in EITHER direction or on an already-visited in-window strip
 *     (bank_05.asm:931-945, `CODE_0587CB` writes no set), keep whatever was
 *     resident at the load loop's end, f(s0+$20), REPLACING f(strip).
 * The load loop itself (s0+1..s0+$1F, bank_05.asm:110-143) and a
 * horizontal level's scroll builds (:899-929) get f(strip), no exemption.
 * A build's exemption applies only to the load's OWN first write of s0,
 * identified by object (chronologically, sorted by frame then strip within
 * one frame - $0D0 builds 247-250 together in frame 452), never by strip
 * VALUE: a later rebuild of the same strip number gets none of the above.
 * The load PASS itself - the first 32 chronological builds forming exactly
 * s0..s0+$1F - is checked directly: a capture whose first 32 builds are not
 * that exact run reports one `load-pass` mismatch (both orientations),
 * since every other rule above assumes that shape holds.
 */
export const ALLOWED_PIPE_BUG_H_S0 = '#571 H_S0: first strip matches f(s0+$1F) (bank_05.asm:907-909)' // prettier-ignore
export const ALLOWED_PIPE_BUG_V_S0_DEFAULT =
  '#571 V_S0_DEFAULT: first strip matches the ROM-compiled default for $133-$13A, not f(s0) (bank_05.asm:889-891,273,281-316,429)' // prettier-ignore
export const ALLOWED_PIPE_BUG_VERTICAL =
  '#571 VERTICAL: post-load frozen at f(s0+$20) (bank_05.asm:931-945)'

export interface AllowedDifference {
  rule: string
  count: number
}

/** Table 3: `pipeVariantIndex(strip)` vs the words the capture recorded for that strip's build, with the allowed divergences above; anything else is a mismatch, as today. */ // prettier-ignore
export function checkPipes(
  pipeVariants: Map16Tile[][],
  writes: PipeWrites,
  citesPipeRange: boolean,
  isVertical: boolean,
  tiles: readonly Map16Tile[] = [],
): { mismatches: GateMismatch[]; allowed: AllowedDifference[] } {
  if (writes.lo !== PIPE_LO || writes.hi !== PIPE_HI) {
    return {
      mismatches: [{ table: 'pipes', cell: 'range', expected: `${hex(PIPE_LO)}..${hex(PIPE_HI)}`, actual: `${hex(writes.lo)}..${hex(writes.hi)}` }], // prettier-ignore
      allowed: [],
    }
  }
  const mismatches: GateMismatch[] = writes.unresolved.map(u => ({
    table: 'pipes',
    cell: `strip ${u.strip} frame ${u.frame}`,
    expected: 'a resolved build (pointers and a numeric frame/strip)',
    actual: 'unresolved',
  }))
  if (!writes.builds.length) {
    if (citesPipeRange) {
      mismatches.push({ table: 'pipes', cell: 'builds', expected: 'at least one recorded strip build', actual: '0' }) // prettier-ignore
    }
    return { mismatches, allowed: [] }
  }
  const variantWords = pipeVariants.map(tiles => tiles.flatMap(quadWords))
  const wordsFor = (strip: number): number[] | undefined => variantWords[pipeVariantIndex(strip)]
  const sameWords = (a?: number[], b?: number[]): boolean =>
    !!a && !!b && a.length === b.length && a.every((w, i) => w === b[i])
  // CODE_0581FB's own compiled Map16 defaults for $133-$13A (bank_05.asm:
  // 273,281-316,429), read straight from the ROM's main table - never
  // hardcoded - for V_S0_DEFAULT.
  const compiledDefault = tiles.length > PIPE_HI ? tiles.slice(PIPE_LO, PIPE_HI + 1).flatMap(quadWords) : undefined // prettier-ignore

  // s0: the load's lowest strip. The load loop writes exactly $20
  // consecutive strips, s0, s0+1, .., s0+$1F, one per iteration - so the
  // load PASS is identified chronologically (sorted by frame, then strip
  // within a frame that builds several at once - $0D0 frame 452 builds
  // 247-250), by walking forward from the first build while each next
  // build's strip is exactly one more than the last. Once that run breaks
  // (a repeat, skip, or reversal), the load is over: every later build is a
  // REVISIT, even one that lands back on a strip inside s0..s0+$1F ($0C2
  // and $108 both rebuild in-window strips at 100+ frames' remove and the
  // words are the frozen ones, not f(strip) again). Window membership by
  // strip NUMBER alone is not the rule; chronology is.
  const byTime = [...writes.builds].sort((a, b) => a.frame - b.frame || a.strip - b.strip)
  const s0 = byTime[0]!.strip
  const loadLoopEnd = s0 + 0x1f
  const loadPass = new Set<PipeWrites['builds'][number]>()
  let expectedStrip = s0
  for (const b of byTime) {
    if (b.strip !== expectedStrip) break
    loadPass.add(b)
    expectedStrip++
    if (expectedStrip > loadLoopEnd) break
  }
  if (loadPass.size < 32) {
    // Every rule above assumes the load's first 32 chronological builds are
    // exactly s0..s0+$1F; a capture that never completes that run cannot be
    // judged by them at all, so this is reported directly rather than left
    // to surface as confusing per-strip mismatches downstream.
    mismatches.push({ table: 'pipes', cell: 'load-pass', expected: `a contiguous run of $20 strips from s0=${s0}`, actual: `${loadPass.size} of 32` }) // prettier-ignore
  }
  const s0Build = byTime[0]
  const altVariant = wordsFor(loadLoopEnd) // f(s0+$1F): the horizontal pick's exempt candidate

  const allowedCounts = new Map<string, number>()
  const bump = (rule: string) => allowedCounts.set(rule, (allowedCounts.get(rule) ?? 0) + 1)

  for (const b of writes.builds) {
    const naive = wordsFor(b.strip) // "as today": f(strip), the load-loop/horizontal-scroll rule
    if (!naive) {
      mismatches.push({ table: 'pipes', cell: `strip ${b.strip}`, expected: b.words.map(w => hex(w)).join(','), actual: 'unavailable: no MAP16AppTable' }) // prettier-ignore
      continue
    }
    let expected = naive
    let allowedRule: string | undefined
    if (b === s0Build && isVertical) {
      // V_S0_DEFAULT: the pick never runs (bank_05.asm:889-891 branches
      // away first), so s0 keeps CODE_0581FB's own compiled default - the
      // ORIENTATION split runs first, before any f(s0) check, so f(s0) is
      // never accepted on its own merit here: the only acceptable value is
      // the compiled default, whether or not it happens to equal f(s0) too
      // (round 5e - checking f(s0) first let a vertical s0 pass even when
      // its compiled default genuinely differed).
      if (compiledDefault) {
        expected = compiledDefault
        if (!sameWords(compiledDefault, naive) && sameWords(b.words, compiledDefault)) {
          allowedRule = ALLOWED_PIPE_BUG_V_S0_DEFAULT
        }
      }
    } else if (b === s0Build && !isVertical) {
      // H_S0 (bank_05.asm:907-909): f(s0) itself is "as today", no
      // exemption needed; only f(s0+$1F) is exempt; anything else is a
      // stale index outside {0, 2} and stays a mismatch.
      if (sameWords(b.words, naive)) {
        // matches f(s0) directly - ordinary, no exemption
      } else if (altVariant && sameWords(b.words, altVariant)) {
        expected = altVariant
        allowedRule = ALLOWED_PIPE_BUG_H_S0
      }
    } else if (isVertical && !loadPass.has(b)) {
      // CODE_0587CB writes no set for any build once the load pass is over,
      // regardless of the strip it targets: every such build keeps whatever
      // was resident at the load loop's end, f(s0+$20).
      const fixed = wordsFor(s0 + 0x20)
      if (fixed) {
        expected = fixed
        if (!sameWords(fixed, naive)) allowedRule = ALLOWED_PIPE_BUG_VERTICAL
      }
    }
    if (sameWords(b.words, expected)) {
      if (allowedRule) bump(allowedRule)
      continue
    }
    for (let i = 0; i < b.words.length; i++) {
      if (b.words[i] !== expected[i]) {
        const id = writes.lo + Math.floor(i / 4)
        const q = i % 4
        mismatches.push({ table: 'pipes', cell: `strip ${b.strip} ${hex(id)} q${q}`, expected: hex(b.words[i]!), actual: hex(expected[i]!) }) // prettier-ignore
      }
    }
  }
  const allowed = [...allowedCounts].map(([rule, count]) => ({ rule, count }))
  return { mismatches, allowed }
}

// ── Tables 4 and 5's shared citation pass ───────────────────────────────────

/** The Map16 ids and their strip actually placed in the grid: a column for a horizontal level, a row for a vertical one. */
export function usedByStrip(romGrid: number[][], isVertical: boolean): Map<number, Set<number>> {
  const used = new Map<number, Set<number>>()
  for (let r = 0; r < romGrid.length; r++) {
    for (let c = 0; c < romGrid[r]!.length; c++) {
      const id = romGrid[r]![c]!
      const strip = isVertical ? r : c
      if (!used.has(id)) used.set(id, new Set())
      used.get(id)!.add(strip)
    }
  }
  return used
}

// Tables 4-5 cite chars/colors through the SAME per-strip pipe variant Table
// 3 checks; reading the compiled default instead would cite a screen's
// chars/palette as if every strip showed the resident (often wrong) variant.
function tileWordsAt(
  tiles: Map16Tile[],
  pipeVariants: Map16Tile[][],
  id: number,
  strip: number,
): number[] | null {
  // No MAP16AppTable at all (pipeVariants empty): `$133..$13A` is an ordinary
  // tile, same as checkDefs's own skipPipeRange=false path.
  if (id < PIPE_LO || id > PIPE_HI || pipeVariants.length === 0) {
    return tiles[id] ? quadWords(tiles[id]!) : null
  }
  const t = pipeVariants[pipeVariantIndex(strip)]?.[id - PIPE_LO]
  return t ? quadWords(t) : null
}

/** Every L1 char and CGRAM palette row (word bits 10-12) the grid actually cites. */
export function citedWords(
  romGrid: number[][],
  isVertical: boolean,
  tiles: Map16Tile[],
  pipeVariants: Map16Tile[][],
): { chars: Set<number>; rows: Set<number>; citesPipeRange: boolean } {
  const chars = new Set<number>()
  const rows = new Set<number>()
  let citesPipeRange = false
  for (const [id, strips] of usedByStrip(romGrid, isVertical)) {
    if (id >= PIPE_LO && id <= PIPE_HI) citesPipeRange = true
    for (const strip of strips) {
      const words = tileWordsAt(tiles, pipeVariants, id, strip)
      if (!words) continue
      for (const w of words) {
        const f = decodeSubTileWord(w)
        chars.add(f.charNum)
        rows.add(f.palette)
      }
    }
  }
  return { chars, rows, citesPipeRange }
}

// ── Table 4: L1 chars ───────────────────────────────────────────────────────

// Only cited chars are checked, not the whole VRAM sheet: the ROM loads one
// tileset's full graphics regardless of which chars this particular level
// draws, so an uncited char legitimately belongs to a different level.
export function checkChars(
  chars: ReadonlySet<number>,
  vram: VramState,
  anim: AnimationData | null,
  capVram: Uint8Array,
  bg12nba: number,
): GateMismatch[] {
  const out: GateMismatch[] = []
  const baseWord = (bg12nba & 15) << 12
  for (const ch of [...chars].sort((a, b) => a - b)) {
    const capPixels = new Uint8Array(64)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) capPixels[y * 8 + x] = D.charPixel(capVram, baseWord, 4, ch, x, y)
    const romPixels = getCharPixels(vram, ch)
    const romMatches = (p: Uint8Array | null | undefined) => !!p && p.length === 64 && p.every((v, i) => v === capPixels[i]) // prettier-ignore
    if (romMatches(romPixels)) continue
    const matched = (anim?.frames ?? []).some(slots =>
      slots.some(
        slot =>
          ch >= slot.charBase &&
          ch < slot.charBase + slot.tiles.length &&
          romMatches(slot.tiles[ch - slot.charBase]),
      ),
    )
    if (!matched) {
      out.push({
        table: 'chars',
        cell: hex(ch),
        expected: [...capPixels].join(','),
        actual: romPixels ? [...romPixels].join(',') : 'unavailable',
      })
    }
  }
  return out
}

// ── Table 5: L1 palette ──────────────────────────────────────────────────────

/** Table 5: the CGRAM rows the grid's cited Map16 words actually select (bits 10-12), not rows 0-7 wholesale. */
export function checkPalette(
  rows: ReadonlySet<number>,
  colors: readonly RgbaColor[],
  animByIdx: ReadonlyMap<number, RgbaColor[]>,
  capCgram: Uint8Array,
): GateMismatch[] {
  const out: GateMismatch[] = []
  const same = (a: readonly number[], b: readonly number[]) =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  for (const row of [...rows].sort((a, b) => a - b)) {
    for (let col = 0; col < 16; col++) {
      const idx = row * 16 + col
      const cap = D.bgr555(capCgram, idx)
      const rom = colors[idx]!.slice(0, 3)
      if (same(rom, cap)) continue
      if ((animByIdx.get(idx) ?? []).some(f => same(f, cap))) continue
      out.push({ table: 'palette', cell: hex(idx), expected: cap.join(','), actual: rom.join(',') })
    }
  }
  return out
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Why a map with refusals is unavailable, or undefined when nothing was refused. */
export function refusalsReason(refusals: readonly Refusal[]): string | undefined {
  if (refusals.length === 0) return undefined
  const objects = new Set(refusals.map(r => r.objectIndex)).size
  return `the expander refused ${objects} object(s): ${refusals.map(r => `#${r.objectIndex} ${r.reason}`).join(' ')}`
}

const MAX_REPORTED = 25

/** Every table for one map: `read` from `openMap`; the gate needs only the load sample, so `windows` is always []. */
export function gateMap(
  rom: SmwRom,
  paletteAnim: ReadonlyMap<number, RgbaColor[]>,
  id: number,
  read: Reader,
  maxReported = MAX_REPORTED,
): GateResult {
  const raw = rom.getLevelRawData(id)
  if (!raw) return unavailable(id, `no L1 data for ${idToHex(id)}`)
  const level = loadLevel(read, idToHex(id), [])
  if (!level.data) return unavailable(id, level.detail)
  const draw = level.data.draw
  const bg12nba = D.parseNum(draw.regs.BG12NBA_210B)
  if (Number.isNaN(bg12nba)) return unavailable(id, 'ppu.json has no BG12NBA_210B')
  // Read and parse the pipe-write sidecar before any ROM-side work: it needs
  // only `read`, so a bad or missing one refuses without touching the ROM.
  const writesRaw = read('map16_pipe_writes.json')
  if (!writesRaw) return unavailable(id, 'map16_pipe_writes.json missing')
  const summaryRaw = read('capture_summary.json')
  const writes = parsePipeWrites(JSON.parse(writesRaw.toString('utf8')), summaryRaw && JSON.parse(summaryRaw.toString('utf8'))) // prettier-ignore
  if (!writes) return unavailable(id, 'map16_pipe_writes.json unreadable')

  // The same inputs the map tab draws from (src/rom/model/L1Model.ts), with
  // the switch palaces uncleared: the fresh-save state `layers_v5` was taken in.
  const built = buildL1Inputs(rom, id, SWITCH_FLAGS_UNCLEARED)
  if (!built.ok) return unavailable(id, built.reason)
  // An object the expander refused is missing from the grid, so every verdict
  // below would grade a grid the ROM never drew (#301).
  const refused = refusalsReason(built.inputs.refusals)
  if (refused) return unavailable(id, refused)
  const { header, isVertical, map16, anim, colors } = built.inputs
  const romGrid = built.inputs.grid
  const vram = built.inputs.rawVram

  const grid = D.unb64(draw.grid)
  const defs = D.unb64(draw.defs)
  const capVram = D.unb64(draw.vram)
  const cgram = D.unb64(level.data.cgram)

  const cited = citedWords(romGrid, isVertical, map16.tiles, map16.pipeVariants)

  const grade = checkGrid(romGrid, grid, draw.meta, levelExtent(header.levelLength, header.levelMode), isVertical) // prettier-ignore
  const pipes = checkPipes(map16.pipeVariants, writes, cited.citesPipeRange, isVertical, map16.tiles) // prettier-ignore
  const perTable: Record<Table, GateMismatch[]> = {
    grid: grade.mismatches,
    defs: checkDefs(
      map16.tiles,
      map16.pipeVariants,
      defs,
      draw.order,
      map16.pipeVariants.length > 0,
    ),
    pipes: pipes.mismatches,
    chars: checkChars(cited.chars, vram, anim, capVram, bg12nba),
    palette: checkPalette(cited.rows, colors, paletteAnim, cgram),
  }

  const totals = { ...ZERO_TOTALS }
  const mismatches: GateMismatch[] = []
  for (const table of TABLES) {
    const all = perTable[table]
    totals[table] = all.length
    mismatches.push(...all.slice(0, maxReported))
  }
  return { id, ok: deriveOk(undefined, mismatches), mismatches, totals, overflow: grade.overflow, allowed: pipes.allowed } // prettier-ignore
}

/**
 * Every listed map, in order. Checks the capture is present BEFORE opening
 * the ROM, so a run over a missing capture directory needs no ROM at all.
 * The ROM loads once, in its own try: an unreadable ROM fails every listed
 * map with the same reason. `openMap` runs inside the per-map try, so one
 * corrupt zip fails only that map.
 */
export function runGate(
  romPath: string,
  captureDir: string,
  ids: readonly number[],
  loadRom: (path: string) => SmwRom = SmwRom.open,
  maxReported = MAX_REPORTED,
): GateResult[] {
  const capturePath = (id: number) => {
    const path = `${captureDir}/${idToCaptureName(id)}`
    const zip = `${path}.zip`
    return { path, zip, exists: existsSync(path) || existsSync(zip) }
  }
  if (!ids.some(id => capturePath(id).exists)) {
    return ids.map(id => unavailable(id, `no capture found under ${captureDir}`))
  }
  let rom: SmwRom
  let paletteAnim: Map<number, RgbaColor[]>
  try {
    rom = loadRom(romPath)
    paletteAnim = collectPaletteAnimFrames(rom.rom)
  } catch (e) {
    const reason = (e as Error).message
    return ids.map(id => unavailable(id, reason))
  }
  return ids.map(id => {
    const { path, zip, exists } = capturePath(id)
    if (!exists) return unavailable(id, `no capture found at ${path} or ${zip}`)
    try {
      const src = openMap(existsSync(path) ? path : zip, idToCaptureName(id))
      return gateMap(rom, paletteAnim, id, src.read, maxReported)
    } catch (e) {
      return unavailable(id, (e as Error).message)
    }
  })
}

export { FG_GATE_MAPS, idToCaptureName, idToHex }
