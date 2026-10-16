/**
 * #936: the corpus check's predicate, apart from the corpus so a synthetic test can prove it goes red.
 * A door pixel is a sprite pixel (a placed sprite plane, not a Layer 2 flame plane) under an opaque
 * tile of a layer, found the way ColorMath's coveredSprite finds it. It "meets color math" when that
 * layer's bit is in the CGADSUB.
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
    const t = main.findLastIndex(k => (planes[k]?.[p * 4 + 3] ?? 0) > 0)
    if (t < 0 || main[t]!.startsWith('sprites') || planes[main[t]!]![p * 4 + 3] !== 255) continue
    const below = main.slice(0, t).some(k => k.startsWith('sprites') && !k.startsWith('spritesL2') && (planes[k]?.[p * 4 + 3] ?? 0) > 0) // prettier-ignore
    if (!below) continue
    doorPixels++
    if (cgadsub & BIT[main[t]!.slice(0, 2) as keyof typeof BIT]) blended++
  }
  return { doorPixels, blended }
}
