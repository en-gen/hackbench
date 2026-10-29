/**
 * Accuracy loop against Mesen's level-load captures (`layers_v5`
 * `sprite_spawns.json`, vanilla). Gated on the captures AND the vanilla ROM.
 *
 * Tier 1 (graded here): the sprite's OAM shape relative to its own position.
 * Tier 2 (not graded): absolute position. The frame Mesen caught IS graded now: pass
 * k = drawnFrame - max(anchorFrame, initFrame + 1), with Mario at marioAtInit for INIT
 * and marioStart for MAIN and the frame counters seeded from the record (#844). Offsets
 * are measured from the sprite's position at its first OAM write (PassResult.drawPos, the moment the
 * capture samples it, #842); the end-of-pass position skewed every sprite that moves after drawing.
 * Set SPRITE_GRADE_OUT to a file path to dump every graded record as JSON for classification.
 *
 * The headline run asserts FLOORS (the measured count minus a tolerance) and a
 * planted-defect run asserts the same grader goes red, so a regression in the
 * runner moves a failing number, not just a log line.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { unzip } from '../../../../tools/scripts/capture_render'
import type { RomFile } from '../../../../src/rom/RomFile'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState, NO_CLUSTER_SPRITES } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { neighboursOf } from '../../../../src/rom/sprites/interp/Neighbours'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { levelSpriteList } from '../../support/levelSpriteList'
import { SmwRom } from '../../../../src/rom/SmwRom'
import {
  CAPTURE_DIR,
  freshRom,
  hasCaptures,
  hasRom,
  SPRITE_TRACE_SET,
  TOOLS_ROOT,
  VANILLA,
} from '../../support/corpus'
import {
  gradedPass,
  type PlacedSprite,
  runnerId,
  writeMarioStart,
} from '../../support/gradeTimeline'
import { oracleCells, oracleImage } from '../../support/oracleImage'
import {
  grade,
  passPieces,
  plantTileStoreDefect,
  type Grade,
  type RecordedPiece,
} from '../../support/spriteGrade'

interface Rec {
  listIndex?: number
  id: string
  slot: number
  listX: number
  listY: number
  cameraX: number
  cameraY: number
  marioAtInit?: { x: number; y: number }
  initFrame?: number
  drawnFrame?: number
  trueFrame?: number
  effFrame?: number
  frames?: { frameIndex?: number; tiles?: RecordedPiece[] }[]
  firstFrameIndex?: number
  complete?: boolean
}

/** Every frame Mesen recorded for the sprite that has tiles. */
function recordedFrames(r: Rec): RecordedPiece[][] {
  return (r.frames ?? []).flatMap(f => (f.tiles?.length ? [f.tiles] : []))
}

/**
 * Map16 tables from the sprite-trace fixtures (same maps, same ROM), when present. `strict` (oracle
 * mode) throws on a missing table: grading on zero-filled Map16 would report an oracle result
 * that lacks the capture's data.
 */
function traceMap16(
  map: string,
  strict = false,
  root = join(TOOLS_ROOT, 'fixtures', 'sprite-trace', SPRITE_TRACE_SET),
): { low: Uint8Array; high: Uint8Array } | undefined {
  const lo = join(root, map, 'map16_7ec800.bin')
  const hi = join(root, map, 'map16_7fc800.bin')
  if (existsSync(lo) && existsSync(hi)) return { low: readFileSync(lo), high: readFileSync(hi) }
  if (strict) throw new Error(`map ${map}: Map16 table missing under ${root}`)
  return undefined
}

interface Loaded {
  map: string
  rec: Rec
  wram: Uint8Array | null
  /** capture_summary.json anchorFrame: when the sprites' MAIN starts running on hardware. */
  anchorFrame?: number
  /** scroll_pass.json marioStart: where Mario is held from the anchor on. */
  marioStart?: { x: number; y: number }
  /** sprites.json entries: the placed list ids by index. */
  listed?: PlacedSprite[]
}

function loadAll(): Loaded[] {
  const out: Loaded[] = []
  for (const f of readdirSync(CAPTURE_DIR).sort()) {
    const p = join(CAPTURE_DIR, f)
    if (!f.endsWith('.zip')) continue
    const name = f.slice(0, -4)
    const entries = unzip(readFileSync(p))
    const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
    if (!key) continue
    const j = JSON.parse(entries.get(key)!().toString('utf8'))
    const wk = [...entries.keys()].find(k => k.endsWith('frame_0000_wram.bin'))
    const wram = wk ? new Uint8Array(entries.get(wk)!()) : null
    const jsonOf = (suffix: string): Record<string, unknown> => {
      const k = [...entries.keys()].find(e => e.endsWith(suffix))
      return k ? JSON.parse(entries.get(k)!().toString('utf8')) : {}
    }
    const anchorFrame = jsonOf('capture_summary.json').anchorFrame as number | undefined
    const marioStart = jsonOf('scroll_pass.json').marioStart as Loaded['marioStart']
    const listed = jsonOf('sprites.json').entries as Loaded['listed']
    for (const rec of j.spawns ?? [])
      out.push({ map: name, rec, wram, anchorFrame, marioStart, listed })
  }
  return out
}

type Row = Grade & { map: string; id: string; slot: number; [k: string]: unknown }
type Mode = 'rom' | 'generic' | 'oracle'

/** Grades `all` (or its first `limit` gradable records) against `rom`. */
function gradeAll(
  rom: RomFile,
  all: Loaded[],
  opts: { mode?: Mode; limit?: number; passes?: number; trackInputs?: boolean } = {},
): {
  rows: Row[]
  by: Record<string, number>
  inputs: Map<number, { reads: number; nonzero: number }>
  /** Records graded the old way (first drawing pass, Mario at marioAtInit throughout): a timeline field was missing or k out of range. */
  fallbacks: number
  /** Timed records whose graded pass drew nothing (graded wrong). */
  missAtK: number
} {
  const mode = opts.mode ?? 'rom'
  const rows: Row[] = []
  const inputs = new Map<number, { reads: number; nonzero: number }>()
  const loadedByMap = new Map<string, Uint8Array | undefined>()
  // Each map's own sprite list, for the neighbor run of a sprite that scans the slot tables (#841).
  const listByMap = new Map<string, LevelSprite[]>()
  const smw = new SmwRom(rom)
  let fallbacks = 0
  let missAtK = 0
  for (const { map, rec, wram, anchorFrame, marioStart, listed } of all) {
    if (opts.limit !== undefined && rows.length >= opts.limit) break
    const id = parseInt(rec.id.slice(1), 16)
    const want = recordedFrames(rec)
    if (!want.length || id > 0xc8) continue
    // 'rom' runs the ROM's own level loader; 'generic' seeds placement only;
    // 'oracle' builds an image from the capture (an upper bound, never a runtime input).
    let loaded: Uint8Array | undefined
    if (mode === 'rom') {
      if (!loadedByMap.has(map)) {
        const l = loadLevelState(rom, parseInt(map, 16))
        loadedByMap.set(map, l.ok ? l.wram : undefined)
      }
      loaded = loadedByMap.get(map)
    } else if (mode === 'oracle' && wram) {
      loaded = oracleImage({ cells: oracleCells(wram), map16: traceMap16(map, true) })
    }
    // Hardware timeline: INIT sees marioAtInit, MAIN sees marioStart, and the graded pass is the
    // one the capture's drawn frame falls on. Without the fields, the old first-drawing-pass rule.
    if (!listByMap.has(map)) {
      const lv = parseInt(map, 16)
      const ptr = smw.getLevelSpritePointer(lv)
      const data = ptr === null ? null : rom.readUpTo(ptr, 4096)
      const raw = smw.getLevelRawData(lv)
      // A vertical map's stream swaps X and Y (#1018); the helper decides it as MapBuilder does.
      // A capture map without level data is a broken corpus, not an empty list: fail by name.
      if (!data || !raw) throw new Error(`map ${map}: no sprite or level data for the sprite list`)
      listByMap.set(map, levelSpriteList(data, raw, smw.requireVerticalTable()))
    }
    const list = listByMap.get(map)!
    const me = list.find(e => e.index === rec.listIndex)
    const neighbours = me ? neighboursOf(list, me, e => ({ x: e.x * 16, y: e.y * 16 })) : []
    const k = gradedPass(rec.initFrame, anchorFrame, rec.drawnFrame)
    const timed = k !== undefined && marioStart !== undefined
    if (!timed) fallbacks++
    const seed = withSeed({
      loaded,
      // The ROM-run level's cluster sprites (map $101's castle flames) would draw into the OAM read as the
      // tested sprite's; levelSeed clears them (#809), so the grader does too. The oracle image keeps the capture's.
      ...(mode === 'rom' ? { ram: NO_CLUSTER_SPRITES } : {}),
      slot: rec.slot,
      mainPasses: Math.max(opts.passes ?? 64, timed ? k + 1 : 0),
      // Pass p runs at seed + 1 + p only when INIT takes one frame, so pass k lands on the frame
      // counters the capture recorded at the draw. SpriteRunner adds a frame per INIT retry
      // (initFrames > 1), and those see the counters 1 or 2 high. Re-measured 2026-10-16
      // after #842 (vanilla, 1957 records, one machine): no timed record retries INIT; before the
      // loader ran the Layer 3 handler 22 did (map 102 $5D x13, $A4 x9). Without the fields every pass starts the animation at zero.
      ...(timed && rec.trueFrame !== undefined && rec.effFrame !== undefined
        ? {
            trueFrame: (rec.trueFrame - 1 - k) & 0xff,
            effFrame: (rec.effFrame - 1 - k) & 0xff,
          }
        : {}),
      sprite: { x: rec.listX, y: rec.listY },
      camera: { x: rec.cameraX, y: rec.cameraY },
      mario: rec.marioAtInit ?? { x: rec.listX, y: rec.listY },
      ...(neighbours.length ? { neighbours } : {}),
    })
    const probe = timed
      ? (p: number, w: Uint8Array): void => {
          if (p === -1) writeMarioStart(w, marioStart) // after INIT, before the first MAIN pass
        }
      : undefined
    const m = runSprite(rom, runnerId(rom, id, rec.listIndex, listed), seed, {
      trackInputs: opts.trackInputs,
      probe,
    })
    // Nothing drawn at the hardware's pass is a runner miss, counted apart so it cannot hide in the
    // wrong total. It grades wrong when some pass draws; when none does grade()
    // returns empty whatever m.chosen is (13 records before #842, none after) (test/suite/support/spriteGrade.ts:107).
    if (timed && m.passes[k]) {
      if (m.passes[k].parts.length) m.chosen = k
      else {
        m.chosen = k
        missAtK++
      }
    }
    for (const a of m.inputs ?? []) {
      const e = inputs.get(a) ?? { reads: 0, nonzero: 0 }
      e.reads++
      // A seed gap: read before written, and the capture holds a value the seed lacks.
      if (wram && a < 0x2000 && wram[a] !== (loaded?.[a] ?? 0)) e.nonzero++
      inputs.set(a, e)
    }
    const g = grade(m, want)
    const dbg = g.verdict === 'wrong' || g.verdict === 'close' || g.verdict === 'shape'
    rows.push({
      ...g,
      map,
      id: rec.id,
      slot: rec.slot,
      ...(dbg
        ? {
            want,
            got: [0, 1, 15].map(i => m.passes[i] && passPieces(m, i)),
            best: g.pass === undefined ? undefined : passPieces(m, g.pass),
            anchor: m.anchor,
            pos: m.passes[0]?.pos,
            seed: rec,
          }
        : {}),
    })
  }
  const by: Record<string, number> = {}
  for (const r of rows) by[r.verdict] = (by[r.verdict] ?? 0) + 1
  return { rows, by, inputs, fallbacks, missAtK }
}

/** Floors for the 'rom' seed on the hardware timeline (graded pass k, marioStart); measured counts are in the docs. Raised for #841 (neighbor run): measured with the merge head against develop 6d23b7b0, one machine: exact 1058, exact+shape 1877, wrong 48, close 18, empty 14 (develop: 1053, 1863, 62, 18, 14); only the 14 $9C rows changed. */
const FLOOR = {
  graded: 1957,
  // Measured on the merge of develop a9de2145 and #842 (offsets from the draw-time position, Layer 3 handler run),
  // one machine, 2026-10-28: exact 1906, shape 0, close 17, wrong 33, empty 1 (the #842 head alone, before
  // the merge: 1865, 0, 17, 75, 0). Shape is not floored: with shape at 0, exact + shape could never fire below the
  // exact floor.
  exact: 1890,
  maxRefused: 0,
  maxShape: 5, // 0 measured
  maxClose: 20, // 17 measured
  maxEmpty: 5, // 1 measured
  maxWrong: 45, // 33 measured
  maxMissAtK: 10, // 7 measured
  // 38 measured (spawned records without initFrame); all-timed would read 0.
  minFallbacks: 30,
  // 7 measured on the merge (3 on the #842 head alone, 25 before it: the 22 initFrames > 1 records missed until the
  // loader ran the Layer 3 handler); a runner that stops counting misses (or stops grading at k) drops below.
  minMissAtK: 3,
}

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))('sprite grading vs level-load captures', () => {
  const all = hasCaptures() && hasRom(VANILLA) ? loadAll() : []

  it('grades every recorded sprite, and holds the floors', () => {
    const rom = freshRom()
    expect(all.length).toBeGreaterThan(0)
    const mode = (process.env.SPRITE_GRADE_SEED ?? 'rom') as Mode
    const { rows, by, inputs, fallbacks, missAtK } = gradeAll(rom, all, {
      mode,
      passes: Number(process.env.SPRITE_GRADE_PASSES ?? 64),
      trackInputs: !!process.env.SPRITE_GRADE_INPUTS,
    })
    if (process.env.SPRITE_GRADE_INPUTS)
      writeFileSync(
        process.env.SPRITE_GRADE_INPUTS,
        JSON.stringify([...inputs].sort((a, b) => b[1].nonzero - a[1].nonzero)),
      )
    const summary = `graded ${rows.length}: ${JSON.stringify(by)}, fallback ${fallbacks}, missAtK ${missAtK}`
    if (process.env.SPRITE_GRADE_OUT)
      writeFileSync(process.env.SPRITE_GRADE_OUT, JSON.stringify({ summary, rows }, null, 1))
    console.log(summary)
    if (mode !== 'rom') return
    // Floors: measured 2026-10-17 on the #842 head merged with #837 (vanilla, one machine, 1957 records: exact 1865,
    // shape 0, close 17, wrong 75, empty 0, missAtK 3; 1830/0/17/110/0/3 before the merge) minus a tolerance. The #838-era mutant runs
    // (effOnly: exact 984 against a 985 floor; initOnly: 988, survived, so this corpus does not tell
    // anchor-based k from init-based k, which gradeTimeline.test.ts pins itself) were against the old
    // counts and are not re-measured against these floors.
    expect(rows.length).toBe(FLOOR.graded)
    expect(by.exact ?? 0).toBeGreaterThanOrEqual(FLOOR.exact)
    expect(by.refused ?? 0).toBeLessThanOrEqual(FLOOR.maxRefused)
    expect(by.shape ?? 0).toBeLessThanOrEqual(FLOOR.maxShape)
    expect(by.close ?? 0).toBeLessThanOrEqual(FLOOR.maxClose)
    expect(by.empty ?? 0).toBeLessThanOrEqual(FLOOR.maxEmpty)
    expect(by.wrong ?? 0).toBeLessThanOrEqual(FLOOR.maxWrong)
    // 38 records carry no initFrame (the spawned ones) and grade the old way.
    expect(fallbacks).toBeGreaterThanOrEqual(FLOOR.minFallbacks)
    expect(fallbacks).toBeLessThanOrEqual(40)
    expect(missAtK).toBeLessThanOrEqual(FLOOR.maxMissAtK)
    expect(missAtK).toBeGreaterThanOrEqual(FLOOR.minMissAtK)
  }, 300_000)

  // Mario at the hardware's position decides the Boo shy face (bank_01.asm:16250-16284), and the
  // pose of $30 is only reached at pass 64 (k = 64, measured from the capture record); each failed before the timeline.
  it.each([
    ['1db', '$37', 864, 336],
    ['1db', '$37', 944, 304],
    ['11d', '$28', 272, 224],
    ['01a', '$30', 272, 368],
    // The tide maps (#845): fish enter the liquid path once $5B bit 7 is set (hardware WRAM has it).
    ['127', '$16', 400, 368],
    ['127', '$16', 1296, 368],
    ['1cc', '$93', 224, 368], // #846: moves after drawing; graded from where it drew
    ['102', '$A4', 912, 400], // #842: sank 32 px until the loader ran the Layer 3 handler
  ])(
    'map %s %s at %i,%i grades exact',
    (map, id, x, y) => {
      const one = all.filter(
        a => a.map === map && a.rec.id === id && a.rec.listX === x && a.rec.listY === y,
      )
      expect(one).toHaveLength(1)
      const { rows, fallbacks } = gradeAll(freshRom(), one)
      expect(fallbacks).toBe(0)
      expect(rows.map(r => r.verdict)).toEqual(['exact'])
    },
    120_000,
  )

  // #1035: a stationary shell is placed as list id $DA-$DD but recorded as $04-$07 (the loader rebases it,
  // bank_02.asm:5456-5462). Graded under the record id it is a walking Koopa and grades wrong; under the
  // list id (runnerId) it is exact. Measured 2026-10-17, one machine, vanilla captures: 35 such records,
  // 8 on map 12d, all wrong under the record id and all exact under the list id. Entry 10 on 12d has later
  // kicked frames, but its drawn frame is the still shell and the grader accepts any recorded frame.
  // Other list ids that differ from the record ($E0 -> $A3, $DE -> $39, 14 records) are not shells and keep
  // the record id: the runner has no loader rule for them, so the list id would only refuse.
  it('every record whose list id differs through the shell rule grades exact (35, 8 on map 12d)', () => {
    const rom = freshRom()
    const shells = all.filter(a => {
      const id = parseInt(a.rec.id.slice(1), 16)
      return runnerId(rom, id, a.rec.listIndex, a.listed) !== id
    })
    expect(shells).toHaveLength(35)
    expect(shells.filter(a => a.map === '12d').map(a => a.rec.listIndex)).toEqual([0, 4, 8, 10, 13, 17, 22, 29]) // prettier-ignore
    const { rows } = gradeAll(rom, shells)
    expect(rows.map(r => r.verdict)).toEqual(shells.map(() => 'exact'))
  }, 120_000)

  // A miss at k: the model draws nothing on the hardware's pass, which grades wrong. Without
  // `m.chosen = k` the grader falls back to the first drawing pass and the detail changes.
  it('map 0c3 $49 at 208,352 misses at k and grades wrong, not empty', () => {
    const one = all.filter(
      a => a.map === '0c3' && a.rec.id === '$49' && a.rec.listX === 208 && a.rec.listY === 352,
    )
    expect(one).toHaveLength(1)
    const { rows, missAtK } = gradeAll(freshRom(), one)
    expect(missAtK).toBe(1)
    expect(rows[0].verdict).toBe('wrong')
    expect(rows[0].detail).toMatch(/model drew 0/)
  }, 120_000)

  it('goes red when the dispatch is planted with a defect', () => {
    // The OAM tile stores of banks $01-$03 write the attribute byte instead: INIT and MAIN still
    // run (the dispatch shape check passes), and only the graded tiles are wrong.
    const sample = 150
    const base = gradeAll(freshRom(), all, { limit: sample, passes: 8 })
    const rom = freshRom()
    expect(plantTileStoreDefect(rom)).toBeGreaterThan(0)
    const planted = gradeAll(rom, all, { limit: sample, passes: 8 })
    expect(planted.by.refused ?? 0).toBeLessThanOrEqual(base.by.refused ?? 0) // not the dispatch refusal
    expect(base.by.exact ?? 0).toBeGreaterThan(sample / 4)
    expect(planted.by.exact ?? 0).toBeLessThan((base.by.exact ?? 0) / 4)
  }, 300_000)
})

describe('traceMap16 on a synthetic capture set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'))
  mkdirSync(join(dir, '0aa'))
  writeFileSync(join(dir, '0aa', 'map16_7ec800.bin'), Buffer.from([1, 2]))
  writeFileSync(join(dir, '0aa', 'map16_7fc800.bin'), Buffer.from([3, 4]))
  mkdirSync(join(dir, '0bb'))
  writeFileSync(join(dir, '0bb', 'map16_7ec800.bin'), Buffer.from([1]))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns both tables; a missing one is undefined normally and an error in strict (oracle) mode', () => {
    expect(traceMap16('0aa', true, dir)?.high).toEqual(Buffer.from([3, 4]))
    expect(traceMap16('0bb', false, dir)).toBeUndefined()
    expect(traceMap16('0cc', false, dir)).toBeUndefined()
    expect(() => traceMap16('0bb', true, dir)).toThrow(/map 0bb: Map16 table missing/)
    expect(() => traceMap16('0cc', true, dir)).toThrow(/map 0cc/)
  })
})
