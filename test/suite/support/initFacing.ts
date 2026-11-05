/** Runs a sprite's INIT and reads $157C (SpriteMisc157C, the facing SubHorizPos's Y feeds) for the facing tests. */
import type { RomFile } from '../../../src/rom/RomFile'
import { runSprite } from '../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import type { Loaded } from './captures'
import { placedInitId } from './gradeTimeline'
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

/** A record whose INIT facing differs from the capture's. */
export interface FacingMismatch {
  key: string
  capture: number
  ours: number | undefined
}

/** The vanilla ROM, loaded once for the facing tests, and the level loader's image per map, cached across describes. */
let shared: RomFile | undefined
const images = new Map<number, Uint8Array | undefined>()
/** The level loader's WRAM image for `map`, or undefined when the loader refuses; cached per map. */
export function loaderImage(map: number): Uint8Array | undefined {
  shared ??= freshRom()
  if (!images.has(map)) {
    const l = loadLevelState(shared, map)
    images.set(map, l.ok ? l.wram : undefined)
  }
  return images.get(map)
}
/** The vanilla ROM, loaded once and shared by the facing tests. */
export const sharedRom = (): RomFile => (shared ??= freshRom())

/** Mario's start as the map view seeds it: the loader image's $94/$96. */
export function loaderMario(map: number): XY | undefined {
  const w = loaderImage(map)
  return w && { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
}

/** The id sprites.json lists at the record's listIndex, or undefined when the record cannot be joined to a list entry. */
const placedId = (r: Loaded): number | undefined => {
  const id = r.listed?.find(e => e.index === r.rec.listIndex)?.id
  return r.rec.listIndex === undefined || id === undefined ? undefined : parseInt(id.slice(1), 16)
}
/** Records that name a list index the map's list does not have: they run under the capture's id, unverified. */
export const unjoined = (recs: readonly Loaded[]): Loaded[] =>
  recs.filter(r => r.rec.listIndex !== undefined && placedId(r) === undefined)

/** $157C after INIT for one record, under the id the loader gave it (see facingMismatches). */
export function oursFor(
  rom: RomFile,
  r: Loaded,
  mario: XY,
  loaded?: Uint8Array,
): number | undefined {
  const { rec } = r
  const listed = placedId(r)
  const id =
    (listed === undefined ? undefined : placedInitId(rom, listed)) ?? parseInt(rec.id.slice(1), 16)
  return facingAfterInit(rom, id, {
    mario,
    sprite: { x: rec.listX, y: rec.listY },
    camera: { x: rec.cameraX, y: rec.cameraY },
    slot: rec.slot,
    loaded,
  })
}

/**
 * Records with an `initFacing` whose INIT, run with `marioFor(record)`, disagrees; key is `map:slot:id`.
 * INIT runs under the PLACED list id where the loader keeps it (placedInitId), as the map view does: the capture's id is the number at the end of INIT's frame, and an Exploding Block ($4C) swaps in its own later one (bank_02.asm:13281-13283, #1243).
 * The slot is the hardware's: the cloud's MAIN writes Lakitu's rider's $157C (docs/sprites/lakitu-facing.md), so the rider's facing depends on the cloud's slot.
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
    const ours = oursFor(rom, r, mario, loadedFor(map))
    if (ours !== rec.initFacing)
      out.push({ key: `${map}:${rec.slot}:${rec.id}`, capture: rec.initFacing, ours })
  }
  return out
}
