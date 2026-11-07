/**
 * A synthetic cart for MapMotion: the two call sites the motion run follows and hand-written scroll
 * routines of its own, sharing no instruction run with the vanilla ROM. 1 MiB LoROM, headerless.
 */
import { RomFile } from '../../../src/rom/RomFile'

export type MotionRoutine = 'rise' | 'touch' | 'idle' | 'brk' | 'sideways' | 'follow'

export interface MotionCartOptions {
  routine: MotionRoutine
  /** The per-frame step the routine adds, read by the routine from a ROM word. */
  step?: number
  /** Break the call site: the first scroll call becomes a JMP. */
  badSite?: boolean
  /** Break the destination: the screen routine no longer opens with PHB. */
  badCallee?: boolean
}

const SCREEN = 0x008100
const SCROLL = 0x058100
const STEP_WORD = 0x05a000
const off = (a: number) => (a >> 16) * 0x8000 + (a & 0x7fff)

/** Copies NextLayer1/2 X/Y into $1A..$20 (long loads, bottom up), the real routine's effect written differently. */
const SCREEN_CODE = [
  0x8b, 0xc2, 0x20, 0xaf, 0x68, 0x14, 0x00, 0x85, 0x20, 0xaf, 0x66, 0x14, 0x00, 0x85, 0x1e, 0xaf,
  0x64, 0x14, 0x00, 0x85, 0x1c, 0xaf, 0x62, 0x14, 0x00, 0x85, 0x1a, 0xe2, 0x20, 0xab, 0x6b,
]

/** Adds the ROM's step word to the cell at `cell` until it reaches $0100. */
const rise = (cell: number): number[] => [
  0xad,
  cell & 255,
  cell >> 8,
  0xc9,
  0x00,
  0x01,
  0xb0,
  0x08,
  0x18,
  0x6f,
  0x00,
  0xa0,
  0x05,
  0x8d,
  cell & 255,
  cell >> 8,
]

const ROUTINES: Record<MotionRoutine, number[]> = {
  // Layer 2 Y rises by the step, whatever Mario does.
  rise: [0x8b, 0xc2, 0x20, ...rise(0x1468), 0xe2, 0x20, 0xab, 0x6b],
  // The same, only while $140E is nonzero.
  touch: [0x8b, 0xc2, 0x20, 0xad, 0x0e, 0x14, 0xf0, 0x10, ...rise(0x1468), 0xe2, 0x20, 0xab, 0x6b],
  idle: [0x8b, 0xab, 0x6b],
  brk: [0x8b, 0x00, 0x00],
  // Layer 2 X rises: sideways against the screen.
  sideways: [0x8b, 0xc2, 0x20, ...rise(0x1466), 0xe2, 0x20, 0xab, 0x6b],
  // Layer 1 and Layer 2 Y rise together.
  follow: [
    0x8b,
    0xc2,
    0x20,
    ...rise(0x1468),
    0xad,
    0x68,
    0x14,
    0x8d,
    0x64,
    0x14,
    0xe2,
    0x20,
    0xab,
    0x6b,
  ],
}

export function motionCart(o: MotionCartOptions): RomFile {
  const bytes = new Uint8Array(0x100000)
  bytes.set(SCREEN_CODE, off(SCREEN))
  if (o.badCallee) bytes[off(SCREEN)] = 0xea
  bytes.set(ROUTINES[o.routine], off(SCROLL))
  bytes[off(STEP_WORD)] = o.step ?? 3
  const jsl = (at: number, to: number) =>
    bytes.set([0x22, to & 255, (to >> 8) & 255, to >> 16], off(at))
  jsl(0x00a299, SCREEN)
  jsl(0x00a29d, SCROLL)
  if (o.badSite) bytes[off(0x00a29d)] = 0x5c
  return RomFile.fromBytes('synthetic-motion.sfc', bytes)
}

/** A loaded map's WRAM with one scroll command set. */
export function motionWram(cmd = 1): Uint8Array {
  const w = new Uint8Array(0x20000)
  w[0x143e] = cmd
  return w
}
