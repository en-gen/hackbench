/**
 * OverworldLoader - synthetic tests for the count-terminated RLE decoder
 * used by the SMW overworld L2 tilemap streams.
 *
 * Decoder spec (CODE_04DABA, bank_04.asm:5452):
 *   cmd byte = FLLLLLLL
 *     F=0 (bit 7 clear) → LITERAL: emit (L+1) bytes copied from input
 *     F=1 (bit 7 set)   → RLE:     emit (L & 0x7F)+1 copies of next byte
 *   Termination: dest position reaches `outputBytes` (no in-band terminator).
 *
 * Each output write advances dest by `stride` (default 2). Stream A starts
 * at offset 0 (low bytes); stream B starts at offset 1 (high bytes). The
 * two streams interleave into a 16-bit tilemap.
 *
 * None of these bytes come from any SMW ROM - original synthetic inputs.
 */

import { describe, it, expect } from 'vitest'
import {
  decompressOwRleStream,
  interleaveOwL2Streams,
  tilemapByteOffset,
  map16ByteOffset,
  OW_BG_LAYOUT_BYTES,
  OW_BG_SCREEN_BYTES,
} from '../../../src/rom/OverworldLoader'
import {
  OW_EVENT_COUNT,
  isEventActivated,
  allEventsActivated,
  noEventsActivated,
  applyEventSwaps,
  OwEventTables,
} from '../../../src/rom/OverworldEvents'

const toBytes = (arr: number[]): Uint8Array => Uint8Array.from(arr)

describe('OW RLE - LITERAL mode (bit 7 clear)', () => {
  it('cmd=0x00 emits one literal byte', () => {
    // cmd $00 = literal length 1, payload $AA. Stride 1 for direct verification.
    const out = new Uint8Array(4)
    decompressOwRleStream(toBytes([0x00, 0xaa]), 0, out, 0, 1)
    expect(out[0]).toBe(0xaa)
  })

  it('cmd=0x03 emits four literal bytes', () => {
    const out = new Uint8Array(8)
    decompressOwRleStream(toBytes([0x03, 0x11, 0x22, 0x33, 0x44]), 0, out, 0, 1)
    expect(Array.from(out.slice(0, 4))).toEqual([0x11, 0x22, 0x33, 0x44])
  })

  it('cmd=0x7F emits 128 literal bytes', () => {
    const payload = Array.from({ length: 128 }, (_, i) => i & 0xff)
    const out = new Uint8Array(128)
    decompressOwRleStream(toBytes([0x7f, ...payload]), 0, out, 0, 1)
    expect(Array.from(out)).toEqual(payload)
  })
})

describe('OW RLE - RLE mode (bit 7 set)', () => {
  it('cmd=0x80 emits one repeated byte', () => {
    const out = new Uint8Array(4)
    decompressOwRleStream(toBytes([0x80, 0xbb]), 0, out, 0, 1)
    expect(out[0]).toBe(0xbb)
    expect(out[1]).toBe(0x00) // untouched
  })

  it('cmd=0x84 emits five copies', () => {
    // 0x84 → bit7=1, count=(4)+1=5
    const out = new Uint8Array(8)
    decompressOwRleStream(toBytes([0x84, 0x42]), 0, out, 0, 1)
    expect(Array.from(out.slice(0, 5))).toEqual([0x42, 0x42, 0x42, 0x42, 0x42])
  })

  it('cmd=0xFF emits 128 copies', () => {
    const out = new Uint8Array(128)
    decompressOwRleStream(toBytes([0xff, 0x99]), 0, out, 0, 1)
    expect(out.every(b => b === 0x99)).toBe(true)
  })
})

describe('OW RLE - count-terminated (no FF FF marker)', () => {
  it('stops when destination reaches outputBytes', () => {
    // Stream would emit infinitely many bytes; we cap at output size 4.
    const out = new Uint8Array(4)
    decompressOwRleStream(
      toBytes([0xff, 0xcc]), // cmd=$FF would emit 128 copies of $CC if unbounded
      0,
      out,
      0,
      1,
    )
    expect(Array.from(out)).toEqual([0xcc, 0xcc, 0xcc, 0xcc])
  })

  it('FF in the middle of literal data is NOT a terminator', () => {
    // cmd=0x03 → literal 4 bytes; payload includes $FF.
    const out = new Uint8Array(4)
    decompressOwRleStream(toBytes([0x03, 0xff, 0xff, 0xaa, 0xbb]), 0, out, 0, 1)
    expect(Array.from(out)).toEqual([0xff, 0xff, 0xaa, 0xbb])
  })

  it('after one literal block, decoder reads next command from input', () => {
    // 0x01 (literal len 2) + [0x10, 0x20] then 0x81 (RLE len 2) + 0x33
    const out = new Uint8Array(4)
    decompressOwRleStream(toBytes([0x01, 0x10, 0x20, 0x81, 0x33]), 0, out, 0, 1)
    expect(Array.from(out)).toEqual([0x10, 0x20, 0x33, 0x33])
  })
})

describe('OW RLE - stride and start offset (interleave behavior)', () => {
  it('stride=2 from offset 0 writes only even positions', () => {
    const out = new Uint8Array(8)
    decompressOwRleStream(toBytes([0x83, 0xaa]), 0, out, 0, 2)
    // Should write 4 copies of $AA at positions 0, 2, 4, 6
    expect(Array.from(out)).toEqual([0xaa, 0x00, 0xaa, 0x00, 0xaa, 0x00, 0xaa, 0x00])
  })

  it('stride=2 from offset 1 writes only odd positions', () => {
    const out = new Uint8Array(8)
    decompressOwRleStream(toBytes([0x83, 0xbb]), 0, out, 1, 2)
    expect(Array.from(out)).toEqual([0x00, 0xbb, 0x00, 0xbb, 0x00, 0xbb, 0x00, 0xbb])
  })

  it('two streams interleaved produce 16-bit words', () => {
    // Stream A: 4 copies of $AA → low bytes
    // Stream B: 4 copies of $BB → high bytes
    // Result: word $BBAA repeated four times
    const out = interleaveOwL2Streams(
      toBytes([0x83, 0xaa]), // stream A
      toBytes([0x83, 0xbb]), // stream B
      8, // 8 bytes total = 4 words
    )
    expect(Array.from(out)).toEqual([0xaa, 0xbb, 0xaa, 0xbb, 0xaa, 0xbb, 0xaa, 0xbb])
  })
})

describe('OW RLE - truncated input', () => {
  it('truncated literal payload stops where input runs out', () => {
    // cmd=0x05 wants 6 bytes but only 2 follow.
    const out = new Uint8Array(6)
    decompressOwRleStream(toBytes([0x05, 0xaa, 0xbb]), 0, out, 0, 1)
    expect(Array.from(out)).toEqual([0xaa, 0xbb, 0x00, 0x00, 0x00, 0x00])
  })

  it('RLE missing fill byte writes nothing for that command', () => {
    const out = new Uint8Array(4)
    decompressOwRleStream(toBytes([0x82]), 0, out, 0, 1)
    expect(Array.from(out)).toEqual([0x00, 0x00, 0x00, 0x00])
  })
})

// ── 64x64 BG quadrant addressing ─────────────────────────────────────────────

describe('tilemapByteOffset - 64x64 BG quadrant decoder', () => {
  it('layout 0 origin', () => {
    expect(tilemapByteOffset(0, 0, 0)).toBe(0)
  })
  it('layout 1 origin', () => {
    expect(tilemapByteOffset(1, 0, 0)).toBe(OW_BG_LAYOUT_BYTES)
  })
  it('TR screen begins at +$0800', () => {
    expect(tilemapByteOffset(0, 0, 32)).toBe(OW_BG_SCREEN_BYTES)
  })
  it('BL screen begins at +$1000', () => {
    expect(tilemapByteOffset(0, 32, 0)).toBe(OW_BG_SCREEN_BYTES * 2)
  })
  it('BR screen begins at +$1800', () => {
    expect(tilemapByteOffset(0, 32, 32)).toBe(OW_BG_SCREEN_BYTES * 3)
  })
  it('row stride within a screen is $40 bytes', () => {
    expect(tilemapByteOffset(0, 1, 0) - tilemapByteOffset(0, 0, 0)).toBe(0x40)
  })
  it('col stride within a screen is 2 bytes', () => {
    expect(tilemapByteOffset(0, 0, 1) - tilemapByteOffset(0, 0, 0)).toBe(2)
  })
  it('mid-screen sample (row 5, col 7 in TL)', () => {
    expect(tilemapByteOffset(0, 5, 7)).toBe(5 * 0x40 + 7 * 2)
  })
  it('layout 1 BR last entry', () => {
    expect(tilemapByteOffset(1, 63, 63)).toBe(
      OW_BG_LAYOUT_BYTES + OW_BG_SCREEN_BYTES * 3 + 31 * 0x40 + 31 * 2,
    )
  })
  it('row >= 64 wraps mod 64 (camera-scroll wrap)', () => {
    // row 64 should map to row 0
    expect(tilemapByteOffset(0, 64, 0)).toBe(tilemapByteOffset(0, 0, 0))
    expect(tilemapByteOffset(0, 79, 5)).toBe(tilemapByteOffset(0, 15, 5))
  })
  it('col >= 64 wraps mod 64 (e.g. YI camera at col 61 + width 29 → col 89 wraps to 25)', () => {
    expect(tilemapByteOffset(0, 0, 64)).toBe(tilemapByteOffset(0, 0, 0))
    expect(tilemapByteOffset(0, 0, 89)).toBe(tilemapByteOffset(0, 0, 25))
  })
  it('negative row/col wrap', () => {
    expect(tilemapByteOffset(0, -1, -1)).toBe(tilemapByteOffset(0, 63, 63))
  })
})

describe('map16ByteOffset - Map16TilesLow quadrant decoder', () => {
  it('layout 0 origin', () => {
    expect(map16ByteOffset(0, 0, 0)).toBe(0)
  })
  it('layout 1 origin', () => {
    expect(map16ByteOffset(1, 0, 0)).toBe(0x400)
  })
  it('TR chunk begins at +$100', () => {
    expect(map16ByteOffset(0, 0, 16)).toBe(0x100)
  })
  it('BL chunk begins at +$200', () => {
    expect(map16ByteOffset(0, 16, 0)).toBe(0x200)
  })
  it('BR chunk begins at +$300', () => {
    expect(map16ByteOffset(0, 16, 16)).toBe(0x300)
  })
  it('mid-chunk sample (row 3, col 5 in TL)', () => {
    expect(map16ByteOffset(0, 3, 5)).toBe(3 * 16 + 5)
  })
})

// ── Event-driven tile swaps ──────────────────────────────────────────────────

describe('OverworldEvents - bit indexing + apply swaps', () => {
  it('isEventActivated reads bit 7 of byte 0 as event 0 (MSB-first)', () => {
    const bits = new Uint8Array(15)
    bits[0] = 0x80
    expect(isEventActivated(bits, 0)).toBe(true)
    expect(isEventActivated(bits, 1)).toBe(false)
    expect(isEventActivated(bits, 7)).toBe(false)
  })

  it('event 7 = bit 0 of byte 0', () => {
    const bits = new Uint8Array(15)
    bits[0] = 0x01
    expect(isEventActivated(bits, 7)).toBe(true)
    expect(isEventActivated(bits, 6)).toBe(false)
  })

  it('event 8 = bit 7 of byte 1', () => {
    const bits = new Uint8Array(15)
    bits[1] = 0x80
    expect(isEventActivated(bits, 8)).toBe(true)
  })

  it('out-of-range index returns false safely', () => {
    expect(isEventActivated(new Uint8Array(15), -1)).toBe(false)
    expect(isEventActivated(new Uint8Array(15), OW_EVENT_COUNT)).toBe(false)
    expect(isEventActivated(new Uint8Array(15), OW_EVENT_COUNT + 50)).toBe(false)
  })

  it('allEventsActivated produces 15 bytes of $FF', () => {
    const all = allEventsActivated()
    expect(all.length).toBe(15)
    expect(all.every(b => b === 0xff)).toBe(true)
  })

  it('applyEventSwaps replaces a single tile when its event bit is set', () => {
    const map16 = new Uint8Array(256)
    map16[0x42] = 0x6e // matches fromTiles[0]
    const tables: OwEventTables = {
      events: [{ bitIndex: 0, primaryOffset: 0x42, secondaryOffset: 0 }],
      fromTiles: Uint8Array.from([0x6e]),
      toTiles: Uint8Array.from([0x66]),
    }
    const out = applyEventSwaps(map16, tables, allEventsActivated())
    expect(out[0x42]).toBe(0x66)
    expect(out).not.toBe(map16) // returns a new buffer, doesn't mutate input
  })

  it('applyEventSwaps leaves the buffer untouched when no events are active', () => {
    const map16 = new Uint8Array(256)
    map16[0x10] = 0x6e
    const tables: OwEventTables = {
      events: [{ bitIndex: 0, primaryOffset: 0x10, secondaryOffset: 0 }],
      fromTiles: Uint8Array.from([0x6e]),
      toTiles: Uint8Array.from([0x66]),
    }
    const out = applyEventSwaps(map16, tables, noEventsActivated())
    expect(Array.from(out)).toEqual(Array.from(map16))
  })

  it('applyEventSwaps skips events with zero primary offset (unused slots)', () => {
    const map16 = new Uint8Array(256)
    map16[0] = 0x6e
    const tables: OwEventTables = {
      events: [{ bitIndex: 0, primaryOffset: 0, secondaryOffset: 0 }],
      fromTiles: Uint8Array.from([0x6e]),
      toTiles: Uint8Array.from([0x66]),
    }
    const out = applyEventSwaps(map16, tables, allEventsActivated())
    expect(out[0]).toBe(0x6e) // unchanged because offset 0 = unused slot
  })

  it('applyEventSwaps skips events whose current tile is not in fromTiles', () => {
    const map16 = new Uint8Array(256)
    map16[0x10] = 0xff // not in fromTiles
    const tables: OwEventTables = {
      events: [{ bitIndex: 0, primaryOffset: 0x10, secondaryOffset: 0 }],
      fromTiles: Uint8Array.from([0x6e]),
      toTiles: Uint8Array.from([0x66]),
    }
    const out = applyEventSwaps(map16, tables, allEventsActivated())
    expect(out[0x10]).toBe(0xff)
  })
})
