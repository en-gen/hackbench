/**
 * The call path from a level's sprite list to the cluster spawns and draws (castle flames $E6, rotating
 * ring $E2/$E3), written for a synthetic cart: INVENTED code that is not the game's, at addresses that are
 * not the game's (D126, FINGERPRINT MINIMUM rule 9). A byte-for-byte match with the ROM at 5 or more bytes
 * is checked by ClusterPathStandInNoVanilla.test.ts against the vanilla ROM (one machine, one image). The
 * gate in ClusterPath.ts runs this code on the core; `STANDIN_LAYOUT` tells it where this cart keeps it.
 * Evidence scope: synthetic bytes; the vanilla ROM's own path is proven in the corpus blocks.
 */
import type { ClusterLayout } from '../../../src/rom/sprites/interp/CastleFlames'
import { SYNTHETIC_EXECUTE_PTR_CODE } from './syntheticSpriteRom'

const lo = (a: number): number => a & 0xff
const hi = (a: number): number => (a >> 8) & 0xff
const jsl = (to: number): number[] => [0x22, lo(to), hi(to), (to >> 16) & 0xff]
const jmp = (to: number): number[] => [0x4c, lo(to), hi(to)]
const jsr = (to: number): number[] => [0x20, lo(to), hi(to)]

export const STANDIN = {
  /** The route's head: a free address, not the shell loader site the synthetic cart keeps at $02A8C0. */
  route: 0x02f860,
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
    [STANDIN.routeBody, STANDIN.routeBody + 17],
  ],
  entry: [STANDIN.entry, STANDIN.entry + 29],
  loop: [STANDIN.loop, STANDIN.loop + 28],
  dispatch: STANDIN.dispatch,
  // The cart's ExecutePtr keeps its pointer and index in $08-$0D (the game's uses $00-$03).
  scratch: [0x08, 0x0e],
  exits: [],
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
    0x8b, 0xa2, 0x02, 0xda, 0xab,               // PHB / LDX #2 / PHX / PLB: DB = 2
    0xa2, 0x00,                                 // LDX #0
    0xbd, 0x92, 0x18,                           // lp: LDA ClusterSpriteNumber,X
    0xd0, 0x07,                                 // BNE call
    0xe8, 0xe0, 0x14,                           // nx: INX / CPX #$14
    0x90, 0xf6,                                 // BCC lp
    0xab, 0x6b,                                 // PLB / RTL
    0x8e, 0xe9, 0x15,                           // call: STX CurSpriteProcess
    ...call,
    0x80, o.fastRom ? 0xf0 : 0xf1,              // BRA nx
  ]
  return [
    // route: four NOPs, then a jump to the body, which keeps X on the stack, hands Y less one to the
    // spawn in $03, and restores both
    [s.route, [0xea, 0xea, 0xea, 0xea, ...jmp(s.routeBody)]],
    [
      s.routeBody,
      [
        0xda,
        0xea,
        0x84,
        0x03,
        0xc6,
        0x03,
        ...jsr(s.entry),
        0xfa,
        0xea,
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
        0xa2,
        0x01,
        0x8e,
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
/** DEX / BPL lp / NOP / NOP: the loop's tail counting down. */
export const COUNT_DOWN = [0xca, 0x10, 0xf8, 0xea, 0xea]
const WRAPPER = 0x02f980
const FOREIGN = 0x03a000
const LP = STANDIN.loop + 7
const END = STANDIN.loop + 17
/** LDX #0 / LDY #0 / RTS: a spawn that, like the game's, leaves X and Y changed for the route to restore. */
export const SPAWN_STUB = [0xa2, 0x00, 0xa0, 0x00, 0x60]
/** Loop offsets the loop hacks edit: the LDX operand, and the INX/CPX/BCC tail. */
const INIT = STANDIN.loop + 5
const TAIL = STANDIN.loop + 12
/** The dispatch JSL's operand, and a place for a wrapper before and one after the cart's ExecutePtr. */
const JSL_OPERAND = STANDIN.dispatch + 1
const WRAP_NEAR = STANDIN.execPtr + 0x100
const WRAP_FAR = STANDIN.execPtr - 0x100
/** An invented slot-order table for the out-of-order loop, in the stand-in's bank. */
const ORDER = 0x02fe00
const long = (to: number): number[] => [lo(to), hi(to), to >> 16]

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
    why: /drew slots 1 2 3/,
    edits: () => [[STANDIN.loop + 6, [1]]],
  },
  {
    name: 'loop visits only 4 slots',
    stage: 'loop',
    why: /drew slots 0 1 2 3\)/,
    edits: () => [[STANDIN.loop + 14, [4]]],
  },
  {
    name: 'CurSpriteProcess store dropped',
    stage: 'loop',
    why: /slot 0 is not the slot drawn/,
    edits: () => [[STANDIN.loop + 19, nop(3)]],
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
    edits: () => [[STANDIN.routeBody + 2, nop(2)]],
  },
  {
    name: 'route returns early after the call',
    stage: 'route',
    why: /runs code at \$0[02]/,
    edits: () => [[STANDIN.routeBody + 9, [0x60]]],
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
    edits: () => [[STANDIN.routeBody + 14, [0x80, 0xfe]]],
  },
  {
    name: 'a hook in the loop runs foreign code, then reaches the draw',
    stage: 'loop',
    why: /runs code at \$03A000/,
    edits: () => [
      [STANDIN.loop + 12, [0x22, lo(FOREIGN), hi(FOREIGN), FOREIGN >> 16]],
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

  {
    name: 'route leaves a byte on the stack',
    stage: 'route',
    why: /stack, X or Y/,
    edits: () => [[STANDIN.routeBody + 1, [0xda]]],
  },
  {
    name: 'route writes a cell before the spawn',
    stage: 'route',
    why: /writes WRAM \$0020/,
    edits: () => [[STANDIN.route, [0x64, 0x20, 0xea, 0xea]]],
  },
  {
    name: 'route has a branch to foreign code that no seed takes',
    stage: 'route',
    why: /branch at \$02F862 goes to \$02F8E2/,
    edits: () => [[STANDIN.route, [0xc0, 0x55, 0xf0, 0x7e]]],
  },
  {
    // Seed 2 alone sets bit 7 of $25: the branch lands in the jump's operand, inside the span.
    name: 'route branches on game state into its own jump',
    stage: 'route',
    why: /BRK executed/,
    edits: () => [[STANDIN.route, [0x24, 0x25, 0x30, 0x01]]],
  },
  {
    // CPX / BEQ over the jump's opcode: only the setting with X = 0 takes it, into the jump's operand.
    name: 'route branches when X is zero into its own jump',
    stage: 'route',
    why: /BRK executed/,
    edits: () => [[STANDIN.route, [0xe0, 0x00, 0xf0, 0x01]]],
  },
  {
    name: 'route branches when X is $80 or more into its own jump',
    stage: 'route',
    why: /BRK executed/,
    edits: () => [[STANDIN.route, [0xe0, 0x80, 0xb0, 0x01]]],
  },
  {
    name: 'route branches when Y is 1 into its own jump',
    stage: 'route',
    why: /BRK executed/,
    edits: () => [[STANDIN.route, [0xc0, 0x01, 0xf0, 0x01]]],
  },
  {
    // Only a store makes the cell 1 from both 0 and $FF: an increment gets one of them.
    name: 'activate flag incremented, not stored',
    stage: 'dispatch',
    why: /activate flag is not stored/,
    edits: () => [[STANDIN.entry + 3, [0xee, 0xb8, 0x18]]],
  },
  {
    name: 'loop calls the draw by a jump',
    stage: 'loop',
    why: /./,
    edits: () => [[STANDIN.loop + 22, [0x4c]]],
  },
  {
    name: 'loop steps two slots at a time',
    stage: 'loop',
    why: /drew slots 19 17 15/,
    edits: () => [
      [INIT + 1, [0x13]],
      [TAIL, [0xca, 0xca, 0x10, 0xf7, 0xea]],
    ],
  },
  {
    // Same 28 bytes: Y counts 20 steps and the slot is read from an invented table (stride 7 mod 20), so
    // every slot is drawn once and only the order is wrong; slot 0 first, so it is not read as a count down.
    name: 'loop visits every slot once, out of order',
    stage: 'loop',
    why: /drew slots 0 7 14 1 8/,
    edits: () => [
      [STANDIN.loop + 5, [0xa0, 0x00, 0xbe, lo(ORDER), hi(ORDER), 0xbd, 0x92, 0x18, 0xf0, 0x06]],
      [
        STANDIN.loop + 15,
        [0x8e, 0xe9, 0x15, ...jsr(STANDIN.dispatch), 0xc8, 0xc0, 0x14, 0x90, 0xed, 0xab, 0x6b],
      ],
      [ORDER, Array.from({ length: 20 }, (_, i) => (i * 7) % 20)],
    ],
  },
  {
    name: 'loop counts down from the X it was entered with',
    stage: 'loop',
    why: /drew slots 11 10 9/,
    edits: () => [
      [STANDIN.loop + 1, [0x4b, 0xab, 0xea, 0xea]],
      [INIT, nop(2)],
      [TAIL, COUNT_DOWN],
    ],
  },
  {
    name: 'loop does not restore DB',
    stage: 'loop',
    why: /DB is not restored/,
    edits: () => [[STANDIN.loop + 17, [0x68]]],
  },
  {
    name: 'dispatch call goes to a wrapper that writes a cell, then runs a copy of ExecutePtr',
    stage: 'loop',
    why: /writes WRAM \$0FF0/,
    edits: () => [
      [JSL_OPERAND, long(WRAP_NEAR)],
      [WRAP_NEAR, [0xee, 0xf0, 0x0f, ...SYNTHETIC_EXECUTE_PTR_CODE]],
    ],
  },
  {
    name: 'dispatch call goes to a wrapper that jumps to ExecutePtr from outside its span',
    stage: 'loop',
    why: /runs code at \$0086FA/,
    edits: () => [
      [JSL_OPERAND, long(WRAP_FAR)],
      [WRAP_FAR, jmp(STANDIN.execPtr)],
    ],
  },
]
