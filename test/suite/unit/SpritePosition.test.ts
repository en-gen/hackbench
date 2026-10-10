/**
 * Tier 2 of the sprite grader (#830): on-map position against the Mesen
 * captures. Synthetic tests always run; the corpus block needs the captures and
 * the vanilla ROM. Planted defects (each turns a test red when applied):
 *   P1 delta ignores y                       -> the y 1 px test
 *   P2 delta ignores x                       -> the x 1 px test
 *   P3 toMap drops the camera                -> the camera tests
 *   P4 capturePieces drops sizeXHigh bit 0   -> the 9-bit X test
 *   P5 gradePosition says exact for any non-empty pair -> every off test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../tools/scripts/capture_render'
import { runSprite } from '../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, VANILLA } from '../support/corpus'
import {
  capturePieces,
  gradePosition,
  modelPieces,
  toMap,
  type CaptureEntry,
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

  it('reports missing when either side drew nothing', () => {
    expect(gradePosition([], want).verdict).toBe('missing')
    expect(gradePosition(want, []).verdict).toBe('missing')
    expect(gradePosition(place([e(0, 240)]), want).verdict).toBe('missing')
  })
})

interface Rec {
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

/** Measured 2026-10-10, one machine, vanilla ROM: exact 513, off 1381, missing 63; floors keep a little headroom. */
const FLOOR = { graded: 1957, exact: 500, maxOff: 1400, maxMissing: 70 }

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'sprite position vs level-load captures',
  () => {
    it('reports exact, off and missing counts and holds the floors', () => {
      const rom = freshRom()
      const loaded = new Map<string, Uint8Array | undefined>()
      const by = { exact: 0, off: 0, missing: 0 }
      const tally = new Map<string, number>()
      let graded = 0
      for (const { map, rec } of loadAll()) {
        const id = parseInt(rec.id.slice(1), 16)
        if (!rec.frames?.some(f => f.tiles?.length) || id > 0xc8) continue
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
        const g = gradePosition(
          toMap(modelPieces(runSprite(rom, id, seed)), cam),
          toMap(capturePieces(rec.entries ?? []), cam),
        )
        graded++
        by[g.verdict]++
        if (g.delta) {
          const k = `${g.delta.x},${g.delta.y}`
          tally.set(k, (tally.get(k) ?? 0) + 1)
        }
      }
      const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 10)
      console.log(`position graded ${graded}: ${JSON.stringify(by)}; top deltas x,y:count ${JSON.stringify(top)}`) // prettier-ignore
      expect(graded).toBe(FLOOR.graded)
      expect(by.exact).toBeGreaterThanOrEqual(FLOOR.exact)
      expect(by.off).toBeLessThanOrEqual(FLOOR.maxOff)
      expect(by.missing).toBeLessThanOrEqual(FLOOR.maxMissing)
    }, 600_000)
  },
)
