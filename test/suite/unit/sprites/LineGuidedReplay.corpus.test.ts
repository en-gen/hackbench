/**
 * Replays every hardware-witnessed vanilla line-guided placement ($62-$68) from the layers_v5 captures
 * (`sprite_spawns.json`: x, y, initFrame, drawnFrame, trueFrame) through the runner and compares the sprite's
 * position at the frame Mesen caught it (#1029). Evidence scope: 101 records in 6 maps, vanilla ROM, Mesen 2.x
 * level-load captures, one machine; not a sweep of every placement (the unwitnessed ones are in the PR body).
 *
 * Method: k = drawnFrame - initFrame. The runner's pass p runs on frame initFrame + 1 + p with TrueFrame
 * seed + 1 + p, so the seed is hw trueFrame - k and the draw of frame k is pass k-1. The ids draw before their
 * line step (SMWDisX bank_01.asm:12194-12204 for $67; the others read the position the pass before left), so
 * the recorded X, Y is the position after pass k-2 for $64-$68. $62 and $63 are platforms whose record is the
 * first drawn tile, not the sprite origin, so they compare the model's first OAM piece on pass k-1 (the tiles
 * sit 24 px left and 8 px above the origin of a 3-tile platform, 40 left for a 5-tile one).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../../tools/scripts/capture_render'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, VANILLA } from '../../support/corpus'

interface Rec {
  map: string
  id: number
  x: number
  y: number
  listX: number
  listY: number
  slot: number
  cameraX: number
  cameraY: number
  trueFrame: number
  effFrame: number
  initFrame: number
  drawnFrame: number
  marioAtInit: { x: number; y: number }
}

/** The maps that hold a witnessed $62-$68; the sweep needs all of them to mean what its counts say. */
const MAPS = ['005', '00f', '01a', '01f', '12a', '12c']

function records(): Rec[] {
  const out: Rec[] = []
  for (const map of MAPS) {
    const entries = unzip(readFileSync(join(CAPTURE_DIR, `${map}.zip`)))
    const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
    if (!key) throw new Error(`map ${map}: no sprite_spawns.json`)
    const j = JSON.parse(entries.get(key)!().toString('utf8')) as { spawns?: (Rec & { id: string })[] } // prettier-ignore
    for (const r of j.spawns ?? []) {
      const id = parseInt(r.id.slice(1), 16)
      if (id >= 0x62 && id <= 0x68) out.push({ ...r, map, id })
    }
  }
  return out
}

/** Records the model reproduces, by id; `flip` plants a TrueFrame parity error in the seed. */
function replay(
  recs: Rec[],
  flip = 0,
): { matched: Record<string, number>; total: number; initRetries: number } {
  // prettier-ignore
  const rom = freshRom()
  const loaded = new Map<string, Uint8Array | undefined>()
  const matched: Record<string, number> = {}
  let initRetries = 0
  for (const r of recs) {
    if (!loaded.has(r.map)) {
      const l = loadLevelState(rom, parseInt(r.map, 16))
      loaded.set(r.map, l.ok ? l.wram : undefined)
    }
    const k = r.drawnFrame - r.initFrame
    const seed = withSeed({
      loaded: loaded.get(r.map),
      slot: r.slot,
      mainPasses: k + 1,
      trueFrame: ((r.trueFrame - k) & 0xff) ^ flip,
      effFrame: (r.effFrame - k) & 0xff,
      sprite: { x: r.listX, y: r.listY },
      camera: { x: r.cameraX, y: r.cameraY },
      mario: r.marioAtInit,
    })
    const m = runOnce(rom, r.id, seed)
    if (m.initFrames !== 1) initRetries++
    const platform = r.id === 0x62 || r.id === 0x63
    const first = [...(m.passes[k - 1]?.parts ?? [])].sort((a, b) => a.oam - b.oam)[0]
    const got = platform
      ? first && { x: first.ox + r.cameraX, y: first.oy + r.cameraY }
      : m.passes[k - 2]?.pos
    const key = `$${r.id.toString(16)}`
    matched[key] ??= 0
    if (got?.x === r.x && got.y === r.y) matched[key]++
  }
  return { matched, total: recs.length, initRetries }
}

describe.skipIf(
  !hasRom(VANILLA) ||
    !hasCaptures() ||
    !MAPS.every(m => hasCaptures(join(CAPTURE_DIR, `${m}.zip`))),
)('line-guided replay against the hardware captures (#1029)', () => {
  it('reproduces every witnessed $62-$68 position: 101 of 101, per id', () => {
    const recs = records()
    // The expected totals come from the captures read above, so a vanishing record or map goes red here.
    expect(recs).toHaveLength(101)
    expect(readdirSync(CAPTURE_DIR).length).toBeGreaterThanOrEqual(MAPS.length)
    const got = replay(recs)
    // Named exceptions: none. The longest runs (k = 91 on $64, k = 103 and 109 on $63) match too.
    expect(got.matched).toEqual({ $62: 6, $63: 6, $64: 11, $65: 25, $66: 1, $67: 17, $68: 35 })
    expect(got.initRetries).toBe(0)
  }, 120_000)

  it('goes red when the TrueFrame seed has the wrong parity', () => {
    const planted = replay(records(), 1)
    expect(planted.total).toBe(101)
    // Measured on this machine: $62-$64 do not use the frame counter for their travel; of the $187B ids
    // ($65-$68) 34 of 78 still match, because a flipped parity leaves the sum of the steps unchanged on some runs.
    expect(planted.matched).toEqual({ $62: 6, $63: 6, $64: 11, $65: 21, $66: 1, $67: 4, $68: 8 })
    expect(Object.values(planted.matched).reduce((a, b) => a + b, 0)).toBe(57)
  }, 120_000)
})
