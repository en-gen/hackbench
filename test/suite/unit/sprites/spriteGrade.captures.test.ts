/**
 * Accuracy loop against Mesen's level-load captures (`layers_v5`
 * `sprite_spawns.json`, vanilla). Gated on the captures AND the vanilla ROM.
 *
 * Tier 1 (graded here): the sprite's OAM shape relative to its own position.
 * Tier 2 (not graded): absolute position and which frame Mesen caught, since
 * the captures record the first on-screen draw of a sprite that was free to
 * move and Mario was somewhere else. Set SPRITE_GRADE_OUT to a file path to
 * dump every graded record as JSON for classification.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../../tools/scripts/capture_render'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import {
  CAPTURE_DIR,
  freshRom,
  hasCaptures,
  hasRom,
  TOOLS_ROOT,
  VANILLA,
} from '../../support/corpus'
import {
  grade,
  levelOf,
  passPieces,
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

/** Map16 tables from the sprite-trace fixtures (same maps, same ROM), when present. */
function traceMap16(map: string): { low: Uint8Array; high: Uint8Array } | undefined {
  const root = join(TOOLS_ROOT, 'fixtures', 'sprite-trace')
  if (!existsSync(root)) return undefined
  for (const sha of readdirSync(root)) {
    const lo = join(root, sha, map, 'map16_7ec800.bin')
    const hi = join(root, sha, map, 'map16_7fc800.bin')
    if (existsSync(lo) && existsSync(hi)) return { low: readFileSync(lo), high: readFileSync(hi) }
  }
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

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))('sprite grading vs level-load captures', () => {
  it('grades every recorded sprite', () => {
    const rom = freshRom()
    const all = loadAll()
    expect(all.length).toBeGreaterThan(0)
    const rows: (Grade & { map: string; id: string; slot: number; want?: unknown; got?: unknown; anchor?: unknown; pos?: unknown; seed?: unknown })[] = [] // prettier-ignore
    const inputs = new Map<number, { reads: number; nonzero: number }>()
    const loadedByMap = new Map<string, Uint8Array>()
    for (const { map, rec, wram } of all) {
      const id = parseInt(rec.id.slice(1), 16)
      const want = recordedFrames(rec)
      if (!want.length || id > 0xc8) continue
      // SPRITE_GRADE_SEED: 'rom' (default) runs the ROM's own level loader for the
      // map; 'generic' seeds placement only; 'oracle' copies the capture's level
      // cells and Map16 (an upper bound for comparison, never a runtime input).
      const mode = process.env.SPRITE_GRADE_SEED ?? 'rom'
      let loaded = loadedByMap.get(map)
      if (mode === 'rom' && !loaded) {
        const l = loadLevelState(rom, parseInt(map, 16))
        loaded = l.ok ? l.wram : undefined
        if (loaded) loadedByMap.set(map, loaded)
      }
      const seed = withSeed({
        loaded: mode === 'rom' ? loaded : undefined,
        map16: mode === 'oracle' ? traceMap16(map) : undefined,
        level: mode === 'oracle' && wram ? levelOf(wram) : undefined,
        slot: rec.slot,
        mainPasses: Number(process.env.SPRITE_GRADE_PASSES ?? 64),
        sprite: { x: rec.listX, y: rec.listY },
        camera: { x: rec.cameraX, y: rec.cameraY },
        mario: rec.marioAtInit ?? { x: rec.listX, y: rec.listY },
      })
      const m = runSprite(rom, id, seed, { trackInputs: !!process.env.SPRITE_GRADE_INPUTS })
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
        ...g, map, id: rec.id, slot: rec.slot,
        ...(dbg ? { want, got: [0, 1, 15].map(i => m.passes[i] && passPieces(m, i)),
            best: g.pass === undefined ? undefined : passPieces(m, g.pass), anchor: m.anchor, pos: m.passes[0]?.pos, seed: rec } : {}),
      }) // prettier-ignore
    }
    if (process.env.SPRITE_GRADE_INPUTS)
      writeFileSync(
        process.env.SPRITE_GRADE_INPUTS,
        JSON.stringify([...inputs].sort((a, b) => b[1].nonzero - a[1].nonzero)),
      )
    const by: Record<string, number> = {}
    for (const r of rows) by[r.verdict] = (by[r.verdict] ?? 0) + 1
    const summary = `graded ${rows.length}: ${JSON.stringify(by)}`
    if (process.env.SPRITE_GRADE_OUT) writeFileSync(process.env.SPRITE_GRADE_OUT, JSON.stringify({ summary, rows }, null, 1)) // prettier-ignore
    console.log(summary)
    expect(rows.length).toBeGreaterThan(0)
  }, 120_000)
})
