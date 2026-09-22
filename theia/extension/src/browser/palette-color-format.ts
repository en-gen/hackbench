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
