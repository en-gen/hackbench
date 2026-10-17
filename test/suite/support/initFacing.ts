/** Runs a sprite's INIT and reads $157C (SpriteMisc157C, the facing SubHorizPos's Y feeds) for the facing tests. */
import type { RomFile } from '../../../src/rom/RomFile'
import { runSprite } from '../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import type { Loaded } from './captures'
import { freshRom } from './corpus'

const FACING = 0x157c

type XY = { x: number; y: number }

/** $157C + slot as INIT left it: sampled at the probe hook (-1), after INIT and before any MAIN pass. */
export function facingAfterInit(
  rom: RomFile,
  id: number,
  o: { mario: XY; sprite: XY; slot?: number; loaded?: Uint8Array; camera?: XY },
): number | undefined {
  const slot = o.slot ?? 0
  let facing: number | undefined
  runSprite(rom, id, withSeed({ ...o, slot, mainPasses: 1 }), {
    probe: (p, w) => {
      if (p === -1) facing = w[FACING + slot]
    },
  })
  return facing
}

export interface FacingMismatch {
  key: string
  capture: number
  ours: number | undefined
}

/** The vanilla ROM, loaded once for the facing tests, and the level loader's image per map, cached across describes. */
let shared: RomFile | undefined
const images = new Map<number, Uint8Array | undefined>()
export function loaderImage(map: number): Uint8Array | undefined {
  shared ??= freshRom()
  if (!images.has(map)) {
    const l = loadLevelState(shared, map)
    images.set(map, l.ok ? l.wram : undefined)
  }
  return images.get(map)
}
export const sharedRom = (): RomFile => (shared ??= freshRom())

/** Mario's start as the map view seeds it: the loader image's $94/$96. */
export function loaderMario(map: number): XY | undefined {
  const w = loaderImage(map)
  return w && { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
}

/**
 * Records with an `initFacing` whose INIT, run with `marioFor(record)`, disagrees; key is `map:slot:id`.
 * The slot is the hardware's (a few sprites, Lakitu's rider $1E, read $157C of another slot).
 */
export function facingMismatches(
  rom: RomFile,
  recs: readonly Loaded[],
  marioFor: (r: Loaded) => XY | undefined,
  loadedFor: (map: string) => Uint8Array | undefined,
): FacingMismatch[] {
  const out: FacingMismatch[] = []
  for (const r of recs) {
    const { map, rec } = r
    const mario = marioFor(r)
    if (typeof rec.initFacing !== 'number' || !mario) continue
    const ours = facingAfterInit(rom, parseInt(rec.id.slice(1), 16), {
      mario,
      sprite: { x: rec.listX, y: rec.listY },
      camera: { x: rec.cameraX, y: rec.cameraY },
      slot: rec.slot,
      loaded: loadedFor(map),
    })
    if (ours !== rec.initFacing)
      out.push({ key: `${map}:${rec.slot}:${rec.id}`, capture: rec.initFacing, ours })
  }
  return out
}
