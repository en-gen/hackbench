/**
 * An area's camera window over half 1 (en-gen/hackbench#364). The one place the mapping lives,
 * so edits made in an area view can land on the same grid location later (#283).
 * Camera X/Y: DATA_00A06B / DATA_00A079, bank_00.asm:4242-4248. The BG wraps at 512 (the
 * 64x64 tile layout, bank_04.asm:2692-2698).
 */
import { OW_HALF_H, OW_HALF_W, type OwLayerPixels } from './render/OverworldComposite'

export const OW_WINDOW_W = 256
export const OW_WINDOW_H = 224

const wrap = (v: number, n: number): number => ((v % n) + n) % n

/** The half-1 pixel that view pixel (x, y) of the window at camera (wx, wy) shows. */
export function halfPixel(wx: number, wy: number, x: number, y: number): [number, number] {
  return [wrap(wx + x, OW_HALF_W), wrap(wy + y, OW_HALF_H)]
}

/** A layer cropped to the window. The window need not sit on an 8 px cell boundary, so the
 *  priority comes out per pixel (`prioCell` 1). */
export function cropWindow(layer: OwLayerPixels, wx: number, wy: number): OwLayerPixels {
  const rgba = new Uint8ClampedArray(OW_WINDOW_W * OW_WINDOW_H * 4)
  const prio = new Uint8Array(OW_WINDOW_W * OW_WINDOW_H)
  const cellsW = OW_HALF_W >> 3
  for (let y = 0; y < OW_WINDOW_H; y++) {
    for (let x = 0; x < OW_WINDOW_W; x++) {
      const [sx, sy] = halfPixel(wx, wy, x, y)
      const s = sy * OW_HALF_W + sx
      const d = y * OW_WINDOW_W + x
      rgba.set(layer.rgba.subarray(s * 4, s * 4 + 4), d * 4)
      prio[d] = layer.prio[(sy >> 3) * cellsW + (sx >> 3)]!
    }
  }
  return { rgba, prio, prioCell: 1 }
}
