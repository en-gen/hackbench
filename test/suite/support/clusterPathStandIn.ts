/**
 * The call path from a level's sprite list to the cluster spawns and draws (castle flames $E6, rotating
 * ring $E2/$E3), written for a synthetic cart: INVENTED code that is not the game's. It differs in
 * instruction choice, order, operands and addresses from the ROM's (a subtract-and-compare dispatch, a
 * counting-up loop, scratch cells instead of the stack, the dispatch block and the route body moved to other
 * addresses), so no vanilla code or table position is committed (D126, FINGERPRINT MINIMUM rule 9). The gate
 * in CastleFlames.ts runs this code on the core; `STANDIN_LAYOUT` tells it where this cart keeps it.
 * Evidence scope: synthetic bytes; the vanilla ROM's own path is proven in the corpus blocks.
 */
import type { ClusterLayout } from '../../../src/rom/sprites/interp/CastleFlames'

const lo = (a: number): number => a & 0xff
const hi = (a: number): number => (a >> 8) & 0xff
const jsl = (to: number): number[] => [0x22, lo(to), hi(to), to >> 16]
const jmp = (to: number): number[] => [0x4c, lo(to), hi(to)]
const jsr = (to: number): number[] => [0x20, lo(to), hi(to)]

export const STANDIN = {
  /** The cart's shell loader site (syntheticSpriteRom.ts) holds the route's first four bytes. */
  route: 0x02a8c0,
  routeBody: 0x02f8a0,
  entry: 0x02aac0,
  loop: 0x02f808,
  /** The dispatch block (a JSL to the cart's ExecutePtr, then the word table): NOT at the game's address. */
  dispatch: 0x02f900,
  flameSpawn: 0x02aa6c,
  ringSpawn: 0x02ab11,
  flameDraw: 0x02fa16,
  ringDraw: 0x02fa98,
  execPtr: 0x0086fa,
  loadNext: 0x02a846,
} as const

/** Where a word of the dispatch table sits: after the 4-byte JSL, two bytes per cluster type. */
export const tableWord = (type: number, dispatch: number = STANDIN.dispatch): number =>
  dispatch + 4 + 2 * type

/** Layout facts the gate reads: the stand-in's code spans, in the form `ClusterLayout` takes. */
export const STANDIN_LAYOUT: ClusterLayout = {
  route: [
    [STANDIN.route, STANDIN.route + 16],
    [STANDIN.routeBody, STANDIN.routeBody + 16],
  ],
  entry: [STANDIN.entry, STANDIN.entry + 29],
  loop: [STANDIN.loop, STANDIN.loop + 28],
  dispatch: STANDIN.dispatch,
}

export interface StandInOptions {
  /** The loop calls the dispatch block by a long call through the FastROM mirror of its bank. */
  fastRom?: boolean
}

/** Everything to write, as [address, bytes]. */
export function clusterPathStandIn(o: StandInOptions = {}): [number, number[]][] {
  const s = STANDIN
  // The loop's call: a near call, or a long one through $82 for the mirror case (one byte longer).
  const call = o.fastRom ? jsl(s.dispatch | 0x820000) : jsr(s.dispatch)
  // prettier-ignore
  const loop = [
    0x8b, 0xa9, 0x02, 0x48, 0xab,               // PHB / LDA #2 / PHA / PLB: DB = 2
    0xa2, 0x00,                                 // LDX #0
    0x8e, 0xe9, 0x15,                           // lp: STX CurSpriteProcess
    0xbd, 0x92, 0x18,                           // LDA ClusterSpriteNumber,X
    0xd0, 0x07,                                 // BNE call
    0xe8, 0xe0, 0x14,                           // nx: INX / CPX #$14
    0x90, 0xf3,                                 // BCC lp
    0xab, 0x6b,                                 // PLB / RTL
    ...call,                                    // call:
    0x80, o.fastRom ? 0xf3 : 0xf4,              // BRA nx
  ]
  return [
    // route: the shell's head sits at s.route; a jump to the body, which keeps X in a scratch cell, hands
    // Y less one to the spawn in $03, and restores both
    [s.route + 4, jmp(s.routeBody)],
    [
      s.routeBody,
      [
        0x86,
        0x0c,
        0x88,
        0x84,
        0x03,
        ...jsr(s.entry),
        0xa6,
        0x0c,
        0xa4,
        0x03,
        0xc8,
        ...jmp(s.loadNext),
      ],
    ],
    // entry: store the activate flag, then pick the spawn by the id less $E2 (0 or 1 ring, 4 flames), id kept in A
    [
      s.entry,
      [
        0x48,
        0xa9,
        0x01,
        0x8d,
        0xb8,
        0x18,
        0x68,
        0x48,
        0x38,
        0xe9,
        0xe2,
        0xc9,
        0x02,
        0xb0,
        0x04,
        0x68,
        ...jmp(s.ringSpawn),
        0xc9,
        0x04,
        0xd0,
        0x04,
        0x68,
        ...jmp(s.flameSpawn),
        0x68,
        0x60,
      ],
    ],
    [s.loop, loop],
    [s.dispatch, jsl(s.execPtr)],
    [tableWord(4), [lo(s.ringDraw), hi(s.ringDraw)]],
    [tableWord(5), [lo(s.flameDraw), hi(s.flameDraw)]],
  ]
}

export const ROUTE = 'the loader route to the sprite spawn'
export const LOOP = 'the cluster loop'

/** A hacked call path: what to overwrite in the stand-in, and the stage the gate must name (null: this cart is not affected). */
export interface PathHack {
  name: string
  /** `flame` picks the flames ($E6, type 5) over the ring ($E2/$E3, type 4). */
  edits: (flame: boolean) => [number, number[]][]
  /** The names the gate must report, per cart: `dispatch` is the branch-to-the-spawn stage of that cart. */
  stage: 'route' | 'dispatch' | 'loop'
  /** The reason the gate gives: pins that the hack is caught for the right cause. */
  why: RegExp
}

const nop = (n: number): number[] => Array<number>(n).fill(0xea)
const WRAPPER = 0x02f980
const FOREIGN = 0x03a000
const LP = STANDIN.loop + 7
const END = STANDIN.loop + 20

/** The hacked paths a run-to-the-target gate lets through (adversarial review of #1061): each must be flagged. */
export const PATH_HACKS: readonly PathHack[] = [
  {
    name: 'activate flag store removed',
    stage: 'dispatch',
    why: /activate flag is not stored/,
    edits: () => [[STANDIN.entry + 3, nop(3)]],
  },
  {
    name: 'loop skips slot 0',
    stage: 'loop',
    why: /runs code at \$000001/,
    edits: () => [[STANDIN.loop + 6, [1]]],
  },
  {
    name: 'loop visits only 4 slots',
    stage: 'loop',
    why: /runs code at \$000001/,
    edits: () => [[STANDIN.loop + 17, [4]]],
  },
  {
    name: 'CurSpriteProcess store dropped',
    stage: 'loop',
    why: /slot 0 is not the slot drawn/,
    edits: () => [[STANDIN.loop + 7, nop(3)]],
  },
  {
    name: 'dispatch words reach a wrapper that writes a cell',
    stage: 'loop',
    why: /runs code at \$02F980/,
    edits: flame => {
      const draw = flame ? STANDIN.flameDraw : STANDIN.ringDraw
      return [
        [WRAPPER, [0xa9, 0x55, 0x8d, 0xf0, 0x0f, ...jmp(draw)]],
        [tableWord(4), [lo(WRAPPER), hi(WRAPPER)]],
        [tableWord(5), [lo(WRAPPER), hi(WRAPPER)]],
      ]
    },
  },
  {
    name: 'route stub excludes the last id',
    stage: 'route',
    why: /runs code at \$0[02]/,
    edits: flame => [
      [STANDIN.route + 4, [0xc9, flame ? 0xe6 : 0xe3, 0xd0, 0x01, 0x60, ...jmp(STANDIN.routeBody)]],
    ],
  },
  {
    name: 'route drops the _3 hand-off',
    stage: 'route',
    why: /hand-off cell _3/,
    edits: () => [[STANDIN.routeBody + 3, nop(2)]],
  },
  {
    name: 'route returns early after the call',
    stage: 'route',
    why: /runs code at \$0[02]/,
    edits: () => [[STANDIN.routeBody + 8, [0x60]]],
  },
  {
    name: 'route stub depends on the level number',
    stage: 'route',
    why: /runs code at/,
    edits: () => [
      [
        STANDIN.route + 4,
        [0x48, 0xad, 0xbf, 0x13, 0xd0, 0x04, 0x68, ...jmp(STANDIN.routeBody), 0x68, 0x60],
      ],
    ],
  },
  {
    name: 'PHK/PLB removed from the loop wrapper',
    stage: 'loop',
    why: /DB is \$0, not 2/,
    edits: () => [[STANDIN.loop, nop(5)]],
  },
  {
    name: 'route spins',
    stage: 'route',
    why: /did not reach \$02A846 in 3000 steps/,
    edits: () => [[STANDIN.routeBody + 13, [0x80, 0xfe]]],
  },
  {
    name: 'a hook in the loop runs foreign code, then reaches the draw',
    stage: 'loop',
    why: /runs code at \$03A000/,
    edits: () => [
      [STANDIN.loop + 15, [0x22, lo(FOREIGN), hi(FOREIGN), FOREIGN >> 16]],
      [
        FOREIGN,
        [
          0x7a,
          0x7a,
          0x7a,
          0xe8,
          0xe0,
          0x14,
          0xb0,
          0x04,
          0x5c,
          lo(LP),
          hi(LP),
          0x02,
          0x5c,
          lo(END),
          hi(END),
          0x02,
        ],
      ],
    ],
  },
]
