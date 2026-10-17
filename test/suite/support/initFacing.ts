/** Runs a sprite's INIT and reads $157C (SpriteMisc157C, the facing SubHorizPos's Y feeds) for the facing tests. */
import type { RomFile } from '../../../src/rom/RomFile'
import { runSprite } from '../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import type { Loaded } from './captures'

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

/** Records with an `initFacing` whose INIT, run with Mario at the capture's marioStart, disagrees; key is `map:slot:id`. */
export function facingMismatches(
  rom: RomFile,
  recs: readonly Loaded[],
  loadedFor: (map: string) => Uint8Array | undefined,
): FacingMismatch[] {
  const out: FacingMismatch[] = []
  for (const { map, rec, marioStart } of recs) {
    if (rec.initFacing === undefined || !marioStart) continue
    const ours = facingAfterInit(rom, parseInt(rec.id.slice(1), 16), {
      mario: marioStart,
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
