/**
 * #936: the corpus check's predicate, apart from the corpus so a synthetic test can prove it goes red.
 * A door pixel is a pixel with a door id where the planes above the first placed sprite (not a Layer 2
 * flame plane) cover it fully, with cover accumulated plane by plane as ColorMath's `top()` and
 * `coveredSprite` do (translucent planes add up, so an opaque top plane is not required). It "meets color
 * math" when the topmost drawing plane's layer bit is in the CGADSUB, as `top()` picks `bit`.
 */
const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
type Planes = Record<string, Uint8ClampedArray | null | undefined>

export function doorPixelsUnderMath(
  main: readonly string[],
  planes: Planes,
  doors: Uint32Array,
  cgadsub: number,
): { doorPixels: number; blended: number } {
  let doorPixels = 0
  let blended = 0
  for (let p = 0; p < doors.length; p++) {
    if (!doors[p]) continue
    let cover = 0
    let bit = 0
    let k = main.length - 1
    for (; k >= 0 && cover < 1; k--) {
      const a = (planes[main[k]!]?.[p * 4 + 3] ?? 0) / 255
      if (a === 0) continue
      if (cover === 0) bit = main[k]!.startsWith('sprites') ? 0 : BIT[main[k]!.slice(0, 2) as keyof typeof BIT] // prettier-ignore
      cover += a * (1 - cover)
    }
    if (cover < 1 || !main.slice(0, k + 1).some(key => key.startsWith('sprites') && !key.startsWith('spritesL2') && (planes[key]?.[p * 4 + 3] ?? 0) > 0)) continue // prettier-ignore
    doorPixels++
    if (cgadsub & bit) blended++
  }
  return { doorPixels, blended }
}
