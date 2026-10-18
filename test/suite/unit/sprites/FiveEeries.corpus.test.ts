/**
 * Sprite $DE on the vanilla ROM (#1015). Gated on the ROM (the capture block also on the layers_v5 captures).
 *
 * The capture is mid-level, not level start: the Eeries load when the camera reaches them, and its recorder links a
 * slot to a list entry through SpriteLoadIndex, which Load5Eeries sets on the FIRST spawn only (SMWDisX
 * bank_02.asm:6305-6308). So one Eerie per placement has hardware numbers: the rightmost (+$20 from the entry).
 * It is compared after the same number of frames; the other four are ROM-derived only (docs/sprites/sprite-de-five-eeries.md).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../../tools/scripts/capture_render'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { fiveEeries } from '../../../../src/rom/sprites/interp/FiveEeries'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../../theia/extension/src/node/map-sprites'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, romPath, VANILLA } from '../../support/corpus'

/**
 * Every vanilla map that places $DE: its placements, and the Eeries each spawns from empty slots. $1E8 and $1E9 share
 * $11D's list. Memory setting 11 ($11D family) has a four-slot range, so four spawn (FiveEeries.ts head).
 */
const MAPS: [number, number, number][] = [[0x021, 2, 5], [0x11d, 1, 4], [0x1e8, 1, 4], [0x1e9, 1, 4]] // prettier-ignore

function placements(map: number) {
  const rom = freshRom()
  const smw = new SmwRom(rom)
  const data = rom.readUpTo(smw.getLevelSpritePointer(map)!, 0x200)!
  return { rom, sprites: parseLevelSprites(data, false).filter(s => s.spriteId === 0xde) }
}

/** The Eeries of one placement over the level's own loader image, keeping each Eerie's runner model (nth order). */
function eeriesOf(map: number, i: number, passes = 1) {
  const { rom, sprites } = placements(map)
  const base = levelSeed(rom, map)
  const w = base.loaded!
  const mario = { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
  const e = sprites[i]!
  const [x, y] = [e.x * 16, e.y * 16]
  const seed = withSeed(
    { sprite: { x, y }, camera: { x: Math.max(0, x - 128), y: 192 }, mario },
    base,
  )
  const models: SpriteModel[] = []
  const run = (r: never, id: number, s: never, o: never) => (models[(o as { spawn: { nth: number } }).spawn.nth] = runOnce(r, id, s, o)) // prettier-ignore
  const res = fiveEeries(rom, seed, { x, y, index: e.index, streamOffset: e.streamOffset }, undefined, passes, run as never) // prettier-ignore
  return { res, models, entry: e, x, y }
}

describe.skipIf(!hasRom(VANILLA))('sprite $DE, vanilla ROM', () => {
  it.each(MAPS)('map %i: the list holds the expected number of $DE placements', (map, n) => {
    expect(placements(map).sprites).toHaveLength(n)
  })

  it.each(MAPS)(
    'map %i: every placement spawns its Eeries on the vanilla routines, none refused',
    (map, n, count) => {
      for (let i = 0; i < n; i++) {
        const { res, x, y, entry } = eeriesOf(map, i)
        if (!res.ok) throw new Error(res.reason)
        expect(res.unverified, 'no routine differs from vanilla').toEqual([])
        expect(res.notes).toEqual([])
        expect(res.spawned).toBe(count)
        expect(res.eeries).toHaveLength(count)
        // D137: each sits where the spawner put it, -32 -16 0 16 32 from the entry (the missing one of a four-slot
        // range is the last spawn, -32), at the data byte's Y: no travel.
        const want = [-32, -16, 0, 16, 32].slice(5 - count)
        expect(res.eeries.map(q => q.x - x)).toEqual(want)
        const dataY = (entry.raw[0]! & 0xf0) | ((entry.raw[0]! & 1) << 8)
        expect(dataY).toBe(y)
        expect(res.eeries.map(q => q.y)).toEqual(want.map(() => dataY))
      }
    },
  )

  it('draws through the map view as one sprite per placement, never a marker', () => {
    const bytes = new Uint8Array(freshRom().buffer)
    for (const [map, n, count] of MAPS) {
      const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
      if (r.status !== 'ok') throw new Error(`map ${map.toString(16)}: ${r.status}`)
      const de = r.sprites.filter(s => s.id === 0xde)
      expect(de, `map ${map.toString(16)}`).toHaveLength(n)
      for (const s of de) {
        expect(s.status, JSON.stringify({ ...s, rgba: undefined, priority: undefined })).toBe('drawn') // prettier-ignore
        // Pieces 16 px apart and 16 wide: 16 * count px.
        expect(s.box.x1 - s.box.x0).toBe(16 * count)
      }
    }
  })
})

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'sprite $DE against the layers_v5 capture of map $021',
  () => {
    // Read inside the test: a skipped describe still runs its body.
    const spawnsOf = () => {
      const entries = unzip(readFileSync(join(CAPTURE_DIR, '021.zip')))
      const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))!
      return JSON.parse(entries.get(key)!().toString('utf8')).spawns as Spawn[]
    }
    type Spawn = {
      listIndex: number
      id: string
      initFrame: number | null
      spawnFrame: number
      frames: { frame: number; x: number; y: number; tiles: { tile: number }[] }[]
    }

    // The capture's two $DE-linked records (id $39, no INIT: status $08 from the spawner).
    it.each([[0], [1]])(
      'placement %i: the capture-linked Eerie is where hardware shows it, frame for frame',
      i => {
        const { entry, models, res } = eeriesOf(0x21, i, 24)
        expect(res.ok).toBe(true)
        const rec = spawnsOf().find(s => s.listIndex === entry.index)!
        expect(rec.id).toBe('$39')
        expect(rec.initFrame).toBeNull()
        // nth 4 is the highest slot: the first spawn, +$20 from the entry, the one that carries the list index.
        const m = models[4]!
        const frames = rec.frames.slice(0, 2)
        expect(frames).toHaveLength(2)
        // The first capture frame is 8 frames after the spawn; the second 8 after that. Our run's pass k is k + 2 frames
        // after the spawn frame (one frame at the spawn, one more before pass 0), so the capture frames sit at pass 6 and 14.
        for (const [k, f] of [
          [6, frames[0]!],
          [14, frames[1]!],
        ] as const) {
          expect(f.frame - rec.spawnFrame).toBe(k + 2)
          expect(m.passes[k]!.pos, `pass ${k}`).toEqual({ x: f.x, y: f.y })
          expect(m.passes[k]!.parts[0]!.char & 0xff, `tile at pass ${k}`).toBe(f.tiles[0]!.tile)
        }
      },
    )
  },
)
