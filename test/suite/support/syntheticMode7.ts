/**
 * Hand-written stand-ins for the Mode 7 unpack trio, for tests that must run
 * without a cartridge. They are NOT the game's code (docs/testing.md "Legal
 * position"): same shape and operand positions, different bytes, accepted
 * through `SYNTH_MODE7_FINGERPRINTS` the way other gates take injected ones.
 * The helper is real code the 65816 core runs, so it is written to behave
 * (shift a byte left three bits, the bits shifted out going to a second
 * byte) with a different instruction mix from the game's.
 */
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'
import type { Mode7Fingerprints } from '../../../src/rom/Mode7Gfx'

/** Two-byte little-endian operand. */
const le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]

/** Direct-page bytes the synthetic routine reads (IN) and writes the pixel to (OUT). */
export const IN = 0x0e
export const OUT = 0x03

export const UNPACK_MASK = [1, 3, 4, 5, 12, 13, 19, 20, 27, 28, 59, 60, 67, 68, 99, 100, 107, 108]

/** The 118-byte routine: an opening, an LDA of OUT after the first helper call, filler, six JSR slots. */
export function unpackBytes(
  fileIndex: number,
  loopCount: number,
  helper: number,
  io: { input?: number; output?: number } = {},
): number[] {
  // Varied filler, not a NOP run: an 8-byte run of one value is common in a real ROM.
  const b = Array.from({ length: 118 }, (_, i) => (i * 29 + 5) & 0xff)
  const set = (at: number, ...v: number[]): void => void v.forEach((x, i) => (b[at + i] = x))
  set(0, 0xa0, fileIndex, 0x22, 0x10, 0x80, 0x03, 0xc2, 0x30, 0xa0, 0x01, 0x00, 0xa2)
  set(12, ...le(loopCount))
  set(14, 0xb7, 0x01, 0x85, io.input ?? IN)
  for (const at of [18, 26, 58, 66, 98, 106]) set(at, 0x20, ...le(helper))
  set(21, 0xa5, io.output ?? OUT)
  return b
}

/** Helper variants; the default shifts IN left 3 and leaves the bits shifted out in OUT. */
export interface HelperShape {
  /** LSR count that makes the pixel (5 is right). */
  lsrs?: number
  /** ASL count on the input (3 is right). */
  asls?: number
  /** Extra direct-page byte it also stores to. */
  strayStore?: number
  /** End with an infinite loop instead of RTS. */
  hang?: boolean
  /** STA $2119 before returning: a hardware write. */
  hwStore?: boolean
  /** STA long into cart SRAM ($700000). */
  sramStore?: boolean
  /** ORA into OUT instead of overwriting it. */
  orOut?: boolean
  /** Read a byte other than IN: LDA $13, and return early unless it is zero. */
  readsOther?: boolean
  /** Do the shifts with the loop counter in a 16-bit X (PHX / LDX #3 / DEX / BNE / PLX). */
  wideX?: boolean
  /** CPY #$0100 / BCC: return early when Y is at least $0100 (state-dependent). */
  readsY?: boolean
  /** LDA $4212 / BNE +0: a hardware READ with no effect on the result. */
  hwRead?: boolean
  /** End with RTL, the wrong return for a JSR. */
  rtl?: boolean
}

/** Helper code for the synthetic cart: shifts IN left three into OUT's bits, with `shape` planting one defect. */
export function helperBytes(shape: HelperShape = {}): number[] {
  const { lsrs = 5, asls = 3 } = shape
  const shifts = shape.wideX
    ? [0xda, 0xa2, asls, 0x00, 0x06, IN, 0xca, 0xd0, 0xfb, 0xfa]
    : Array.from({ length: asls }, () => [0x06, IN]).flat()
  return [
    ...(shape.readsY ? [0xc0, 0x00, 0x01, 0x90, 0x01, 0x60] : []),
    ...(shape.hwRead ? [0xad, 0x12, 0x42, 0xd0, 0x00] : []),
    ...(shape.readsOther ? [0xa5, 0x13, 0xf0, 0x01, 0x60] : []),
    0xa5, IN,
    ...new Array<number>(lsrs).fill(0x4a),
    ...(shape.orOut ? [0x05, OUT] : []),
    0x85, OUT,
    ...(shape.strayStore === undefined ? [] : [0x85, shape.strayStore]),
    ...(shape.hwStore ? [0x8d, 0x19, 0x21] : []),
    ...(shape.sramStore ? [0x8f, 0x00, 0x00, 0x70] : []),
    ...shifts,
    ...(shape.hang ? [0x80, 0xfe] : shape.rtl ? [0x6b] : [0x60]),
  ]
} // prettier-ignore

/** The same effect with a different instruction mix: ASL A and a store back to IN. */
export const ALT_HELPER = [
  0xa5, IN, 0x4a, 0x4a, 0x4a, 0x4a, 0x4a, 0x85, OUT, 0xa5, IN, 0x0a, 0x0a, 0x0a, 0x85, IN, 0x60,
] // prettier-ignore

/** A branch over a JSR to `target` (BEQ +3, JSR), then filler. */
export const callSiteBytes = (target: number): number[] => [
  0xf0, 0x03, 0x20, ...le(target), 0xea, 0xea, 0xea,
] // prettier-ignore

/** The one fingerprint that accepts the synthetic routine, so tests need no ROM. */
export const SYNTH_MODE7_FINGERPRINTS: Mode7Fingerprints = {
  unpack: [spanFingerprint(Uint8Array.from(unpackBytes(0, 0, 0)), UNPACK_MASK)!],
}
