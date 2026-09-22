import { describe, it, expect } from 'vitest'
import {
  rgbaToBgr555,
  formatBgr555,
  formatRomAddr,
  cssColor,
} from '../../../theia/extension/src/browser/palette-color-format'

describe('rgbaToBgr555', () => {
  it("round-trips every 5-bit component through bgr555ToRgba's own bit-replication", () => {
    // Mirrors bgr555ToRgba (src/rom/GraphicsDecoder.ts) rather than importing
    // it, so this test can fail independently of that function's own tests.
    for (let w = 0; w <= 0x7fff; w += 37) {
      const r5 = w & 0x1f
      const g5 = (w >> 5) & 0x1f
      const b5 = (w >> 10) & 0x1f
      const c = {
        r: (r5 << 3) | (r5 >> 2),
        g: (g5 << 3) | (g5 >> 2),
        b: (b5 << 3) | (b5 >> 2),
        a: 255,
      }
      expect(rgbaToBgr555(c)).toBe(w)
    }
  })

  it('reads full-intensity red as $001F', () => {
    expect(rgbaToBgr555({ r: 255, g: 0, b: 0, a: 255 })).toBe(0x001f)
  })

  it('reads full-intensity blue as $7C00', () => {
    expect(rgbaToBgr555({ r: 0, g: 0, b: 255, a: 255 })).toBe(0x7c00)
  })

  it('reads black as $0000', () => {
    expect(rgbaToBgr555({ r: 0, g: 0, b: 0, a: 255 })).toBe(0x0000)
  })
})

describe('formatBgr555', () => {
  it('pads to 4 hex digits with a leading $', () => {
    expect(formatBgr555({ r: 0, g: 0, b: 0, a: 255 })).toBe('$0000')
    expect(formatBgr555({ r: 255, g: 255, b: 255, a: 255 })).toBe('$7FFF')
  })
})

describe('formatRomAddr', () => {
  it('formats a known address as 6 hex digits', () => {
    expect(formatRomAddr(0x00b0b0)).toBe('$00B0B0')
  })

  it('reports an unverified address in words rather than a fabricated number', () => {
    expect(formatRomAddr(null)).toBe('address unverified')
  })
})

describe('cssColor', () => {
  it('carries full opacity through as alpha 1', () => {
    expect(cssColor({ r: 10, g: 20, b: 30, a: 255 })).toBe('rgba(10, 20, 30, 1)')
  })

  it('carries SNES transparency through as alpha 0', () => {
    expect(cssColor({ r: 0, g: 0, b: 0, a: 0 })).toBe('rgba(0, 0, 0, 0)')
  })
})
