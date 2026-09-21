/**
 * L3Loader - synthetic tests for parseStripeImage and the routine
 * classification rules. Each test pins down a concrete ASM-derived contract
 * (verified against bank_00.asm in SMWDisX); none are schema echoes.
 */

import { describe, it, expect } from 'vitest'
import {
  parseStripeImage,
  parseStripeImageInto,
  classifyL3Routine,
  l3InitialYPx,
  L3_TILEMAP_COLS,
  L3_TILEMAP_BASE,
} from '../../../src/rom/L3Loader'

/**
 * Compute the flat tilemap index from a VRAM word address. Mirrors the
 * sub-screen-aware translation in L3Loader's internal `vramAddrToFlat`:
 * the L3 BG is 4 sub-screens of 32×32 tiles, each 0x400 words, laid out
 * TL/TR/BL/BR. Returns -1 for addresses outside $5000-$5FFF.
 */
function flatIndex(vramAddr: number): number {
  const off = vramAddr - L3_TILEMAP_BASE
  if (off < 0 || off >= L3_TILEMAP_COLS * 64) return -1
  const sub = (off >> 10) & 3
  const within = off & 0x3ff
  const hwRow = (within >> 5) + (sub >= 2 ? 32 : 0)
  const hwCol = (within & 0x1f) + (sub & 1 ? 32 : 0)
  return hwRow * L3_TILEMAP_COLS + hwCol
}

describe('parseStripeImage - terminator', () => {
  it('returns a zero-filled 64×64 tilemap when input starts with $FF', () => {
    const out = parseStripeImage(Uint8Array.from([0xff]))
    expect(out.length).toBe(64 * 64)
    expect(out.every(v => v === 0)).toBe(true)
  })

  it('terminates on any byte with bit 7 set, not just $FF', () => {
    const out = parseStripeImage(Uint8Array.from([0x80]))
    expect(out.every(v => v === 0)).toBe(true)
  })

  it('ignores bytes after the terminator', () => {
    // Garbage after a $FF terminator must not be parsed as a header.
    const out = parseStripeImage(Uint8Array.from([0xff, 0x00, 0x50, 0x00, 0x01]))
    expect(out.every(v => v === 0)).toBe(true)
  })
})

describe('parseStripeImage - horizontal write', () => {
  it('writes 1 tile word at the VRAM address (countBytes=2 → 1 tile)', () => {
    // Header: vramAddr=$5000 (= L3_TILEMAP_BASE), vertical=0, rle=0, count=$001 (countBytes=2)
    // Then: 2 data bytes = 1 tile word
    const data = Uint8Array.from([
      0x50,
      0x00, // VRAM addr $5000 (high byte first)
      0x00,
      0x01, // flags=0, count-1=1 (countBytes=2)
      0x34,
      0x12, // tile word $1234 (lo, hi)
      0xff,
    ])
    const out = parseStripeImage(data)
    expect(out[flatIndex(0x5000)]).toBe(0x1234)
    expect(out[flatIndex(0x5001)]).toBe(0)
  })

  it('writes 4 tile words consecutively when count=4', () => {
    // count-1=7 → countBytes=8 → 4 tiles
    const data = Uint8Array.from([
      0x50,
      0x00,
      0x00,
      0x07,
      0x01,
      0x00, // tile 0 = $0001
      0x02,
      0x00, // tile 1 = $0002
      0x03,
      0x00, // tile 2 = $0003
      0x04,
      0x00, // tile 3 = $0004
      0xff,
    ])
    const out = parseStripeImage(data)
    expect(out[flatIndex(0x5000)]).toBe(1)
    expect(out[flatIndex(0x5001)]).toBe(2)
    expect(out[flatIndex(0x5002)]).toBe(3)
    expect(out[flatIndex(0x5003)]).toBe(4)
  })
})

describe('parseStripeImage - RLE write', () => {
  it('repeats one tile word `count` times when bit 6 of flags is set', () => {
    // flags = $40 (rle=1, vertical=0), count-1=3 → countBytes=4 → 2 tiles repeat
    const data = Uint8Array.from([
      0x50,
      0x00,
      0x40,
      0x03,
      0x77,
      0x88, // single tile word $8877 (only 2 bytes regardless of count)
      0xff,
    ])
    const out = parseStripeImage(data)
    expect(out[flatIndex(0x5000)]).toBe(0x8877)
    expect(out[flatIndex(0x5001)]).toBe(0x8877)
    // Stream advances by only 2, not countBytes - next byte was $FF terminator.
  })
})

describe('parseStripeImage - vertical stride', () => {
  it('advances VRAM by +32 words per tile when bit 7 of flags is set', () => {
    // vertical=1, rle=0, count-1=3 → 2 tiles vertically (each +32 words)
    const data = Uint8Array.from([0x50, 0x00, 0x80, 0x03, 0xaa, 0x00, 0xbb, 0x00, 0xff])
    const out = parseStripeImage(data)
    expect(out[flatIndex(0x5000)]).toBe(0x00aa)
    // Second tile lands at VRAM $5000 + 32 = $5020
    expect(out[flatIndex(0x5020)]).toBe(0x00bb)
    expect(out[flatIndex(0x5001)]).toBe(0) // horizontal-stride neighbor stays empty
  })
})

describe('parseStripeImage - truncation safety', () => {
  it('stops cleanly when header is incomplete (i+3 >= length)', () => {
    const data = Uint8Array.from([0x50, 0x00, 0x00]) // 3-byte header (need 4)
    const out = parseStripeImage(data)
    expect(out.every(v => v === 0)).toBe(true)
  })

  it('stops cleanly when RLE tile bytes are missing', () => {
    // RLE header announces tiles, but only 1 byte of the 2-byte tile word follows.
    const data = Uint8Array.from([0x50, 0x00, 0x40, 0x05, 0xaa])
    const out = parseStripeImage(data)
    // Got header but no full tile word → no writes happen.
    expect(out.every(v => v === 0)).toBe(true)
  })

  it('stops cleanly mid-tile in non-RLE mode', () => {
    // Header for 3 tiles, but only 1 full + 1 partial tile of data.
    const data = Uint8Array.from([
      0x50,
      0x00,
      0x00,
      0x05, // 3 tiles
      0x11,
      0x22, // tile 0 = $2211
      0x33, // partial tile 1
    ])
    const out = parseStripeImage(data)
    expect(out[flatIndex(0x5000)]).toBe(0x2211)
    // Tile 1 abandoned; no garbage written.
    expect(out[flatIndex(0x5001)]).toBe(0)
  })
})

describe('parseStripeImageInto', () => {
  it('writes into an existing buffer (status-bar pre-fill use case)', () => {
    // Status-bar VRAM $4000 maps outside the L3 sub-screen range so the
    // stripe parser can't touch it; we just pre-fill an arbitrary cell to
    // confirm it survives the stripe write.
    const buf = new Uint16Array(64 * 64)
    buf[100] = 0xcafe
    parseStripeImageInto(buf, Uint8Array.from([0x50, 0x00, 0x00, 0x01, 0x99, 0x00, 0xff]))
    expect(buf[100]).toBe(0xcafe) // pre-fill preserved
    expect(buf[flatIndex(0x5000)]).toBe(0x99) // stripe parsed
  })
})

// ── classifyL3Routine - verified against bank_00.asm:4139-4165 ───────────────

describe('classifyL3Routine', () => {
  it('layer3Setting=0 → disabled (no lookup performed)', () => {
    expect(classifyL3Routine({ layer3Setting: 0, settingsByte: 0x40, tileset: 0 })).toMatchObject({
      kind: 'disabled',
      initialYPx: null,
      isTideUpAndDown: false,
    })
  })

  it('settingsByte=null + non-zero setting → disabled (defensive)', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: null, tileset: 0 })).toMatchObject({
      kind: 'disabled',
    })
  })

  it('byte=$01 (Tide_UpAndDown) → tide, initialYPx=$70, isTideUpAndDown=true', () => {
    const r = classifyL3Routine({ layer3Setting: 1, settingsByte: 0x01, tileset: 0 })
    expect(r.kind).toBe('tide')
    expect(r.initialYPx).toBe(0x70)
    expect(r.isTideUpAndDown).toBe(true)
  })

  it('byte=$00 → fixed at $70 (BEQ branches when LSR result is zero)', () => {
    const r = classifyL3Routine({ layer3Setting: 1, settingsByte: 0x00, tileset: 0 })
    expect(r.kind).toBe('fixed')
    expect(r.initialYPx).toBe(0x70)
  })

  it('byte $02..$7F → fixed at $40 (no Y animation)', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x40, tileset: 0 })).toMatchObject({
      kind: 'fixed',
      initialYPx: 0x40,
    })
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x7f, tileset: 0 })).toMatchObject({
      kind: 'fixed',
      initialYPx: 0x40,
    })
  })

  it('byte=$80 → fixed at $D0 (no animation)', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x80, tileset: 0 })).toMatchObject({
      kind: 'fixed',
      initialYPx: 0xd0,
    })
  })

  it('byte=$81 with tileset 1 (Castle1) → fixed at $D0', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x81, tileset: 1 })).toMatchObject({
      kind: 'fixed',
      initialYPx: 0xd0,
    })
  })

  it('byte=$81 with tileset 3 (Underground1) → fixed at $D0', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x81, tileset: 3 })).toMatchObject({
      kind: 'fixed',
      initialYPx: 0xd0,
    })
  })

  it('byte=$81 with other tilesets → camera-tracked (initialYPx=null)', () => {
    const r = classifyL3Routine({ layer3Setting: 1, settingsByte: 0x81, tileset: 0 })
    expect(r.kind).toBe('camera-tracked')
    expect(r.initialYPx).toBeNull()
  })

  it('byte ≥ $C0 → none (no L3 background)', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0xc0, tileset: 0 })).toMatchObject({
      kind: 'none',
    })
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0xff, tileset: 0 })).toMatchObject({
      kind: 'none',
    })
  })
})

// ── l3InitialYPx - direct ASM trace ─────────────────────────────────────────

describe('l3InitialYPx', () => {
  it('byte $00 / $01 → $70 (LSR-then-BEQ branches)', () => {
    expect(l3InitialYPx(0x00)).toBe(0x70)
    expect(l3InitialYPx(0x01)).toBe(0x70)
  })

  it('byte $02..$7F → $40 (LSR result non-zero)', () => {
    expect(l3InitialYPx(0x02)).toBe(0x40)
    expect(l3InitialYPx(0x7f)).toBe(0x40)
  })

  it('byte $80..$BF → $D0 (BMI branch to CODE_009FEA)', () => {
    expect(l3InitialYPx(0x80)).toBe(0xd0)
    expect(l3InitialYPx(0xbf)).toBe(0xd0)
  })

  it('byte ≥ $C0 → 0 (no L3 background path)', () => {
    expect(l3InitialYPx(0xc0)).toBe(0)
    expect(l3InitialYPx(0xff)).toBe(0)
  })
})
