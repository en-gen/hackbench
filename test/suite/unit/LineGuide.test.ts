import { describe, it, expect } from 'vitest'
import {
  LINE_TRACKED_SPRITE_IDS,
  probeTrackTile,
  resolveLineGuideAttachment,
} from '../../../src/rom/LineGuide'

/** Build an l1 grid of given dimensions, optionally seeded with tile IDs. */
function makeL1(
  rows: number, cols: number,
  seed: Record<`${number},${number}`, number> = {},
): (number | null)[][] {
  const g: (number | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null))
  for (const key in seed) {
    const [r, c] = key.split(',').map(Number)
    g[r][c] = seed[key as `${number},${number}`]
  }
  return g
}

describe('LINE_TRACKED_SPRITE_IDS', () => {
  it('contains exactly $62..$68', () => {
    expect([...LINE_TRACKED_SPRITE_IDS].sort((a, b) => a - b))
      .toEqual([0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68])
  })
})

describe('probeTrackTile', () => {
  const NO = false
  const YES = true

  it('returns null when no line-guide tile is in the probe box', () => {
    const l1 = makeL1(30, 40)
    expect(probeTrackTile(100, 100, l1, NO)).toBeNull()
  })

  it('matches a Map16 tile in range $76..$99 at the probed cell', () => {
    // Probe center (400, 336) = (col 25, row 21). ±4 px stays within col 24-25 / row 20-21.
    const l1 = makeL1(30, 40, { '21,25': 0x92 })
    expect(probeTrackTile(400, 336, l1, NO)).toEqual({ col: 25, row: 21 })
  })

  it('rejects tiles outside $76..$99', () => {
    const l1 = makeL1(30, 40, { '21,25': 0x75 })
    expect(probeTrackTile(400, 336, l1, NO)).toBeNull()

    const l1b = makeL1(30, 40, { '21,25': 0x9A })
    expect(probeTrackTile(400, 336, l1b, NO)).toBeNull()
  })

  it('iterates Y=3→0 and takes the first match (bottom-right corner wins)', () => {
    // Probe at the corner of 4 tiles so each ±4 corner lands on a different cell.
    // Center (400, 336): corners are (404, 340)=(col 25, row 21), (396, 340)=(24, 21),
    // (404, 332)=(25, 20), (396, 332)=(24, 20).
    // Y=3 first → (col 25, row 21) wins when multiple corners have matches.
    const l1 = makeL1(30, 40, {
      '21,25': 0x80,  // TL in image / Y=3 probe = bottom-right of box
      '21,24': 0x81,  // Y=2 probe
      '20,25': 0x82,  // Y=1 probe
      '20,24': 0x83,  // Y=0 probe
    })
    expect(probeTrackTile(400, 336, l1, NO)).toEqual({ col: 25, row: 21 })
  })

  it('skips earlier corners that miss and picks a later corner that hits', () => {
    const l1 = makeL1(30, 40, { '20,24': 0x85 })  // only Y=0 (top-left) corner
    expect(probeTrackTile(400, 336, l1, NO)).toEqual({ col: 24, row: 20 })
  })

  it('gates $94 on switch ON and $95 on switch OFF', () => {
    const l1a = makeL1(30, 40, { '21,25': 0x94 })
    expect(probeTrackTile(400, 336, l1a, NO)).toBeNull()
    expect(probeTrackTile(400, 336, l1a, YES)).toEqual({ col: 25, row: 21 })

    const l1b = makeL1(30, 40, { '21,25': 0x95 })
    expect(probeTrackTile(400, 336, l1b, YES)).toBeNull()
    expect(probeTrackTile(400, 336, l1b, NO)).toEqual({ col: 25, row: 21 })
  })

  it('matches by low byte only (page 1 tile $195 registers as line-guide)', () => {
    // The ROM CMP #$76/#$9A checks Map16TileNumber (low byte only) — we mirror that.
    const l1 = makeL1(30, 40, { '21,25': 0x195 })
    expect(probeTrackTile(400, 336, l1, NO)).toEqual({ col: 25, row: 21 })
  })

  it('returns null for out-of-bounds probe positions', () => {
    const l1 = makeL1(10, 10)
    expect(probeTrackTile(-100, 100, l1, NO)).toBeNull()
    expect(probeTrackTile(100, -100, l1, NO)).toBeNull()
    expect(probeTrackTile(10_000, 100, l1, NO)).toBeNull()
  })
})

describe('resolveLineGuideAttachment', () => {
  it('returns null for non-tracked sprite IDs', () => {
    const l1 = makeL1(30, 40, { '21,25': 0x92 })
    expect(resolveLineGuideAttachment(0x00, 400, 336, l1, false)).toBeNull()
    expect(resolveLineGuideAttachment(0x61, 400, 336, l1, false)).toBeNull()
    expect(resolveLineGuideAttachment(0x69, 400, 336, l1, false)).toBeNull()
  })

  describe('$65-$68 (InitLineGuidedSpr)', () => {
    it('reverse direction (odd col): probes spawnX + $0F, direction=reverse', () => {
      // col 25 row 21 → spawnX=$190 (bit 4 of $90 is set). Shift +$0F → probe X=$19F=415.
      // Corners ±4 of (415, 336) land in cols 25-26, rows 20-21.
      const l1 = makeL1(30, 40, { '21,26': 0x92 })
      const r = resolveLineGuideAttachment(0x67, 400, 336, l1, false)
      expect(r).toEqual({ trackTile: { col: 26, row: 21 }, direction: 'reverse' })
    })

    it('forward direction (even col): probes spawnX - $140, direction=forward', () => {
      // col 26 row 21 → spawnX=$1A0 (bit 4 of $A0 is clear). Shift -$140 → probe X=$060=96.
      // Corners ±4 of (96, 336) land in cols 5-6, rows 20-21.
      const l1 = makeL1(30, 40, { '21,6': 0x92 })
      const r = resolveLineGuideAttachment(0x67, 416, 336, l1, false)
      expect(r).toEqual({ trackTile: { col: 6, row: 21 }, direction: 'forward' })
    })

    it('applies to $65, $66, $67, $68 identically', () => {
      const l1 = makeL1(30, 40, { '21,26': 0x92 })
      for (const id of [0x65, 0x66, 0x67, 0x68]) {
        const r = resolveLineGuideAttachment(id, 400, 336, l1, false)
        expect(r?.trackTile).toEqual({ col: 26, row: 21 })
        expect(r?.direction).toBe('reverse')
      }
    })

    it('reverse-path XLow wraps within the low byte (no carry to XHigh)', () => {
      // spawnX where XLow = $F0 (bit 4 set), XHigh = 1 → spawnX = $01F0.
      // Reverse: XLow = ($F0 + $0F) & $FF = $FF, XHigh stays 1 → probe X = $01FF.
      // $1FF / 16 = col 31 (row 21 unchanged). Probe corners land in cols 31-32.
      const l1 = makeL1(30, 40, { '21,31': 0x92 })
      const r = resolveLineGuideAttachment(0x67, 0x01F0, 336, l1, false)
      expect(r?.trackTile).toEqual({ col: 31, row: 21 })
      expect(r?.direction).toBe('reverse')
    })

    it('returns null when the shifted probe finds no track', () => {
      const l1 = makeL1(30, 40)
      expect(resolveLineGuideAttachment(0x67, 400, 336, l1, false)).toBeNull()
    })
  })

  describe('$62-$64 (InitLinePlat / CODE_01DAA2)', () => {
    it('forward (even col): probes spawnX - $28, spawnY - $08', () => {
      // col 10 row 10 → spawnX=$A0 (bit 4 of $A0 is clear = forward).
      // Probe shift: X -= $28 = -40, Y -= $08 = -8. Probe at (120, 152).
      // Corners land in cols 7-8, rows 9-10.
      const l1 = makeL1(20, 20, { '9,8': 0x80 })  // Y=1 corner (+4, -4) → (124, 148) → (col 7, row 9)... wait let me recompute
      // Actually (120, 152): corners ±4 = (116-124, 148-156). col 7-7 (116/16=7, 124/16=7), row 9-9 (148/16=9, 156/16=9).
      // All 4 corners in (col 7, row 9).
      const l1b = makeL1(20, 20, { '9,7': 0x80 })
      const r = resolveLineGuideAttachment(0x62, 160, 160, l1b, false)
      expect(r).toEqual({ trackTile: { col: 7, row: 9 }, direction: 'forward' })
    })

    it('reverse (odd col): probes spawnX - $18, spawnY - $08', () => {
      // col 11 row 10 → spawnX=$B0 (bit 4 of $B0 is set = reverse).
      // Probe shift: X -= $18 = -24, Y -= $08 = -8. Probe at (152, 152).
      // Corners ±4: col 9-9, row 9-9. (148/16=9, 156/16=9)
      const l1 = makeL1(20, 20, { '9,9': 0x80 })
      const r = resolveLineGuideAttachment(0x63, 176, 160, l1, false)
      expect(r).toEqual({ trackTile: { col: 9, row: 9 }, direction: 'reverse' })
    })

    it('applies to $62, $63, $64 identically', () => {
      const l1 = makeL1(20, 20, { '9,9': 0x80 })
      for (const id of [0x62, 0x63, 0x64]) {
        const r = resolveLineGuideAttachment(id, 176, 160, l1, false)
        expect(r?.trackTile).toEqual({ col: 9, row: 9 })
        expect(r?.direction).toBe('reverse')
      }
    })
  })
})
