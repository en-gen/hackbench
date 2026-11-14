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

type Box = MapSpriteDto['box']
/**
 * The empty space between two boxes in pixels: the larger of the horizontal and vertical gaps, so 0 or less means they
 * touch or overlap and a positive value is how far apart they stand.
 */
export const boxGap = (a: Box, b: Box): number =>
  Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1)
