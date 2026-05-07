/**
 * Unit tests for computeL3ScrollRange — Layer 3 scroll-range derivation
 * for the editor's L3 BG-coverage overlay.
 *
 * Derived from CODE_05C40C / CODE_05C494 (bank_05.asm:5504-5630):
 *   - Tide: Layer3YPos oscillates between $30 and $A0 over the timer.
 *   - Fixed (cage/window/fish, settings $80 / $C0): Layer3YPos stays at the
 *     static initialYPx ($D0 for the canonical case; $C0 for Castle1 /
 *     Underground1 via CODE_009FFA).
 *   - Camera-tracked ($81 + non-castle/non-underground tileset): Layer3YPos
 *     = Layer1YPos every frame, so band sits at fixed level rows.
 */

import { describe, it, expect } from 'vitest'
import {
  computeL3ScrollRange,
  L3_TILEMAP_COLS,
  L3_TILEMAP_ROWS,
  L3_HUD_ROW_CUTOFF,
} from '../../../src/rom/L3Loader'

/**
 * Build a 64x64 tilemap with non-zero cells in rows [firstRow, lastRow]
 * (inclusive). Each (row, col) gets a unique charIdx in the 10-bit BG3
 * char range so the tide dedupe detector (which compares the low 10 bits)
 * never mistakes row R+1 for a repeat of row R within the band.
 */
function buildTilemap(firstRow: number, lastRow: number, cols = 32): Uint16Array {
  const tm = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = 0; c < cols; c++) {
      // charIdx = r*32 + c + 1, masked to 10 bits. Two rows in [8, 32)
      // never collide under this stride.
      const charIdx = ((r * 32 + c + 1) & 0x3FF)
      tm[r * L3_TILEMAP_COLS + c] = charIdx === 0 ? 1 : charIdx
    }
  }
  return tm
}

const LEVEL_PIXEL_W = 11 * 256   // 11-screen horizontal level

describe('computeL3ScrollRange', () => {
  it('returns kind=none when settings byte is in the no-L3 range ($C0+)', () => {
    const tm = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
    const r = computeL3ScrollRange({
      tilemap:          tm,
      initialYPx:       0,
      initialCameraYPx: 0,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0xC0,
      tileset:          0,
    })
    expect(r.kind).toBe('none')
  })

  it('returns kind=fixed for settings byte $80 with initialYPx $D0', () => {
    // 16-row band starting at L3_HUD_ROW_CUTOFF (=8), no animation
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 15
    const initialYPx       = 0xD0
    const initialCameraYPx = 0
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x80,
      tileset:          0,
    })

    expect(r.kind).toBe('fixed')
    expect(r.xMin).toBe(0)
    expect(r.xMax).toBe(LEVEL_PIXEL_W)
    // Static render: pixelY = row*8 - initialYPx + initialCameraYPx
    expect(r.yMin).toBe(firstRow * 8 - initialYPx + initialCameraYPx)
    expect(r.yMax).toBe((lastRow + 1) * 8 - initialYPx + initialCameraYPx)
  })

  it('returns kind=fixed for settings byte $81 + tileset 1 (Castle1)', () => {
    // Per CODE_009FFA, byte $81 with tileset 1 or 3 fixes Layer3YPos at $C0.
    // Our renderer still uses initialYPx ($D0) at static-render time, so the
    // overlay should reflect what the renderer actually draws.
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 7
    const initialYPx       = 0xD0
    const initialCameraYPx = 0
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x81,
      tileset:          1,
    })

    expect(r.kind).toBe('fixed')
    expect(r.yMin).toBe(firstRow * 8 - initialYPx + initialCameraYPx)
    expect(r.yMax).toBe((lastRow + 1) * 8 - initialYPx + initialCameraYPx)
  })

  it('returns kind=fixed for settings byte $81 + tileset 3 (Underground1)', () => {
    // Same special case as tileset 1.  Level $009 hits this branch.
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 7
    const initialYPx       = 0xD0
    const initialCameraYPx = 0
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x81,
      tileset:          3,
    })
    expect(r.kind).toBe('fixed')
  })

  it('returns kind=camera-tracked for settings byte $81 + tileset != 1,3', () => {
    // Per L3Loader.ts:502, this branch makes Layer3YPos = Layer1YPos every
    // frame, so cells sit at fixed level Y = row*8 (overlay shows level rows).
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 7
    const initialCameraYPx = 0x60
    // Pre-collapse: when settingsByte=$81 and tileset != 1,3, the loader sets
    // initialYPx = initialCameraYPx so pixelY = row*8 - initialYPx + initialCamY
    // collapses to row*8. computeL3ScrollRange must detect this branch and
    // report yMin/yMax in absolute level rows.
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx:       initialCameraYPx,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x81,
      tileset:          5,
    })

    expect(r.kind).toBe('camera-tracked')
    expect(r.yMin).toBe(firstRow * 8)
    expect(r.yMax).toBe((lastRow + 1) * 8)
  })

  it('returns kind=fixed (NOT tide) for settings byte $02 (Tide_Stationary)', () => {
    // Per CODE_05C494 (bank_05.asm:5576-5578): DEC A; BNE CODE_05C4EC means
    // only Layer3TideSetting === 1 takes the Y-animation path. Byte $02
    // (Tide_Stationary) jumps to CODE_05C4EC which only updates Layer3XPos,
    // so the L3 band is Y-static at the initial Layer3YPos ($40 from
    // l3InitialYPx). Overlay should not draw Min/Max sweep lines.
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 15
    const initialCameraYPx = 0
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx:       0x40,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x02,
      tileset:          8,
    })

    expect(r.kind).toBe('fixed')
    expect(r.yMin).toBe(firstRow * 8 - 0x40 + initialCameraYPx)
    expect(r.yMax).toBe((lastRow + 1) * 8 - 0x40 + initialCameraYPx)
    // Tide-only fields should be absent.
    expect(r.yHighTide).toBeUndefined()
    expect(r.yLowTide).toBeUndefined()
  })

  it('returns kind=fixed for settings byte $00 (CODE_05C40C BEQ skips tide handler)', () => {
    // Vanilla never uses byte $00 in Layer3TilemapSettings, but the ASM at
    // CODE_05C40C (bank_05.asm:5504-5507) skips the JMP CODE_05C494 when
    // Layer3TideSetting is 0, so the L3 stays static.
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 15
    const initialCameraYPx = 0
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx:       0x70,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x00,
      tileset:          0,
    })
    expect(r.kind).toBe('fixed')
    expect(r.yHighTide).toBeUndefined()
    expect(r.yLowTide).toBeUndefined()
  })

  it('returns kind=tide for settings byte $01 (tide-up-and-down)', () => {
    // Tide sweep range is the same regardless of UD vs stationary subtype.
    const firstRow = L3_HUD_ROW_CUTOFF
    const lastRow  = L3_HUD_ROW_CUTOFF + 15
    const initialCameraYPx = 0
    const r = computeL3ScrollRange({
      tilemap:          buildTilemap(firstRow, lastRow),
      initialYPx:       0x70,
      initialCameraYPx,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x01,
      tileset:          0,
    })
    expect(r.kind).toBe('tide')
    expect(r.yMin).toBe(firstRow * 8 - 0xA0)
    expect(r.yMax).toBe((lastRow + 1) * 8 - 0x30)
  })

  it('returns kind=none when the tilemap has no non-HUD content', () => {
    // Only HUD rows populated; gameplay rows are all zero. No scroll range
    // to draw — the overlay shouldn't render.
    const tm = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
    for (let c = 0; c < 32; c++) tm[0 * L3_TILEMAP_COLS + c] = 0x1234   // HUD row 0
    const r = computeL3ScrollRange({
      tilemap:          tm,
      initialYPx:       0xD0,
      initialCameraYPx: 0,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x80,
      tileset:          0,
    })
    expect(r.kind).toBe('none')
  })

  it('detects the tide double-VRAM-copy and uses only the first copy for height', () => {
    // Tide stripe images write two identical row patterns (rows 32-47 + 48-63)
    // for smooth animation. computeL3ScrollRange must mirror L3TilemapLayer's
    // dedupe so the band height isn't doubled. Only byte $01 (Tide_UpAndDown)
    // takes the animated path post-fix; byte $02 (Tide_Stationary) is treated
    // as kind:'fixed' and shouldn't run the double-copy dedupe.
    const firstRow = 32
    const copyHeight = 16
    const tm = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
    for (let r = firstRow; r < firstRow + copyHeight; r++) {
      for (let c = 0; c < 32; c++) {
        // Unique-per-row charIdx within a copy; SAME charIdx in the second copy.
        // Encoding ((r-firstRow+1)*32 + c + 1) keeps charIdx in [33, 544] (≤10 bits).
        const charIdx = (r - firstRow + 1) * 32 + c + 1
        tm[r * L3_TILEMAP_COLS + c] = charIdx
        tm[(r + copyHeight) * L3_TILEMAP_COLS + c] = charIdx
      }
    }
    const range = computeL3ScrollRange({
      tilemap:          tm,
      initialYPx:       0x70,
      initialCameraYPx: 0,
      levelPixelW:      LEVEL_PIXEL_W,
      settingsByte:     0x01,
      tileset:          0,
    })
    expect(range.kind).toBe('tide')
    // Should treat dataEndRow = firstRow + copyHeight (NOT 64), so the band
    // height equals copyHeight*8.
    expect(range.yMax - range.yMin).toBe(copyHeight * 8 + (0xA0 - 0x30))
  })
})
