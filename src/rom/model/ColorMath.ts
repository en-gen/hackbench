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
import { doorFlip, hiddenPixelStrength } from '../render/HiddenTiles'
import type { ListKey } from './ScreenPlanes'

export type Rgb = readonly [number, number, number]
export interface ColorMathInput {
  cgadsub: number
  fixed: Rgb
}
/** A plane, or the sprite layer (#564): a source the lists can name. */
export type SourceKey = ListKey
export interface ScreenInput {
  width: number
  height: number
  planes: Partial<Record<SourceKey, Uint8ClampedArray | null>>
  lists: { main: readonly SourceKey[]; sub: readonly SourceKey[] }
  math: ColorMathInput | null
  /**
   * Per pixel, 0 or (sprite id << 1 | its (x + y) parity on the sprite's own grid): a sprite pixel
   * a tile covers then draws through that tile in the hidden-tile screen door (D52, #795).
   * Every priority draws under a tile, as the hardware orders them (D52 part 2). Main screen only.
   */
  doors?: Uint32Array | null
  /**
   * The swap decision per door id when `doors` is a cropped or scaled view of a larger screen, whose own
   * pixels would not give the screen's counts (`doorFlips` over the native input). Default: counted here.
   */
  flips?: Map<number, boolean>
  /** The door id (sprite) under the pointer: its covered pixels draw at full strength, not through the door (#879). */
  lift?: number
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

/**
 * The pixel a list shows at byte offset `at`: its color, coverage (0..1) and the layer bit of the
 * topmost plane that drew. A partial-alpha pixel (the hidden-tile screen door, an editor dim and not
 * hardware) is blended over the planes beneath it in the list, as the old plane stack did.
 * The topmost plane's CGADSUB membership then applies to the blend: an editor affordance, not
 * hardware, and it differs only when the two layers differ in membership.
 */
function top(i: ScreenInput, list: readonly SourceKey[], at: number, flips?: Map<number, boolean>) {
  let sum = [0, 0, 0]
  let cover = 0
  let bit = 0
  let k = list.length - 1
  for (; k >= 0 && cover < 1; k--) {
    const data = i.planes[list[k]!]
    const a = data ? data[at + 3]! / 255 : 0
    if (!data || a === 0) continue
    // Sprites take no part in color math yet: palettes 4-7 only (snes9x gfx.cpp:819) needs the
    // sprite palette split, which #564's pixels do not carry.
    if (cover === 0) bit = list[k]!.startsWith('sprites') ? 0 : LAYER_BIT[list[k]!.slice(0, 2) as keyof typeof LAYER_BIT] // prettier-ignore
    const w = a * (1 - cover)
    sum = sum.map((v, c) => v + data[at + c]! * w)
    cover += w
  }
  if (cover === 0) return null
  let rgb = sum.map(v => Math.round(v / cover)) as unknown as Rgb
  const door = flips && coveredSprite(i, list, at, k)
  if (door) {
    const d = i.doors![at / 4]!
    const w = d >> 1 === i.lift ? 1 : hiddenPixelStrength(d & 1, 0, flips.get(d >> 1))
    rgb = rgb.map((v, c) => Math.round(v * (1 - w) + door[c]! * w)) as unknown as Rgb
  }
  return { rgb, cover, bit }
}

/**
 * The placed sprite pixel (its RGB) a fully covering tile hides, or null; the Layer 2 flame planes
 * (`spritesL2*`, #894) are not placed sprites and are skipped. `k` is the list slot below the
 * covering plane (the scan stopped at k + 1).
 */
function coveredSprite(i: ScreenInput, list: readonly SourceKey[], at: number, k: number) {
  if (!i.doors || !i.doors[at / 4]! || k + 1 >= list.length) return null
  for (; k >= 0; k--) {
    const key = list[k]!
    const data = i.planes[key]
    if (!key.startsWith('sprites') || key.startsWith('spritesL2') || !data || data[at + 3] === 0)
      continue
    return data.subarray(at, at + 3)
  }
  return null
}

/** Per covered sprite, whether its door squares are swapped: the rule `overlayHidden` applies to a tile, over the covered pixels. */
export function doorFlips(i: ScreenInput): Map<number, boolean> | undefined {
  const doors = i.doors
  if (!doors) return undefined
  const counts = new Map<number, [number, number]>()
  for (let p = 0; p < doors.length; p++) {
    if (!doors[p]) continue
    const list = i.lists.main
    let k = list.length - 1
    for (let cover = 0; k >= 0 && cover < 1; k--) cover += (i.planes[list[k]!]?.[p * 4 + 3] ?? 0) / 255 * (1 - cover) // prettier-ignore
    if (!coveredSprite(i, list, p * 4, k)) continue
    const c = counts.get(doors[p]! >> 1) ?? [0, 0]
    c[hiddenPixelStrength(doors[p]! & 1, 0) === 1 ? 0 : 1]++
    counts.set(doors[p]! >> 1, c)
  }
  return new Map([...counts].map(([id, [full, dim]]) => [id, doorFlip(full, dim)]))
}

/** One channel in 5-bit space: add or subtract, optionally halve, clamp to 31. */
function channel(main: number, sub: number, cgadsub: number, half: boolean): number {
  let r = cgadsub & SUBTRACT ? Math.max(to5(main) - to5(sub), 0) : to5(main) + to5(sub)
  if (half) r >>= 1
  return to8(Math.min(r, 31))
}

type Layer = NonNullable<ReturnType<typeof top>>

/** One pixel through CGADSUB: `main` (null: the black backdrop) plus the sub pixel or the fixed color. */
function mathPixel(math: ColorMathInput, main: Layer | null, sub: Layer | null): Rgb {
  const res: Rgb = main ? main.rgb : BACKDROP
  if (!(math.cgadsub & (main ? main.bit : BACKDROP_BIT))) return res
  const s: Rgb = sub ? sub.rgb : math.fixed
  // No half against the fixed color: see the header.
  const half = !!(math.cgadsub & HALF) && sub !== null
  const c = math.cgadsub
  return [channel(res[0], s[0], c, half), channel(res[1], s[1], c, half), channel(res[2], s[2], c, half)] // prettier-ignore
}

export function composeScreen(i: ScreenInput): Uint8ClampedArray {
  const out = new Uint8ClampedArray(i.width * i.height * 4)
  const math = i.math
  const flips = i.flips ?? doorFlips(i)
  for (let p = 0; p < i.width * i.height; p++) {
    const at = p * 4
    const main = top(i, i.lists.main, at, flips)
    // Unverified tables (no math): the stack as is, the back area showing where nothing draws.
    // Sub is ignored: every math-null verdict carries FALLBACK_SCREENS, whose sub list is empty.
    if (!math) {
      if (main) out.set([...main.rgb, Math.round(main.cover * 255)], at)
      continue
    }
    const sub = top(i, i.lists.sub, at)
    let res = mathPixel(math, main, sub)
    // Nothing drew on either screen and the result is the fixed color: that is the back area,
    // which the view shows as a layer of its own, so stay transparent.
    const f = math.fixed
    // Compared in 5-bit space, where the PPU adds.
    if (!main && !sub && [0, 1, 2].every(k => to5(res[k]!) === to5(f[k]!))) continue
    // A dim main pixel blends over the pixel it hides (the screen's result without it); over
    // nothing it keeps its alpha so the back area layer shows through. A dim sub pixel with main
    // empty keeps its alpha the same way.
    let alpha = 1
    if (main && main.cover < 1) {
      const below = mathPixel(math, null, sub)
      const w = main.cover
      if (sub) res = res.map((v, k) => Math.round(v * w + below[k]! * (1 - w))) as unknown as Rgb
      else alpha = w
    } else if (!main && sub) alpha = sub.cover
    out.set([res[0], res[1], res[2], Math.round(alpha * 255)], at)
  }
  return out
}
