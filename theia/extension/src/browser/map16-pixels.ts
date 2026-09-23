/**
 * Pixel plumbing shared by the Map16 view's four surfaces: the tile
 * browser strip, the tile preview, the edit pane's frames and the character
 * palettes.
 *
 * It lives in its own module because all four paint the SAME decoded bytes
 * and must not drift: the preview and the frames crop the atlas the browser
 * strip paints, and the palettes paint the indices that atlas was
 * composited from. Nothing here decodes a cartridge; it only moves bytes the
 * backend already read onto a canvas.
 */

/** One Map16 tile is 16x16 px, the unit buildTileAtlas lays out. */
export const TILE_PX = 16
/** One character is 8x8 px; a tile's quadrant is exactly one of them. */
export const CHAR_PX = 8

/** Dim applied to everything except the item under the pointer. 0.55 black
 * is the value the VS Code extension's Map16 panel used (main.ts:2372). */
export const HOVER_DIM = 'rgba(0, 0, 0, 0.55)'

export function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function decodeRgba(base64: string): Uint8ClampedArray {
  return new Uint8ClampedArray(decodeBase64Bytes(base64).buffer)
}

/** Crops a `w` x `h` region out of a sheet-shaped RGBA buffer. */
export function cropRegion(
  buf: Uint8ClampedArray,
  atlasWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const rowBytes = w * 4
  const out = new Uint8ClampedArray(h * rowBytes)
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * atlasWidth + x) * 4
    out.set(buf.subarray(src, src + rowBytes), row * rowBytes)
  }
  return out
}

/** Where a tile's quadrant sits inside that tile's own 16x16 region. */
export const QUADRANT_ORIGIN: Record<string, { x: number; y: number }> = {
  tl: { x: 0, y: 0 },
  tr: { x: CHAR_PX, y: 0 },
  bl: { x: 0, y: CHAR_PX },
  br: { x: CHAR_PX, y: CHAR_PX },
}

/**
 * Paints a native `w` x `h` RGBA buffer into `canvas`, scaled by `scale`
 * with NO smoothing - this is pixel art, and interpolation would make an
 * edit impossible to judge. `putImageData` cannot itself scale, so the
 * native pixels go to an offscreen canvas first.
 */
export function paintScaled(
  canvas: HTMLCanvasElement,
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  scale: number,
): void {
  canvas.width = w * scale
  canvas.height = h * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const native = document.createElement('canvas')
  native.width = w
  native.height = h
  const nativeCtx = native.getContext('2d')
  if (!nativeCtx) return
  nativeCtx.putImageData(new ImageData(pixels, w, h), 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(native, 0, 0, w, h, 0, 0, canvas.width, canvas.height)
}

/** '#rrggbb' to an [r,g,b] triplet; anything unparseable paints black. */
export function parseCssHex(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return [0, 0, 0]
  const v = parseInt(m[1]!, 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

/**
 * Composites pixel INDICES into RGBA using `colors`, index 0 transparent.
 *
 * The character palettes work in indices rather than in composited RGBA so
 * that changing the selected color row recolors them with no round trip,
 * and so that it stays visible that clicking a character carries only a
 * character number.
 *
 * An index with no color in `colors` is left transparent rather than
 * clamped into the last one: a 3bpp sheet cannot produce indices 8-15, so
 * seeing one would mean the sheet is not what this row can show, and a
 * silently substituted color would hide that.
 */
export function compositeIndices(
  indices: Uint8Array,
  offset: number,
  count: number,
  colors: readonly string[],
): Uint8ClampedArray {
  const rgb = colors.map(parseCssHex)
  const out = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    const index = indices[offset + i] ?? 0
    const c = index === 0 ? undefined : rgb[index]
    if (!c) continue
    out[i * 4] = c[0]
    out[i * 4 + 1] = c[1]
    out[i * 4 + 2] = c[2]
    out[i * 4 + 3] = 255
  }
  return out
}

/**
 * Dims everything on `ctx` EXCEPT the given rectangle.
 *
 * Painting the four bands AROUND the item, rather than dimming everything
 * and restoring it, means the item's own pixels are never drawn over: the
 * hover convention exists to make an item legible while judging it, so
 * anything that alters it defeats the purpose.
 */
export function paintSpotlight(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = HOVER_DIM
  ctx.fillRect(0, 0, canvasWidth, y)
  ctx.fillRect(0, y + h, canvasWidth, canvasHeight - (y + h))
  ctx.fillRect(0, y, x, h)
  ctx.fillRect(x + w, y, canvasWidth - (x + w), h)
}
