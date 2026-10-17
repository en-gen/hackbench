/**
 * The synthetic cart's five-Eerie spawner (#1015): see `SyntheticOptions.eeries` in syntheticSpriteRom.ts. Split out to
 * keep that file under the content gate's byte-token limit.
 *
 * Every routine here is written for this fixture from the CONTRACT the map view relies on, not copied from the game:
 * the spawner reads the entry's data byte through the sprite data pointer, spawns up to five slot sprites from its own
 * offset table, gives the first spawn the list index, and asks a distance routine for each one's X speed. Instruction
 * choices, scratch cells and table addresses are our own, and so are the table values.
 */
import { SPRITE_SEED, withSeed, type SpriteSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import type { SyntheticOptions } from './syntheticSpriteRom'

/** Where the fixture's sprite list stands, and the data pointer that reaches it (bank $03). */
export const EERIES_STREAM_AT = 0x038000
/** Where the loader calls the spawner from, the spawner's entry, the distance routine and the fixture's tables. */
export const ROUTE_AT = 0x02a88c
export const SPAWNER_AT = 0x02af9d
export const DISTANCE_AT = 0x02848d
export const TABLES_AT = 0x02b200
/** Offsets inside the spawner and the distance routine that tests plant defects at. */
export const COUNT_IMMEDIATE_AT = SPAWNER_AT + 12
export const DISTANCE_INY_AT = DISTANCE_AT + 13
/** The fixture's own X offsets of the five spawns (the first spawn is the last entry), and its X speed by Mario's side. */
export const SYNTHETIC_OFFSETS = Object.freeze([-0x28, -0x14, 0, 0x14, 0x28])
export const SYNTHETIC_SPEEDS = Object.freeze({ marioRight: 0x18, marioLeft: 0xe8 })
/** The fixture's default list: one entry, data byte $71 (Y $170), column 4 of screen 3. */
export const EERIES_DEFAULT_STREAM = Object.freeze([0x71, 0x43, 0xde, 0xff])
/** The gate's fingerprints of the fixture's own spawner (97 bytes), distance routine (18) and route (12). */
export const SYNTHETIC_EERIES_ROUTINES = Object.freeze({
  spawner: '4d2a8762f4befd476d4aebc53608dc16810e50e05ca9d236901d5379f1c91c52',
  horzPos: 'c79ebc0d75b79074d5e2d6b1823c26397b672762e9badcb987761236c9e42dbb',
  route: 'c312018be40e9835358374403cb5718453dfb9cb6fbc6fb2b5d89e0c9bcb438c',
})

/** A loaded level image with Mario at `marioX` and SpriteDataPtr ($CE-$D0) at the fixture's list; `extra` adds camera, mario or sprite. */
export function eeriesSeed(marioX: number, extra: Parameters<typeof withSeed>[0] = {}): SpriteSeed {
  const loaded = new Uint8Array(0x20000)
  loaded.set([marioX & 0xff, marioX >> 8, 0, 0], 0x94)
  const ptr = { 0xce: EERIES_STREAM_AT & 0xff, 0xcf: (EERIES_STREAM_AT >> 8) & 0xff, 0xd0: EERIES_STREAM_AT >>> 16 } // prettier-ignore
  return withSeed({ ...extra, ram: { ...extra.ram, ...ptr } }, { ...SPRITE_SEED, loaded })
}

/** Where sprite $39's handler sits in the fixture. */
export const EERIE_HANDLER = 0x019600

const abs3 = (op: number, a: number) => [op, a & 0xff, (a >> 8) & 0xff]
const lo = (a: number) => a & 0xff
const hi = (a: number) => (a >> 8) & 0xff

/** The spawner: its code as an array, with the loop's branch offsets worked out. */
function spawnerCode(): number[] {
  const t = {
    lo: TABLES_AT,
    hi: TABLES_AT + 5,
    xs: TABLES_AT + 10,
  }
  const abs = (op: number, a: number) => [op, lo(a), hi(a)]
  // Data byte to $0A/$0B (raw, then its bit 0), the countdown in $0C.
  const head = [0xa5, 0x03, 0xa8, 0xb7, 0xce, 0x85, 0x0a, 0x29, 0x01, 0x85, 0x0b, 0xa9, 0x04, 0x85, 0x0c] // prettier-ignore
  // Number, then status, then the game's table initialiser for the slot.
  const claim = [0xbb, 0xa9, 0x39, ...abs(0x9d, 0x009e), 0xda, 0xfa, 0xa9, 0x08, ...abs(0x9d, 0x14c8), 0xda, 0xfa, 0x22, 0xd2, 0xf7, 0x07] // prettier-ignore
  const place = [
    0xa4, 0x0c,
    0xa5, 0x0a, 0x29, 0xf0, 0x95, 0xd8, 0xa5, 0x0b, ...abs(0x9d, 0x14d4),
    0xa5, 0x00, 0x18, ...abs(0x79, t.lo), 0x95, 0xe4,
    0xa5, 0x01, ...abs(0x79, t.hi), ...abs(0x9d, 0x14e0),
    0x20, lo(DISTANCE_AT), hi(DISTANCE_AT), ...abs(0xb9, t.xs), 0x95, 0xb6,
    0xa5, 0x0c, 0x4a, 0x4a, 0xf0, 0x05, 0xa5, 0x02, ...abs(0x9d, 0x161a),
    0xc6, 0x0c,
  ] // prettier-ignore
  const search = [0x22, 0xe4, 0xa9, 0x02] // JSL to the slot search
  // BMI skips the claim, the placement and the loop's BPL to the RTS; the BPL goes back to the search.
  const body = claim.length + place.length + 2
  return [
    ...head,
    ...search,
    0x30,
    body,
    ...claim,
    ...place,
    0x10,
    0x100 - (search.length + 2 + body),
    0x60,
  ]
}

/** The five-Eerie spawner fixture (#1015): see `SyntheticOptions.eeries`. */
export function putEeries(
  put: (snes: number, bytes: number[]) => void,
  e: NonNullable<SyntheticOptions['eeries']>,
): void {
  // The loader's call site: the base cart already has the compare and branch in front (4 bytes); then filler, then the
  // JSR the production code reads its target from.
  put(ROUTE_AT + 4, [...new Array<number>(5).fill(0xea), 0x20, lo(SPAWNER_AT), hi(SPAWNER_AT)])
  // The distance routine: Y = 1 when Mario is left of the sprite (a borrow comparing X positions), else 0.
  put(
    DISTANCE_AT,
    [0xa0, 0x00, 0xa5, 0x94, 0xd5, 0xe4, 0xa5, 0x95, 0xfd, 0xe0, 0x14, 0xb0, 0x01, 0xc8, 0x60],
  )
  // Tables of our own values: X offsets (low, high) and X speed by side. (The fixture's $39 does not move, so the
  // spawner sets no Y speed or state.)
  const offs = e.spacing ?? [...SYNTHETIC_OFFSETS.slice(0, 2), ...SYNTHETIC_OFFSETS.slice(3)]
  const all = [offs[0]!, offs[1]!, 0, offs[2]!, offs[3]!]
  put(
    TABLES_AT,
    all.map(v => v & 0xff),
  )
  put(
    TABLES_AT + 5,
    all.map(v => (v < 0 ? 0xff : 0)),
  )
  put(TABLES_AT + 10, [SYNTHETIC_SPEEDS.marioRight, SYNTHETIC_SPEEDS.marioLeft])
  put(SPAWNER_AT, spawnerCode())
  // The slot search over a range of `room` slots: from slot room-1 down to slot 0, Y = $FF and N set when none is free.
  const room = e.room ?? 12
  const search =
    room === 0
      ? [0xa0, 0xff, 0x98, 0x6b]
      : [0xa0, room - 1, 0xb9, 0xc8, 0x14, 0xf0, 0x05, 0x88, 0xc0, 0xff, 0xd0, 0xf6, 0x98, 0x6b]
  put(0x02a9e4, search)
  // Sprite $39's MAIN: one 16 x 16 piece in the slot's OAM entry, tile = its X speed so the side it faces is in the
  // drawn piece. Attribute and tile first, then Y and X relative to the camera, then the size bit.
  // prettier-ignore
  put(EERIE_HANDLER, [
    0xbc, 0xea, 0x15, 0x98, 0x4a, 0x4a, 0x48, 0xa9, 0x0a, ...abs3(0x99, 0x0303), 0xb5, 0xb6, ...abs3(0x99, 0x0302),
    0x38, 0xb5, 0xd8, 0xe5, 0x1c, ...abs3(0x99, 0x0301), 0x38, 0xb5, 0xe4, 0xe5, 0x1a, ...abs3(0x99, 0x0300),
    0xfa, 0xa9, 0x02, ...abs3(0x9d, 0x0460), 0x60,
  ])
  // The sprite list the data pointer reaches.
  put(EERIES_STREAM_AT, e.stream ?? [...EERIES_DEFAULT_STREAM])
}
