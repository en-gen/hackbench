/**
 * A synthetic loader for SlotPick (#1230): a 62-byte span of filler with the table operands and immediates at the offsets
 * the module reads, over seven small tables. The filler is not the game's code; the fingerprint is taken from this cart.
 */
import { fingerprint } from '../../../src/rom/Fingerprint'
import { RomFile } from '../../../src/rom/RomFile'
import type { CodeFingerprint } from '../../../src/rom/sprites/interp/InitLatches'

export const SPECIAL = 0x41
export const RESERVED1 = 0x23
const AT = 0x02a8e4
const T = {
  max: 0xb000,
  max1: 0xb004,
  max2: 0xb008,
  start: 0xb010,
  start1: 0xb014,
  res1: 0xb018,
  res2: 0xb01c,
} as const

/** Four settings: 0 high top slot, 1 a reserved top for SPECIAL, 2 an ordinary top of 7, 3 a short top with a reserved-1 id. */
export const ROWS = {
  max: [9, 5, 7, 4],
  start: [0xff, 0xff, 0, 0xff],
  res1: [0xff, 0xff, 0xff, RESERVED1],
  max1: [0, 7, 7, 3],
  start1: [0, 0xff, 0, 1],
  res2: [0xff, SPECIAL, 0xff, 0xff],
  max2: [0, 7, 7, 3],
}

export function slotCart(
  mutate: (span: number[]) => void = () => {},
  rows = ROWS,
): { rom: RomFile; spec: CodeFingerprint } {
  const span = Array.from({ length: 62 }, (_, i) => (i * 37 + 11) & 0xff)
  const put = (i: number, a: number) => ((span[i] = a & 0xff), (span[i + 1] = a >> 8))
  put(4, T.max)
  put(7, T.start)
  put(14, T.res1)
  put(19, T.max1)
  put(22, T.start1)
  put(29, T.res2)
  put(44, T.max2) // prettier-ignore
  span[34] = SPECIAL
  span[40] = 0x10
  span[47] = 0xff
  mutate(span)
  const buf = Buffer.alloc(0x80000)
  buf.set(span, 0x10000 + (AT & 0x7fff))
  const tab = (a: number, rows: number[]) => buf.set(rows, 0x10000 + (a & 0x7fff))
  tab(T.max, rows.max)
  tab(T.max1, rows.max1)
  tab(T.max2, rows.max2)
  tab(T.start, rows.start)
  tab(T.start1, rows.start1)
  tab(T.res1, rows.res1)
  tab(T.res2, rows.res2)
  return {
    rom: RomFile.fromBytes('synthetic.sfc', buf),
    spec: { at: AT, length: 62, sha256: fingerprint(Uint8Array.from(span))! },
  }
}
