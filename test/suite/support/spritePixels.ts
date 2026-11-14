import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

/** Absolute pixels a map sprite draws (alpha above zero), as "x,y" keys, read from its bitmap and box. */
export const opaque = (s: MapSpriteDto): Set<string> => {
  const w = s.box.x1 - s.box.x0
  const b = Buffer.from(s.rgba, 'base64')
  const out = new Set<string>()
  for (let i = 0; i < b.length / 4; i++)
    if (b[i * 4 + 3]! > 0) out.add(`${s.box.x0 + (i % w)},${s.box.y0 + Math.floor(i / w)}`)
  return out
}

/** The pixels two sprites both draw. */
export const sharedPixels = (a: MapSpriteDto, b: MapSpriteDto): string[] => {
  const other = opaque(b)
  return Array.from(opaque(a)).filter(p => other.has(p))
}
