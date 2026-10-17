/**
 * Hand-written stand-ins for the Mode 7 unpack trio, for tests that must run
 * without a cartridge. They are NOT the game's code (docs/testing.md "Legal
 * position"): same shape and operand positions, different bytes (the opening
 * too, so the stock opening fingerprint never matches these), accepted
 * through `SYNTH_MODE7_FINGERPRINTS` the way other gates take injected ones.
 */
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'
import type { Mode7Fingerprints } from '../../../src/rom/Mode7Gfx'

const le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
const NOP = 0xea

/** The 118-byte routine: the locating opening, then NOPs with six JSR slots. */
export function unpackBytes(fileIndex: number, loopCount: number, helper: number): number[] {
  const b = new Array<number>(118).fill(NOP)
  const set = (at: number, ...v: number[]): void => void v.forEach((x, i) => (b[at + i] = x))
  set(0, 0xa0, fileIndex, 0x22, 0x10, 0x80, 0x03, 0xc2, 0x30, 0xa0, 0x01, 0x00, 0xa2)
  set(12, ...le(loopCount))
  set(14, 0xb7, 0x01, 0x85, 0x0e)
  for (const at of [18, 26, 58, 66, 98, 106]) set(at, 0x20, ...le(helper))
  return b
}

/** 15 bytes, ends in RTS. */
export const HELPER = [0xa9, 0x01, 0x8d, 0x00, 0x21, ...new Array<number>(9).fill(NOP), 0x60]

/** 12 bytes: a branch over a JSR to `target`, then filler with a 2-byte operand at the end. */
export const callSiteBytes = (target: number): number[] => [
  0xf0, 0x06, 0x20, ...le(target), ...new Array<number>(5).fill(NOP), 0x05, 0x01,
] // prettier-ignore

export const SYNTH_MODE7_FINGERPRINTS: Mode7Fingerprints = {
  opening: [
    spanFingerprint(Uint8Array.from(unpackBytes(0, 0, 0).slice(0, 18)), [1, 3, 4, 5, 12, 13])!,
  ],
  unpack: [
    spanFingerprint(
      Uint8Array.from(unpackBytes(0, 0, 0)),
      [1, 3, 4, 5, 12, 13, 19, 20, 27, 28, 59, 60, 67, 68, 99, 100, 107, 108],
    )!,
  ],
  helper: [spanFingerprint(Uint8Array.from(HELPER))!],
  call: [spanFingerprint(Uint8Array.from(callSiteBytes(0)), [3, 4, 10, 11])!],
}
