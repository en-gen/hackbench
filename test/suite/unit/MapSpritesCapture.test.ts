/**
 * #980: the Podoboo ($33) position against the Mesen level-load captures (`layers_v5` sprite_spawns.json),
 * every captured $33 on every map that has one. Hardware box = the capture's own camera plus its drawn
 * OAM entries (min x, min y), the sprite 16 px tall; the model is `mapSprites`' box for the same list index.
 * Measured 2026-10-16, vanilla ROM, one machine: 53 of 56 captured $33 match on x0, y0 and height; develop
 * (19ee4775) matched 21 of 56 on y (adversarial reviewer, same machine). The 3 misses are all map $1D4 (list indices 7, 9, 11) and are not this
 * change's: pinned as known so a fix to them, or a regression in the 53, turns this red.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../tools/scripts/capture_render'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { CAPTURE_DIR, hasCaptures, hasRom, romPath, VANILLA } from '../support/corpus'
import { slow } from '../support/loadTimeout'

interface Rec {
  listIndex: number
  id: string
  cameraX: number
  cameraY: number
  entries?: { x: number; y: number; sizeXHigh: number }[]
}

/** Map and list index of the captured $33 the model does not place where hardware drew it (not this change). */
const KNOWN_MISSES = ['1d4:7', '1d4:9', '1d4:11']

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'Podoboo position vs level-load captures (#980)',
  () => {
    it(
      'matches hardware x0, y0 and 16 px height for 53 of 56 captured $33; the other 3 are the known $1D4 ones',
      slow(300_000),
      () => {
        const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
        const cache = new L1ModelCache()
        let total = 0
        const misses: string[] = []
        for (const f of readdirSync(CAPTURE_DIR).sort()) {
          if (!f.endsWith('.zip')) continue
          const files = unzip(readFileSync(join(CAPTURE_DIR, f)))
          const key = [...files.keys()].find(k => k.endsWith('sprite_spawns.json'))
          if (!key) continue
          const spawns = (JSON.parse(files.get(key)!().toString('utf8')).spawns ?? []) as Rec[]
          const recs = spawns.filter(r => r.id === '$33')
          if (!recs.length) continue
          const map = f.slice(0, -4)
          const r = mapSprites(cache, bytes, romPath(VANILLA), parseInt(map, 16))
          if (r.status !== 'ok') throw new Error(`${map}: ${r.status}`)
          for (const rec of recs) {
            total++
            const es = rec.entries ?? []
            const x0 =
              rec.cameraX + Math.min(...es.map(e => (e.x & 255) | ((e.sizeXHigh & 1) << 8)))
            const y0 = rec.cameraY + Math.min(...es.map(e => e.y))
            const b = r.sprites.find(s => s.index === rec.listIndex && s.id === 0x33)?.box
            if (!b || b.x0 !== x0 || b.y0 !== y0 || b.y1 - b.y0 !== 16)
              misses.push(`${map}:${rec.listIndex}`)
          }
        }
        expect(total).toBe(56)
        expect(total - misses.length).toBe(53)
        expect(misses).toEqual(KNOWN_MISSES)
      },
    )
  },
)
