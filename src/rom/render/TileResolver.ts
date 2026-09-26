/**
 * The core's single 8x8 pixel resolver: tilemap word + chars + CGRAM ->
 * pixels, with flips, color row and bpp as parameters (#421 step 2). Moved
 * from tools/scripts/capture_draw.ts, whose `foreground()`/`drawBg()` still
 * call `decodeWord`/`charPixel`/`composeTile`/`resolveTilePixel` from here,
 * so the same arithmetic `capture:render` proves pixel-for-pixel against
 * Mesen is what `src/rom/TileRenderer.ts` (the shipping Map16 atlas) and
 * `src/rom/render/BufferRenderTarget.ts` (the model's `Tile.render` path)
 * also run - a drawing bug can no longer sit in one and not the other. Pure:
 * no shell imports, so it runs in Node and in the browser alike.
 *
 * Formats: PPU register layouts per SMWDisX hardware_registers.asm (OBJSEL
 * :19-37, BGMODE :59-76, BGnSC :90-101, BG12NBA :146-153); tilemap word,
 * planar 2bpp/4bpp and BGR555 per the Super Famicom Development Wiki
 * (docs/references.md:29).
 */

/** The five fields packed into one 16-bit SNES BG/OBJ tile-attribute word. */
export interface WordFields {
  char: number
  pal: number
  prio: number
  flipX: number
  flipY: number
}

/** Unpack a tilemap word: char (bits 0-9), pal (10-12), prio (13), flipX (14), flipY (15). */
export function decodeWord(w: number): WordFields {
  // prettier-ignore
  return { char: w & 0x3ff, pal: (w >> 10) & 7, prio: (w >> 13) & 1, flipX: (w >> 14) & 1, flipY: (w >> 15) & 1 }
}

/** Color index 0-15 of pixel (x, y) in a planar char; baseWord is the BG/OBJ name base. */
// prettier-ignore
export function charPixel(vram: Uint8Array, baseWord: number, bpp: number, ch: number, x: number, y: number) {
  const a = (baseWord * 2 + ch * bpp * 8) & 0xffff
  const bit = 7 - x
  let v = ((vram[a + y * 2] >> bit) & 1) | (((vram[a + y * 2 + 1] >> bit) & 1) << 1)
  if (bpp === 4) {
    const b = (a + 16) & 0xffff
    v |= (((vram[b + y * 2] >> bit) & 1) << 2) | (((vram[b + y * 2 + 1] >> bit) & 1) << 3)
  }
  return v
}

/** CGRAM entry as RGB, 5-bit channels widened the way Mesen's PNGs show them. */
export function bgr555(cgram: Uint8Array, i: number): number[] {
  const w = cgram[i * 2] | (cgram[i * 2 + 1] << 8)
  return [w & 31, (w >> 5) & 31, (w >> 10) & 31].map(c => (c << 3) | (c >> 2))
}

/** All 256 CGRAM colors as RGB triples. */
export function palette(cgram: Uint8Array) {
  const p = new Uint8Array(768)
  for (let i = 0; i < 256; i++) p.set(bgr555(cgram, i), i * 3)
  return p
}

/**
 * A char's decoded pixels at the hardware boundary: `(ch, x, y)` (pre-flip,
 * 0-7) -> a local color index (0-15 at 4bpp, 0-3 at 2bpp; 0 = transparent).
 * The capture side supplies this from planar VRAM bytes (`charPixel`); the
 * app supplies it from GfxLoader's already-decoded sheets (`getCharPixels`).
 */
export type CharSource = (ch: number, x: number, y: number) => number

/**
 * Resolve one pixel of a decoded tile word: applies the word's flips, then
 * asks `charSource` for the local color index. This is the hardware-boundary
 * split point - everything above this line is shared; how a char's own
 * bytes turn into an index is supplied by the caller.
 */
export function resolveTilePixel(
  fields: Pick<WordFields, 'char' | 'flipX' | 'flipY'>,
  charSource: CharSource,
  x: number,
  y: number,
): number {
  return charSource(fields.char, fields.flipX ? 7 - x : x, fields.flipY ? 7 - y : y)
}

/**
 * Compose a whole 8x8 tile from decoded word fields and a char source:
 * flips (via `resolveTilePixel`), calling `put(x, y, v)` for every opaque
 * pixel (`v` 1-15, the local color index - the caller multiplies by its own
 * color row). Index 0 is transparent and never calls `put`. See the module
 * header for who shares this.
 */
export function composeTile(
  fields: Pick<WordFields, 'char' | 'flipX' | 'flipY'>,
  charSource: CharSource,
  put: (x: number, y: number, v: number) => void,
): void {
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const v = resolveTilePixel(fields, charSource, x, y)
      if (v) put(x, y, v)
    }
}
