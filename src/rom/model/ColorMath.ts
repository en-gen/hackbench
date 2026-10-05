/**
 * ColorMath.ts: the SNES color math stage for one screen (#562). Pure; the
 * frontend reruns it on every layer toggle. CGWSEL is $02 (add the sub screen,
 * bank_00.asm:1285), so windows, clip and prevent are not modeled.
 *
 * Half against the fixed color: when the sub screen drew nothing the fixed color
 * is used and the half bit is ignored. snes9x tileimpl.h:176-181 (MATHS1_2::Calc:
 * halve only when `SD & 0x20`, else plain add with GFX.FixedColour) and bsnes
 * sfc/ppu-fast/line.cpp:111 (`below.source != Source::COL`). Both read from
 * GitHub master on 2026-10-05; not run against hardware.
 *
 * Participation in math is keyed by layer (LAYER_BIT), so OBJ (bit $10, palettes
 * 4-7 only, #564) arrives later as one more input plane, not a redesign.
 */
import type { PlaneKey, ScreenPlanes } from './ScreenPlanes'

export type Rgb = readonly [number, number, number]
export interface ColorMathInput {
  cgadsub: number
  fixed: Rgb
}
export interface ScreenInput {
  width: number
  height: number
  planes: Partial<Record<PlaneKey, Uint8ClampedArray | null>>
  lists: ScreenPlanes
  math: ColorMathInput | null
}

const LAYER_BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
const BACKDROP_BIT = 0x20
const SUBTRACT = 0x80
const HALF = 0x40
const BG3 = 0x04
/** CGRAM color 0 is cleared before every palette upload (CODE_00922F, bank_00.asm:2046-2049). */
const BACKDROP: Rgb = [0, 0, 0]

/** CGADSUB as the game leaves it: the table value minus BG3 where CODE_009FB8 clears it. */
export const effectiveCgadsub = (table: number, bg3Cleared: boolean): number =>
  bg3Cleared ? table & ~BG3 & 0xff : table

const to5 = (c: number) => c >> 3
const to8 = (v: number) => (v << 3) | (v >> 2)

/** The topmost opaque pixel of a list at byte offset `at`: its color and layer bit, or null. */
function top(i: ScreenInput, list: readonly PlaneKey[], at: number) {
  for (let k = list.length - 1; k >= 0; k--) {
    const data = i.planes[list[k]!]
    if (data && data[at + 3] !== 0) {
      const rgb: Rgb = [data[at]!, data[at + 1]!, data[at + 2]!]
      return { rgb, bit: LAYER_BIT[list[k]!.slice(0, 2) as keyof typeof LAYER_BIT] }
    }
  }
  return null
}

/** One channel in 5-bit space: add or subtract, optionally halve, clamp to 31. */
function channel(main: number, sub: number, cgadsub: number, half: boolean): number {
  let r = cgadsub & SUBTRACT ? Math.max(to5(main) - to5(sub), 0) : to5(main) + to5(sub)
  if (half) r >>= 1
  return to8(Math.min(r, 31))
}

export function composeScreen(i: ScreenInput): Uint8ClampedArray {
  const out = new Uint8ClampedArray(i.width * i.height * 4)
  const math = i.math
  for (let p = 0; p < i.width * i.height; p++) {
    const at = p * 4
    const main = top(i, i.lists.main, at)
    // Unverified tables (no math): the stack as is, the back area showing where nothing draws.
    // Sub is ignored: every math-null verdict carries FALLBACK_SCREENS, whose sub list is empty.
    if (!math) {
      if (main) out.set([...main.rgb, 255], at)
      continue
    }
    const sub = top(i, i.lists.sub, at)
    let res: Rgb = main ? main.rgb : BACKDROP
    if (math.cgadsub & (main ? main.bit : BACKDROP_BIT)) {
      const s: Rgb = sub ? sub.rgb : math.fixed
      // No half against the fixed color: see the header.
      const half = !!(math.cgadsub & HALF) && sub !== null
      const c = math.cgadsub
      res = [channel(res[0], s[0], c, half), channel(res[1], s[1], c, half), channel(res[2], s[2], c, half)] // prettier-ignore
    }
    // Nothing drew on either screen and the result is the fixed color: that is the back area,
    // which the view shows as a layer of its own, so stay transparent.
    const f = math.fixed
    // Compared in 5-bit space, where the PPU adds.
    if (!main && !sub && [0, 1, 2].every(k => to5(res[k]!) === to5(f[k]!))) continue
    out.set([res[0], res[1], res[2], 255], at)
  }
  return out
}
