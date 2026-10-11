/**
 * Tier 2 of the sprite grader (#830): on-map position against the Mesen
 * captures. Synthetic tests always run; the corpus block needs the captures and
 * the vanilla ROM. Planted defects (each turns a test red when applied):
 *   P1 delta ignores y                       -> the y 1 px test
 *   P2 delta ignores x                       -> the x 1 px test
 *   P3 toMap drops the camera                -> the camera tests
 *   P4 capturePieces drops sizeXHigh bit 0   -> the 9-bit X test
 *   P5 gradePosition says exact for any non-empty pair -> every off test
 *   P6 key ignores `large`; P7 set not multiset; P8 parked `<=` -> `<`, `>=224` -> `>224` or `>=240`;
 *      P9 delta max not min                  -> the matching synthetic tests
 *   P10 grading at `chosen`, at `chosen + lag`, or y + 1 -> the model tests, and
 *      the corpus planted-defect test
 * Graded captures never set X bit 8, so the 9-bit X test is synthetic-only
 * coverage. Both sides use the capture camera, so the camera tests exercise
 * toMap's addition, not a second camera.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../tools/scripts/capture_render'
import { runSprite, type SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, VANILLA } from '../support/corpus'
import {
  capturePieces,
  gradePosition,
  gradeRecord,
  modelPieces,
  toMap,
  type CaptureEntry,
  type RecordVerdict,
} from '../support/spritePosition'

const cam0 = { x: 0, y: 0 }
const e = (x: number, y: number, sizeXHigh = 0): CaptureEntry => ({ x, y, sizeXHigh })
const place = (es: CaptureEntry[], cam = cam0) => toMap(capturePieces(es), cam)
const sprite = [e(100, 50), e(108, 50), e(100, 58, 2)]
const want = place(sprite)

describe('sprite position grading (synthetic)', () => {
  it('passes a sprite at its captured position', () => {
    expect(gradePosition(place(sprite), want).verdict).toBe('exact')
  })

  it('fails a sprite 1 px off in x, and reports the delta', () => {
    const got = place([e(101, 50), e(109, 50), e(101, 58, 2)])
    expect(gradePosition(got, want)).toEqual({ verdict: 'off', delta: { x: 1, y: 0 } })
  })

  it('fails a sprite 1 px off in y, and reports the delta', () => {
    const got = place([e(100, 49), e(108, 49), e(100, 57, 2)])
    expect(gradePosition(got, want)).toEqual({ verdict: 'off', delta: { x: 0, y: -1 } })
  })

  it('fails when only one piece moves', () => {
    const got = place([e(100, 50), e(108, 51), e(100, 58, 2)])
    expect(gradePosition(got, want).verdict).toBe('off')
  })

  it('compares on the map: a camera shift compensated by screen x passes', () => {
    const got = place([e(60, 50), e(68, 50), e(60, 58, 2)], { x: 40, y: 0 })
    expect(gradePosition(got, want).verdict).toBe('exact')
  })

  it('does not pass the same screen position under a different camera', () => {
    expect(gradePosition(place(sprite, { x: 40, y: 0 }), want).verdict).toBe('off')
  })

  it('uses the 9-bit X: a piece at X >= 256 is not the one at X - 256', () => {
    const high = place([e(0, 50, 1)])
    expect(high[0].x).toBe(256)
    expect(gradePosition(high, place([e(0, 50, 0)])).verdict).toBe('off')
    expect(gradePosition(high, place([e(0, 50, 1)])).verdict).toBe('exact')
  })

  it('compares on the map in y too: a camera shift compensated by screen y passes', () => {
    const got = place([e(100, 30), e(108, 30), e(100, 38, 2)], { x: 0, y: 20 })
    expect(gradePosition(got, want).verdict).toBe('exact')
  })

  it('tells a small piece from a large one at the same spot', () => {
    expect(gradePosition(place([e(100, 50, 0)]), place([e(100, 50, 2)])).verdict).toBe('off')
  })

  it('compares multisets: two pieces at one spot are not one piece', () => {
    expect(gradePosition(place([e(100, 50), e(100, 50)]), place([e(100, 50)])).verdict).toBe('off')
  })

  it('drops a small piece at y=248 (fully below the screen) but keeps one at y=249', () => {
    const one = place([e(100, 50)])
    expect(gradePosition(place([e(100, 50), e(0, 248)]), one).verdict).toBe('exact')
    expect(gradePosition(place([e(100, 50), e(0, 249)]), one).verdict).toBe('off')
  })

  it('takes the delta from the smallest x and y, not the largest', () => {
    const got = place([e(100, 50), e(108, 60)])
    expect(gradePosition(got, place([e(100, 50), e(112, 70)]))).toEqual({
      verdict: 'off',
      delta: { x: 0, y: 0 },
    })
  })

  it('reports missing when either side drew nothing', () => {
    expect(gradePosition([], want).verdict).toBe('missing')
    expect(gradePosition(want, []).verdict).toBe('missing')
    expect(gradePosition(place([e(0, 240)]), want).verdict).toBe('missing')
  })
})

/** Just the fields modelPieces and gradeRecord read; ox and dx differ to catch a swap. */
const part = (ox: number, oy: number, size: 8 | 16) => ({ ox, dx: ox + 7, oy, dy: oy + 3, size })
const fake = (chosen: number | undefined, passes: ReturnType<typeof part>[][], refusal?: string) =>
  ({ chosen, refusal, passes: passes.map(parts => ({ parts })) }) as unknown as SpriteModel

describe('modelPieces and gradeRecord (synthetic model)', () => {
  // chosen 1 (first drawing pass), exact pass for lag 2 is pass 2, not chosen + 2 = 3
  const m = fake(1, [[], [part(10, 20, 8)], [part(100, 50, 8), part(108, 50, 16)], [part(1, 1, 8)]])

  it('reads pass `lag` itself (pass 0 is the first MAIN), raw ox and oy, large only for size 16', () => {
    expect(modelPieces(m, 2)).toEqual([
      { x: 100, y: 50, large: false },
      { x: 108, y: 50, large: true },
    ])
    expect(modelPieces(m, 1)).toEqual([{ x: 10, y: 20, large: false }])
    expect(modelPieces(m, 3)).toEqual([{ x: 1, y: 1, large: false }])
  })

  it('grades the drawn frame: lag counts from pass 0, so chosen is not added', () => {
    const entries = [e(100, 50), e(108, 50, 2)]
    expect(gradeRecord(m, 2, entries, cam0).verdict).toBe('exact')
    expect(gradeRecord(m, 1, entries, cam0).verdict).toBe('off')
    expect(gradeRecord(m, 3, entries, cam0).verdict).toBe('off')
    expect(gradeRecord(m, 2, [e(100, 51), e(108, 51, 2)], cam0).verdict).toBe('off')
  })

  it('a pass before the first draw has no pieces: missing, not lagged', () => {
    expect(gradeRecord(m, 0, [e(1, 1)], cam0).verdict).toBe('missing')
  })

  it('tells lagged, refused and missing apart', () => {
    const v = (x: SpriteModel, lag: number): RecordVerdict => gradeRecord(x, lag, [e(1, 1)], cam0).verdict // prettier-ignore
    expect(v(m, 4)).toBe('lagged')
    expect(v(fake(undefined, [[]]), 0)).toBe('missing')
    expect(v(fake(undefined, [], 'no loop'), 0)).toBe('refused')
  })
})

describe('parked rule boundary (matches spriteGrade.ts passPieces)', () => {
  const one = place([e(100, 50)])
  const withExtra = (y: number, size = 0) => place([e(100, 50), e(0, y, size)])

  it('keeps a small piece at y=223 (above the parked band)', () => {
    expect(gradePosition(withExtra(223), one).verdict).toBe('off')
  })

  it('drops a small piece at y=224, the first parked line', () => {
    expect(gradePosition(withExtra(224), one).verdict).toBe('exact')
  })

  it('drops small pieces anywhere in 224..248 (guards >=240)', () => {
    for (const y of [224, 232, 239, 240, 248])
      expect(gradePosition(withExtra(y), one).verdict, `y=${y}`).toBe('exact')
  })

  it('keeps a large piece at y=241 (it ends past 256), drops one at y=240', () => {
    expect(gradePosition(withExtra(241, 2), one).verdict).toBe('off')
    expect(gradePosition(withExtra(240, 2), one).verdict).toBe('exact')
    expect(gradePosition(withExtra(224, 2), one).verdict).toBe('exact')
  })
})

interface Rec {
  drawnFrame?: number
  firstRealFrame?: number
  id: string
  slot: number
  listX: number
  listY: number
  cameraX: number
  cameraY: number
  marioAtInit?: { x: number; y: number }
  entries?: CaptureEntry[]
  frames?: { tiles?: unknown[] }[]
}

/** Same records and order as spriteGrade.captures.test.ts (its loader is private). */
function loadAll(): { map: string; rec: Rec }[] {
  const out: { map: string; rec: Rec }[] = []
  for (const f of readdirSync(CAPTURE_DIR).sort()) {
    if (!f.endsWith('.zip')) continue
    const entries = unzip(readFileSync(join(CAPTURE_DIR, f)))
    const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
    if (!key) continue
    const j = JSON.parse(entries.get(key)!().toString('utf8'))
    for (const rec of j.spawns ?? []) out.push({ map: f.slice(0, -4), rec })
  }
  return out
}

/** Measured 2026-10-10, one machine, vanilla ROM: exact 1366, off 469, missing 42, lagged 80, refused 0 of 1957; each bound has 1% headroom (at least 1). Pairing at pass drawnFrame - firstRealFrame. */
const FLOOR = { graded: 1957, exact: 1352, maxOff: 474, maxLagged: 81, maxMissing: 43, maxRefused: 1 } // prettier-ignore
/** The ten ids with the most exact records: exact count measured, minus 1. */
const ID_FLOOR: Record<string, number> = {
  $C2: 82,
  $73: 50,
  $11: 48,
  $4F: 46,
  $33: 45,
  $6F: 43,
  $7B: 42,
  $3D: 38,
  $09: 36,
  $72: 34,
}

type Counts = Record<RecordVerdict, number>
const zero = (): Counts => ({ exact: 0, off: 0, missing: 0, lagged: 0, refused: 0 })

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'sprite position vs level-load captures',
  () => {
    /** dy plants a defect: the capture side is moved down by that many lines. */
    function gradeAll(limit = Infinity, dy = 0) {
      const rom = freshRom()
      const loaded = new Map<string, Uint8Array | undefined>()
      const by = zero()
      const perId = new Map<string, Counts>()
      const tally = new Map<string, number>()
      const rows: object[] = []
      for (const { map, rec } of loadAll()) {
        const id = parseInt(rec.id.slice(1), 16)
        if (!rec.frames?.some(f => f.tiles?.length) || id > 0xc8) continue
        if (rows.length >= limit) break
        if (!loaded.has(map)) {
          const l = loadLevelState(rom, parseInt(map, 16))
          loaded.set(map, l.ok ? l.wram : undefined)
        }
        const cam = { x: rec.cameraX, y: rec.cameraY }
        const seed = withSeed({
          loaded: loaded.get(map),
          slot: rec.slot,
          mainPasses: 64,
          sprite: { x: rec.listX, y: rec.listY },
          camera: cam,
          mario: rec.marioAtInit ?? { x: rec.listX, y: rec.listY },
        })
        const entries = (rec.entries ?? []).map(q => ({ ...q, y: q.y + dy }))
        const lag = (rec.drawnFrame ?? 0) - (rec.firstRealFrame ?? 0)
        const g = gradeRecord(runSprite(rom, id, seed), lag, entries, cam)
        by[g.verdict]++
        const c = perId.get(rec.id) ?? perId.set(rec.id, zero()).get(rec.id)!
        c[g.verdict]++
        if (g.delta) {
          const k = `${g.delta.x},${g.delta.y}`
          tally.set(k, (tally.get(k) ?? 0) + 1)
        }
        rows.push({ map, id: rec.id, slot: rec.slot, lag, verdict: g.verdict, delta: g.delta })
      }
      return { by, perId, tally, rows }
    }

    it('reports counts per verdict and per id and holds the floors', () => {
      const { by, perId, tally, rows } = gradeAll()
      const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 10)
      const ids = Object.fromEntries([...perId].sort())
      console.log(`position graded ${rows.length}: ${JSON.stringify(by)}; top deltas x,y:count ${JSON.stringify(top)}`) // prettier-ignore
      console.log(`per id: ${JSON.stringify(ids)}`)
      if (process.env.SPRITE_POSITION_OUT)
        writeFileSync(process.env.SPRITE_POSITION_OUT, JSON.stringify({ by, perId: ids, rows }, null, 1)) // prettier-ignore
      expect(rows.length).toBe(FLOOR.graded)
      expect(by.exact).toBeGreaterThanOrEqual(FLOOR.exact)
      expect(by.off).toBeLessThanOrEqual(FLOOR.maxOff)
      expect(by.lagged).toBeLessThanOrEqual(FLOOR.maxLagged)
      expect(by.missing).toBeLessThanOrEqual(FLOOR.maxMissing)
      expect(by.refused).toBeLessThanOrEqual(FLOOR.maxRefused)
      for (const [id, floor] of Object.entries(ID_FLOOR))
        expect(perId.get(id)?.exact ?? 0, id).toBeGreaterThanOrEqual(floor)
    }, 600_000)

    it('goes red when the pairing is planted with a one line y error', () => {
      const sample = 150
      const base = gradeAll(sample)
      const planted = gradeAll(sample, 1)
      expect(base.by.exact).toBeGreaterThan(sample / 4)
      expect(planted.by.exact).toBeLessThan(base.by.exact / 4)
    }, 600_000)
  },
)
