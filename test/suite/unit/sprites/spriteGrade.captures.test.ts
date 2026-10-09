/**
 * Accuracy loop against Mesen's level-load captures (`layers_v5`
 * `sprite_spawns.json`, vanilla). Gated on the captures AND the vanilla ROM.
 *
 * Tier 1 (graded here): the sprite's OAM shape relative to its own position.
 * Tier 2 (not graded): absolute position and which frame Mesen caught, since
 * the captures record the first on-screen draw of a sprite that was free to
 * move and Mario was somewhere else. Set SPRITE_GRADE_OUT to a file path to
 * dump every graded record as JSON for classification.
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
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import {
  CAPTURE_DIR,
  freshRom,
  hasCaptures,
  hasRom,
  SPRITE_TRACE_SET,
  TOOLS_ROOT,
  VANILLA,
} from '../../support/corpus'
import { oracleCells, oracleImage } from '../../support/oracleImage'
import {
  grade,
  passPieces,
  plantTileStoreDefect,
  type Grade,
  type RecordedPiece,
} from '../../support/spriteGrade'

interface Rec {
  id: string
  slot: number
  listX: number
  listY: number
  cameraX: number
  cameraY: number
  marioAtInit?: { x: number; y: number }
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

function loadAll(): { map: string; rec: Rec; wram: Uint8Array | null }[] {
  const out: { map: string; rec: Rec; wram: Uint8Array | null }[] = []
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
    for (const rec of j.spawns ?? []) out.push({ map: name, rec, wram })
  }
  return out
}

type Row = Grade & { map: string; id: string; slot: number; [k: string]: unknown }
type Mode = 'rom' | 'generic' | 'oracle'

/** Grades `all` (or its first `limit` gradable records) against `rom`. */
function gradeAll(
  rom: RomFile,
  all: ReturnType<typeof loadAll>,
  opts: { mode?: Mode; limit?: number; passes?: number; trackInputs?: boolean } = {},
): {
  rows: Row[]
  by: Record<string, number>
  inputs: Map<number, { reads: number; nonzero: number }>
} {
  const mode = opts.mode ?? 'rom'
  const rows: Row[] = []
  const inputs = new Map<number, { reads: number; nonzero: number }>()
  const loadedByMap = new Map<string, Uint8Array | undefined>()
  for (const { map, rec, wram } of all) {
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
    const seed = withSeed({
      loaded,
      slot: rec.slot,
      mainPasses: opts.passes ?? 64,
      sprite: { x: rec.listX, y: rec.listY },
      camera: { x: rec.cameraX, y: rec.cameraY },
      mario: rec.marioAtInit ?? { x: rec.listX, y: rec.listY },
    })
    const m = runSprite(rom, id, seed, { trackInputs: opts.trackInputs })
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
  return { rows, by, inputs }
}

/** Floors for the 'rom' seed, 64 passes, chosen-frame policy; measured counts are in the docs. */
const FLOOR = { graded: 1957, exact: 910, exactOrShape: 1480, maxRefused: 0, maxEmpty: 20 }

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))('sprite grading vs level-load captures', () => {
  const all = hasCaptures() && hasRom(VANILLA) ? loadAll() : []

  it('grades every recorded sprite, and holds the floors', () => {
    const rom = freshRom()
    expect(all.length).toBeGreaterThan(0)
    const mode = (process.env.SPRITE_GRADE_SEED ?? 'rom') as Mode
    const { rows, by, inputs } = gradeAll(rom, all, {
      mode,
      passes: Number(process.env.SPRITE_GRADE_PASSES ?? 64),
      trackInputs: !!process.env.SPRITE_GRADE_INPUTS,
    })
    if (process.env.SPRITE_GRADE_INPUTS)
      writeFileSync(
        process.env.SPRITE_GRADE_INPUTS,
        JSON.stringify([...inputs].sort((a, b) => b[1].nonzero - a[1].nonzero)),
      )
    const summary = `graded ${rows.length}: ${JSON.stringify(by)}`
    if (process.env.SPRITE_GRADE_OUT)
      writeFileSync(process.env.SPRITE_GRADE_OUT, JSON.stringify({ summary, rows }, null, 1))
    console.log(summary)
    if (mode !== 'rom') return
    // Floors: measured 2026-10-05 (docs section 12) minus a tolerance. The mutants they
    // were set against (X not set to the slot, level sprites not zeroed, INIT retry
    // removed) all fall below them.
    expect(rows.length).toBe(FLOOR.graded)
    expect(by.exact ?? 0).toBeGreaterThanOrEqual(FLOOR.exact)
    expect((by.exact ?? 0) + (by.shape ?? 0)).toBeGreaterThanOrEqual(FLOOR.exactOrShape)
    expect(by.refused ?? 0).toBeLessThanOrEqual(FLOOR.maxRefused)
    expect(by.empty ?? 0).toBeLessThanOrEqual(FLOOR.maxEmpty)
  }, 300_000)

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
