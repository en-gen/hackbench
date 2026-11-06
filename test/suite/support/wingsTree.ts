/**
 * A synthetic ROM and seams for the wings link (#1229): rooms and exits from writeSyntheticRom,
 * the bonus code from plantBonusCode (Yoshi Heaven low byte $C8), and YoshiWings test hooks
 * in place of the sprite code and object handlers a synthetic ROM does not have. No ROM bytes of
 * the game: the path digest is taken from whatever the image holds.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapTree } from '../../../src/rom/MapTree'
import { fingerprint } from '../../../src/rom/Fingerprint'
import { WINGS_PATH, WINGS_TILE, type WingsSeams } from '../../../src/rom/YoshiWings'
import { plantBonusCode, SYNTHETIC_FINGERPRINTS, writeSyntheticRom } from './syntheticRom'

/** The digest the image's own path bytes hash to, so the gate passes until a test changes one. */
export const pathDigestOf = (rom: RomFile): string =>
  fingerprint(Buffer.concat(WINGS_PATH.map(([a, n]) => rom.readAt(a, n)!)))!

/** `secondary` lists rooms whose screen exits are secondary ones (byte 1 of the exit object, bank_0D.asm:1436-1438). */
export function wingsRom(exits: Record<number, number[]>, secondary: number[] = []): RomFile {
  const slots = [0x000, 0x100, 0x0c8, 0x1c8, ...Object.keys(exits).map(Number)]
  const rooms = new Map<number, number[]>(slots.map(s => [s, exits[s] ?? []]))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wings-'))
  const rom = RomFile.load(writeSyntheticRom(dir, rooms))
  plantBonusCode(rom)
  const smw = new SmwRom(rom)
  for (const slot of secondary) rom.writeAt(smw.getLevelL1Pointer(slot)! + 6, [0x02])
  return rom
}

/** `holders` maps a slot to the columns it places the block at. Column `wingsColumn` of the period gives the wings. */
export function seamsFor(
  rom: RomFile,
  holders: Record<number, number[]>,
  wingsColumn = 1,
): WingsSeams {
  return {
    digests: [pathDigestOf(rom)],
    spawn: col => ({ number: 0x7e, c2: col === wingsColumn ? 2 : 1 }),
    grid: slot => {
      const at = holders[slot]
      if (!at) return [[0x25, 0x25]]
      const row = new Array<number>(Math.max(...at) + 1).fill(0x25)
      for (const x of at) row[x] = WINGS_TILE
      return [row]
    },
  }
}

export function wingsTree(
  rom: RomFile,
  seams: WingsSeams,
  build: typeof buildMapTree = buildMapTree,
): MapTree {
  return build(new SmwRom(rom), { ...SYNTHETIC_FINGERPRINTS, wings: seams })
}

/** Root -> the Yoshi Heaven child the wings link placed under it. */
export function yoshiUnder(tree: MapTree): Record<number, number[]> {
  const out: Record<number, number[]> = {}
  for (const n of tree.overworld) {
    const kids = n.children.filter(c => c.reachedBy === 'yoshi-heaven').map(c => c.index)
    if (kids.length > 0) out[n.index] = kids
  }
  return out
}
