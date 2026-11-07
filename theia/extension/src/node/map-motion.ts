/**
 * The map tab's Play (#1242): what the map's own scroll routines move, run from the working copy by
 * `runMapMotion` (src/rom/MapMotion.ts), plus the Layer 2 rows the view needs to shift Layer 2 with wrap.
 * Pure, so it is unit tested; `ProjectServiceImpl` only resolves the working copy and delegates here.
 */
import { runMapMotion } from '../../../../src/rom/MapMotion'
import { RomFile } from '../../../../src/rom/RomFile'
import type { MapMotionResult } from '../common/project-protocol'
import { base64, drawL2Strip, screenTiles, type L1ModelCache } from './map-screen'

type Reply = Exclude<MapMotionResult, { status: 'rom-not-located' }>

const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
const unavailable = (reason: string): Reply => ({ status: 'unavailable', reason })

/** Replies per working-copy bytes: a run costs about a second on the longest map, and an edit hands out new bytes. */
const replies = new WeakMap<Uint8Array, Map<number, Reply>>()

function compute(cache: L1ModelCache, bytes: Uint8Array, romPath: string, index: number): Reply {
  const run = runMapMotion(RomFile.fromBytes(romPath, Buffer.from(bytes)), index)
  if (run.status === 'none') return { status: 'none' }
  if (run.status === 'refused') return unavailable(run.reason)
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  const l2 = built.ok && built.inputs.l2?.ok ? built.inputs.l2.l2 : null
  if (!built.ok || !l2)
    return unavailable('Layer 2 is not drawn on this map, so there is nothing to move.')
  // The picture at rest is the load state's: the first frame's offset is 0 only if they are the same picture.
  if (l2.dy !== run.frames.l1y[0]! - run.frames.l2y[0]!)
    return unavailable(
      "Layer 2's position when the map loads differs from the picture at rest, so Play will not shift it.",
    )
  const strips = []
  for (let s = 0; s < built.inputs.screenCount; s++) {
    const strip = drawL2Strip(built.inputs, l2, s)
    if (!strip) return unavailable('Play draws horizontal maps only.')
    const { l2Low, l2High } = strip.planes
    strips.push({ low: l2Low && base64(l2Low), high: l2High && base64(l2High) })
  }
  return {
    status: 'ok',
    kind: run.kind,
    ...(run.note && { note: run.note }),
    cameraMoved: run.cameraMoved,
    ...run.frames,
    shiftY: run.shiftY,
    stripRows: 512 - screenTiles(false).h * 16,
    strips,
  }
}

export function mapMotion(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
): Reply {
  let byMap = replies.get(bytes)
  if (!byMap) replies.set(bytes, (byMap = new Map()))
  let r = byMap.get(index)
  if (!r) byMap.set(index, (r = compute(cache, bytes, romPath, index)))
  return r
}
