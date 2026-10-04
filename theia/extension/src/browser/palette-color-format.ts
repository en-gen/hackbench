/**
 * Pure colour-format helpers for the palette view.
 *
 * No Theia, React or DOM dependency, so these are covered directly by
 * Vitest rather than only through the Playwright suite.
 */
import { PaletteColorDto } from '../common/palette-protocol'

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0')

/**
 * Recovers the SNES BGR555 word from an RGBA colour already expanded by
 * bgr555ToRgba (src/rom/GraphicsDecoder.ts). Exact: that expansion
 * replicates each 5-bit component into a byte as (c5<<3 | c5>>2), so the
 * component's original 5 bits are always its byte's top 5 bits and `>>3`
 * recovers them losslessly.
 */
export function rgbaToBgr555(c: PaletteColorDto): number {
  return ((c.r >> 3) & 0x1f) | (((c.g >> 3) & 0x1f) << 5) | (((c.b >> 3) & 0x1f) << 10)
}

export function formatBgr555(c: PaletteColorDto): string {
  return `$${hex(rgbaToBgr555(c), 4)}`
}

export function formatRomAddr(addr: number | null): string {
  return addr !== null ? `$${hex(addr, 6)}` : 'address unverified'
}

/**
 * CSS colour for a swatch's fill. The one inline style this view uses: the
 * colour is ROM data, not something a theme should be resolving.
 */
export function cssColor(c: PaletteColorDto): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`
}

/** "#rrggbb" (an `<input type="color">`'s value) to a BGR555 hex word. */
export function cssHexToBgr555(cssHex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(cssHex.trim())
  if (!m) throw new Error(`not a 6-digit css color: ${JSON.stringify(cssHex)}`)
  const n = parseInt(m[1], 16)
  return formatBgr555({ r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 255 })
}

/** A BGR555 word an operator typed ("391F", "$391f", ...) to canonical "$XXXX". */
export function normalizeBgr555Hex(input: string): string {
  const m = /^\$?([0-9a-fA-F]{1,4})$/.exec(input.trim())
  if (!m) throw new Error(`not a BGR555 hex word: ${JSON.stringify(input)}`)
  return `$${m[1].toUpperCase().padStart(4, '0')}`
}

/** The opposite direction: a BGR555 word to "#rrggbb" for the colour input's value. */
export function bgr555HexToCssHex(bgrHex: string): string {
  const m = /^\$?([0-9a-fA-F]{1,4})$/.exec(bgrHex.trim())
  if (!m) throw new Error(`not a BGR555 hex word: ${JSON.stringify(bgrHex)}`)
  const word = parseInt(m[1], 16) & 0x7fff
  const r5 = word & 0x1f
  const g5 = (word >> 5) & 0x1f
  const b5 = (word >> 10) & 0x1f
  const expand = (c5: number): number => (c5 << 3) | (c5 >> 2)
  return `#${[expand(r5), expand(g5), expand(b5)].map(n => hex(n, 2)).join('')}`
}
