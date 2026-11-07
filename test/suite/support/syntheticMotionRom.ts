/**
 * A synthetic cart for MapMotion: the two call sites the motion run follows and hand-written scroll
 * routines of its own, sharing no instruction run with the vanilla ROM. 1 MiB LoROM, headerless.
 * Routines are hex text so the formatter leaves them alone; the comments name the instructions.
 */
import { RomFile } from '../../../src/rom/RomFile'

export type MotionRoutine =
  | 'rise' // Layer 2 Y rises by the ROM's step word, whatever Mario does
  | 'touch' // the same, only while $140E is nonzero
  | 'camTouch' // only while touched, the camera is a screen in and Mario's X is past $0180
  | 'camOnly' // the same rise, only once the camera is a screen in (no touch read)
  | 'counterTouch' // only while touched and a frame counter has passed 100
  | 'late' // rises once a frame counter has passed 150
  | 'marioDrive' // rises, and Layer 1 Y copies Mario's Y
  | 'followx' // the camera X rises and Layer 2 X follows it
  | 'idle'
  | 'brk'
  | 'sideways' // Layer 2 X rises alone
  | 'follow' // Layer 1 and Layer 2 Y rise together

export interface MotionCartOptions {
  routine: MotionRoutine
  /** The per-frame step the routine adds, read by the routine from a ROM word. */
  step?: number
  /** Break the call site: the first scroll call becomes a JMP. */
  badSite?: boolean
  /** Break the destination: the screen routine no longer opens with PHB. */
  badCallee?: boolean
  /** Name both routines through the $80 mirror banks. */
  mirror?: boolean
}

export const SCREEN = 0x008100
export const SCROLL = 0x058100
const STEP_WORD = 0x05a000
const off = (a: number) => (a >> 16) * 0x8000 + (a & 0x7fff)
const hex = (s: string): number[] =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map(h => parseInt(h, 16))

/** PHB, REP #$20: the 16-bit opening; SEP #$20, PLB, RTL: the closing. */
const OPEN = '8b c2 20'
const CLOSE = 'e2 20 ab 6b'

/** Copies NextLayer1/2 X/Y into $1A..$20 (long loads, bottom up), the real routine's effect written differently. */
const SCREEN_CODE = hex(
  `${OPEN} af 68 14 00 85 20 af 66 14 00 85 1e af 64 14 00 85 1c af 62 14 00 85 1a ${CLOSE}`,
)

/** LDA cell, CMP #$0100, BCS +8, CLC, ADC.L step, STA cell: adds the ROM's step word until the cell reaches $0100. */
const rise = (cell: number): string => {
  const [lo, hi] = [cell & 255, cell >> 8].map(v => v.toString(16))
  return `ad ${lo} ${hi} c9 00 01 b0 08 18 6f 00 a0 05 8d ${lo} ${hi}`
}

const ROUTINES: Record<MotionRoutine, string> = {
  rise: `${OPEN} ${rise(0x1468)} ${CLOSE}`,
  // LDA $140E, BEQ over the rise
  touch: `${OPEN} ad 0e 14 f0 10 ${rise(0x1468)} ${CLOSE}`,
  // LDA $140E BEQ; LDA $1462 CMP #$0100 BCC; LDA $94 CMP #$0180 BCC; rise
  camTouch: `${OPEN} ad 0e 14 f0 1f ad 62 14 c9 00 01 90 17 a5 94 c9 80 01 90 10 ${rise(0x1468)} ${CLOSE}`,
  // LDA $1462 CMP #$0100 BCC; rise
  camOnly: `${OPEN} ad 62 14 c9 00 01 90 10 ${rise(0x1468)} ${CLOSE}`,
  // counter at $1500: LDA, INC, STA; LDA $140E BEQ; LDA counter CMP #$0064 BCC; rise
  counterTouch: `${OPEN} ad 00 15 1a 8d 00 15 ad 0e 14 f0 18 ad 00 15 c9 64 00 90 10 ${rise(0x1468)} ${CLOSE}`,
  // counter: LDA, INC, STA, CMP #$0096 BCC; rise
  late: `${OPEN} ad 00 15 1a 8d 00 15 c9 96 00 90 10 ${rise(0x1468)} ${CLOSE}`,
  // rise, then LDA $96 (Mario's Y) STA $1464 (NextLayer1Y)
  marioDrive: `${OPEN} ${rise(0x1468)} a5 96 8d 64 14 ${CLOSE}`,
  // rise the camera X, then copy it to NextLayer2X
  followx: `${OPEN} ${rise(0x1462)} ad 62 14 8d 66 14 ${CLOSE}`,
  idle: '8b ab 6b',
  brk: '8b 00 00',
  sideways: `${OPEN} ${rise(0x1466)} ${CLOSE}`,
  // rise, then copy NextLayer2Y to NextLayer1Y
  follow: `${OPEN} ${rise(0x1468)} ad 68 14 8d 64 14 ${CLOSE}`,
}

export function motionCart(o: MotionCartOptions): RomFile {
  const bytes = new Uint8Array(0x100000)
  bytes.set(SCREEN_CODE, off(SCREEN))
  if (o.badCallee) bytes[off(SCREEN)] = 0xea
  bytes.set(hex(ROUTINES[o.routine]), off(SCROLL))
  bytes[off(STEP_WORD)] = o.step ?? 3
  const bank = o.mirror ? 0x80 : 0
  const jsl = (at: number, to: number) =>
    bytes.set([0x22, to & 255, (to >> 8) & 255, (to >> 16) | bank], off(at))
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
