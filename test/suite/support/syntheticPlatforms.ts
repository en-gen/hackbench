/**
 * A synthetic cart for sprite $E0, the three-platform loader command (the $E0 issue): the game's I/O contract
 * (inputs in $00-$03, the sprite data through $CE, a status-1 $A3 per spawn) with routines and tables of our own.
 * Laid over `buildSyntheticRom({ eeries: {} })`, which supplies the loader image, the slot search and the sprite loop.
 */
import type { RomFile } from '../../../src/rom/RomFile'
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'
import { buildSyntheticRom, SYNTHETIC_INIT_TABLE_OFFSET } from './syntheticSpriteRom'
import { EERIES_STREAM_AT } from './syntheticEeries'

export const SPAWNER_AT = 0x02af33
/** What the platforms' pieces come out as, left to right (each spawn's angle with INIT's bit 7 added, see below). */
export const ANGLES = [0x11, 0x22, 0x33]
/** The cart's own tables, away from the game's: angles and second table, indexed by spawn number (0 = first spawn). */
export const ANGLE_TABLE_AT = 0x02b180
const FLAG_TABLE_AT = 0x02b184
const MAIN = 0x019700
const INIT = 0x019780
/** The loader's route, written an instruction at a time at the game's offsets (our own order of the two pushes); the JSR stays at +9 where the gate reads the call. */
const ROUTE_AT = 0x02a89c
/** Writes the loader route at the game's offsets so the structure gate sees the vanilla shape without vanilla bytes. */
function writeRoute(rom: RomFile): void {
  const at = (offset: number, ...bytes: number[]) => rom.writeAt(ROUTE_AT + offset, bytes)
  at(0, 0xc9, 0xe0) // compare with the sprite id
  at(2, 0xd0, 0x0c) // branch away for any other id
  at(4, 0xda) // push X
  at(5, 0x5a) // push Y
  at(6, 0x88) // Y - 1
  at(7, 0x84, 0x03) // store it in $03
  at(9, 0x20, SPAWNER_AT & 0xff, (SPAWNER_AT >> 8) & 0xff) // call the spawner
  at(12, 0x7a) // pop Y (the pops run in the reverse of the pushes)
  at(13, 0xfa) // pop X
  at(14, 0x80, 0xee) // back to the head of the loader, 18 bytes up
  at(16, 0xc9, 0x11) // the next case of the loader starts with a compare
}

/**
 * The cart's spawner, 84 bytes like the game's span the gate reads. Our own routine with the game's I/O contract: it
 * counts up from 0 with its counter in $05, keeps the data byte in $06 and Y in $07/$08, sets the number before the
 * status, and reads the spawn's angle and second value from tables indexed by spawn number. The first spawn (0) is the
 * one that takes the list index.
 */
function spawner(): number[] {
  const at = (table: number) => [table & 0xff, table >> 8]
  // prettier-ignore
  return [
    0x64, 0x05, // counter = 0
    0xa4, 0x03, 0xb7, 0xce, 0xaa, 0x29, 0xf0, 0x85, 0x07, 0x8a, 0x29, 0x01, 0x85, 0x08, // data byte -> Y low, Y high
    0x22, 0xe4, 0xa9, 0x02, 0x30, 0x35, 0xbb, // free slot, or on to the next count
    0xa9, 0xa3, 0x95, 0x9e, 0xa9, 0x01, 0x9d, 0xc8, 0x14, 0x22, 0xd2, 0xf7, 0x07, // number, status 1, init tables
    0xa4, 0x05, 0xd0, 0x05, 0xa5, 0x02, 0x9d, 0x1a, 0x16, // the first spawn takes the list index
    0xa5, 0x08, 0x9d, 0xd4, 0x14, 0xa5, 0x07, 0x95, 0xd8, // Y, high byte first
    0xa5, 0x01, 0x9d, 0xe0, 0x14, 0xa5, 0x00, 0x95, 0xe4, // X, high byte first
    0xb9, ...at(ANGLE_TABLE_AT), 0x9d, 0x02, 0x16, 0xb9, ...at(FLAG_TABLE_AT), 0x9d, 0x1c, 0x15,
    0xe6, 0x05, 0xa5, 0x05, 0xc9, 0x03, 0x90, 0xbd, 0x60, // next count, back for three
  ]
}

/** The fingerprints the gate is given for this cart (the vanilla ones name the game's own routines). */
export const SYNTHETIC_PLATFORM_ROUTINES = Object.freeze({
  spawner: spanFingerprint(Uint8Array.from(spawner())),
})

export interface PlatformCartOptions {
  /** The sprite list the data pointer reaches (default: one $E0 entry, data byte $51). */
  stream?: number[]
  /** FindFreeSprSlot's room: how many slots the search covers (default 12). */
  room?: number
  /** $A3's MAIN returns without drawing when $1602 (the angle after INIT) is this: a platform that spawned and did not draw. */
  skipDraw?: number
  /** $A3's MAIN moves its angle by one before drawing unless SpriteLock ($9D) is set, as the game's does (D137): the travel a spawn-frame draw must not show. */
  travel?: boolean
}

/** A synthetic cart: the route, a spawner and the $A3 routines above, each knob in `o` bending one rule a test pins. */
export function platformCart(o: PlatformCartOptions = {}): RomFile {
  const rom = buildSyntheticRom({ eeries: { stream: o.stream ?? [0x51, 0xb3, 0xe0, 0xff], room: o.room } }) // prettier-ignore
  // The loader's route and spawner at the game's addresses, the tables at the cart's own.
  writeRoute(rom)
  rom.writeAt(ANGLE_TABLE_AT, ANGLES) // spawn 0 first: runs hand children over in spawn order (#1063)
  rom.writeAt(FLAG_TABLE_AT, [1, 0, 0])
  rom.writeAt(SPAWNER_AT, spawner())
  // $A3: INIT sets bit 7 of $1602 (so a drawn tile with it set proves INIT ran on the status-1 spawn); MAIN draws one
  // 16 x 16 piece, tile $1602, shifted right by $1602 & $70 so the three do not overlap.
  rom.writeAt(INIT, [0xbd, 0x02, 0x16, 0x09, 0x80, 0x9d, 0x02, 0x16, 0x60])
  // prettier-ignore
  rom.writeAt(MAIN, [
    ...(o.travel ? [0xa5, 0x9d, 0xd0, 0x03, 0xfe, 0x02, 0x16] : []), // LDA $9D / BNE +3 / INC $1602,X
    ...(o.skipDraw === undefined ? [] : [0xbd, 0x02, 0x16, 0xc9, o.skipDraw, 0xd0, 0x01, 0x60]),
    0xbc, 0xea, 0x15, 0xa9, 0x0a, 0x99, 0x03, 0x03, // OAM index, attribute
    0x38, 0xb5, 0xd8, 0xe5, 0x1c, 0x99, 0x01, 0x03, 0xbd, 0x02, 0x16, 0x99, 0x02, 0x03, // y, tile
    0xbd, 0x02, 0x16, 0x29, 0x70, 0x18, 0x75, 0xe4, 0x38, 0xe5, 0x1a, 0x99, 0x00, 0x03, // x
    0xa9, 0x02, 0x48, 0x98, 0x4a, 0x4a, 0xa8, 0x68, 0x99, 0x60, 0x04, 0x60, // size 16 x 16
  ])
  rom.writeAt(0x018170 + SYNTHETIC_INIT_TABLE_OFFSET + 0xa3 * 2, [INIT & 0xff, (INIT >> 8) & 0xff])
  rom.writeAt(0x018320 + 9 + 0xa3 * 2, [MAIN & 0xff, (MAIN >> 8) & 0xff])
  return rom
}

export { EERIES_STREAM_AT as STREAM_AT }
