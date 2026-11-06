/**
 * A synthetic loader for SlotPick (#1230): a 62-byte span of filler with the table operands and immediates at the offsets
 * the module reads, over seven small tables. The filler and the table numbers are not the
 * game's; the fingerprint is taken from this cart. The special id is the one id the call-site tests list ($64, a sprite id,
 * not a ROM byte table); every other number differs from the vanilla rows.
 */
import { fingerprint } from '../../../src/rom/Fingerprint'
import { RomFile } from '../../../src/rom/RomFile'
import type { CodeFingerprint } from '../../../src/rom/sprites/interp/InitLatches'

export const SPECIAL = 0x64
export const RESERVED1 = 0x2d
/** A second reserved id that is not the special one: it takes its reserved range whatever the coordinate. */
export const OTHER_RESERVED2 = 0x2e
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

/** Four settings: 0 a high top slot, 1 a reserved top (SPECIAL on an odd coordinate), 2 an ordinary top shared with others and a plain reserved-2 id, 3 a reserved-1 id. */
export const ROWS = {
  max: [10, 4, 6, 3],
  start: [0xff, 0xff, 1, 0xff],
  res1: [0xff, 0xff, 0xff, RESERVED1],
  max1: [0, 6, 6, 2],
  start1: [0, 0xff, 1, 0],
  res2: [0xff, SPECIAL, OTHER_RESERVED2, 0xff],
  max2: [0, 6, 5, 0],
}

export function slotCart(
  mutate: (span: number[]) => void = () => {},
  rows = ROWS,
  size = 0x80000,
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
  const buf = Buffer.alloc(size)
  buf.set(span, 0x10000 + (AT & 0x7fff))
  const tab = (a: number, r: number[]) =>
    0x10000 + (a & 0x7fff) + r.length <= size && buf.set(r, 0x10000 + (a & 0x7fff))
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
