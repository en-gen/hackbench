/**
 * #1169 acceptance 5: the sprites whose graphics uploads changed when the neighbor rerun got its own probe (PR #1337),
 * and whether their Properties frames changed. "Before" is `runOnce` with ONE probe as both `probe` and
 * `neighbourProbe`, the pre-#1337 behavior. Hashes only, no ROM bytes. Vanilla ROM, one machine, one run.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MARIO_GFX_BASE, readMarioGraphics, uploadProbe } from '../../../../src/rom/MarioGraphics'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import {
  dynamicOf,
  framesOf,
  interpRunner,
  readStream,
  type RunModel,
} from '../../../../theia/extension/src/node/map-sprites'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { slow } from '../../support/loadTimeout'

/** The three maps Golf's one-off sweep of all 512 found changes on; a full sweep takes minutes, so it is not committed. */
const MAPS = [0x11c, 0x1c4, 0x1c5]
/**
 * `map:spriteIndex:id:neighbourRun` (hex map and id). Golf's 13 counted RUNS on 3 sprites (11c:1:1f, 1c4:8:1e, 1c5:8:1e);
 * 12 are reveal-probe runs whose uploads are discarded unless the reveal is 'hidden' (map-sprites.ts:862-864), so 1 sprite's
 * model uploads change. A full sweep (488 of 512 maps compared, one machine, one run, not committed) agreed.
 */
const CHANGED = ['11c:1:1f:same']
/** The changed sprites whose frames differ; a frame change is a neighbor's art going away. */
const FRAMES_CHANGED: string[] = []
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

/** The run as it was before #1337: one probe watches the run alone and the neighbor rerun. */
const oldRun = (
  rom: RomFile,
  id: number,
  seed: Parameters<typeof runOnce>[2],
  opts = {},
): RunModel => {
  const u = uploadProbe()
  const m = runOnce(rom, id, seed, {
    atRest: true,
    probe: u.probe,
    neighbourProbe: u.probe,
    ...opts,
  })
  return Object.assign(m, { uploads: u.byPass })
}
/** A planted old run: every pass but the chosen one also points all 10 slots into the player buffer, so the frames differ. */
const plantedRun: typeof oldRun = (...a) => {
  const m = oldRun(...a)
  const slots = Array.from({ length: 10 }, (_, slot) => ({
    slot,
    ptr: MARIO_GFX_BASE + 0x80 * slot,
  }))
  return {
    ...m,
    uploads: m.passes.map((_, p) => (p === m.chosen ? (m.uploads?.[p] ?? []) : slots)),
  }
}

/** Sweeps `maps`: the sprites whose uploads differ between today's runs and `before`'s, and whether their frames do. */
function sweep(maps: number[], beforeRun: typeof oldRun) {
  const path = romPath(VANILLA)
  const bytes = new Uint8Array(readFileSync(path))
  const rom = RomFile.fromBytes(path, Buffer.from(bytes))
  const smw = new SmwRom(rom)
  const cache = new L1ModelCache()
  const none = { yellow: false, green: false, red: false, blue: false }
  const changed: string[] = []
  const framesDiff: string[] = []
  const table: string[] = []
  const t0 = Date.now()
  for (const index of maps) {
    const ptr = smw.getLevelSpritePointer(index)
    const built = ptr === null ? undefined : cache.get(bytes, path, index, none)
    if (!ptr || !built?.ok) continue
    const model = { ...built.inputs, playerGraphics: () => readMarioGraphics(rom) }
    const stream = parseLevelSprites(readStream(rom, ptr), model.isVertical)
    const base = levelSeed(rom, index)
    const [now, before] = [
      interpRunner(
        rom,
        index,
        model,
        undefined,
        () => base,
        undefined,
        undefined,
        undefined,
        stream,
      ),
      interpRunner(
        rom,
        index,
        model,
        beforeRun,
        () => base,
        undefined,
        undefined,
        undefined,
        stream,
        true,
      ),
    ]
    for (const s of stream) {
      const [a, b] = [now(s), before(s)]
      if (
        'direct' in a ||
        'direct' in b ||
        JSON.stringify(a.m.uploads) === JSON.stringify(b.m.uploads)
      )
        continue
      const key = `${index.toString(16)}:${s.index}:${s.spriteId.toString(16)}`
      const [fa, fb] = [a, b].map(r =>
        framesOf(r, s, model, dynamicOf(rom)).frames.map(f => sha(JSON.stringify(f))),
      ) as [string[], string[]]
      const same = fa.join() === fb.join()
      changed.push(`${key}:${a.m.neighbourRun}`)
      if (!same) framesDiff.push(key)
      table.push(
        `${key} ${a.m.neighbourRun} frames old/new ${fb.length}/${fa.length} changed ${same ? 'no' : 'yes'}`,
      )
    }
  }
  console.log(`${table.join('\n')}\nsweep ${Date.now() - t0} ms`)
  return { changed, framesDiff }
}

describe.skipIf(!hasRom(VANILLA))('neighbor rerun upload probe vs frames (#1169)', () => {
  it('lists the sprites whose uploads changed and compares their frames', slow(120_000), () => {
    const r = sweep(MAPS, oldRun)
    expect(r.changed).toEqual(CHANGED)
    expect(r.framesDiff).toEqual(FRAMES_CHANGED)
  })

  // Proves the frames comparison can fail: extra uploads on the passes the picture is not drawn from must show as a frame change.
  it('reports a frames change when the old run uploads more (planted)', slow(120_000), () => {
    expect(sweep([0x11c], plantedRun).framesDiff.length).toBeGreaterThan(0)
  })
})
