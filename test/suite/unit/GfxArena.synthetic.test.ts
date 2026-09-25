/**
 * The GFX arena: where the 50 compressed files sit, how much room they have,
 * and what a repack writes.
 *
 * **Synthetic cartridges only.** No bytes here come from any Super Mario
 * World ROM or derived resource, so this runs in CI where the corpus is
 * absent by design. The instruction sequences planted below are written from
 * the 65816 encoding, not copied out of a cart: they exist so the resolver
 * and the refusals have something to resolve and refuse.
 *
 * Every refusal gets a planted defect proving it goes red, because a refusal
 * that cannot fire is worse than no refusal at all.
 */
import { describe, it, expect } from 'vitest'
import { encode } from '../../../src/rom/LcLz2'
import { loromFromOffset } from '../../../src/rom/addressing'
import { RomFile } from '../../../src/rom/RomFile'
import {
  GFX_FILE_COUNT,
  STOCK_LCLZ2_ENTRY,
  checkStockCompression,
  layoutArena,
  matchesHook,
  planRegions,
  readGfxFileTable,
  readGfxPointerSites,
} from '../../../src/rom/GfxArena'
import {
  applyWrites,
  buildCart,
  CART_SIZE,
  DECOMP_ENTRY,
  gfxStreams as freshStreams,
  HOOK_EXGFX_OPERANDS,
  HOOK_RANGE_A_LENGTH,
  HOOK_RANGE_A_OFFSET,
  HOOK_RANGE_B_LENGTH,
  HOOK_RANGE_B_OFFSET,
  HOOK_TABLE_OFFSET,
  HOOK_TAIL_OFFSET,
  jsl,
  OPERAND_POSITIONS,
  plantHookSignature,
  prepareGraphicsFile,
  ROUTINE_AT,
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
} from '../support/syntheticGfxCart'

// Pinned by literal, not imported from GfxArena: a wrong LEVEL_GFX_CALLERS
// constant must not be able to hide behind the synthetic ROM using it too.
const PRIMARY_CALLER = 0x00aa6b
const SPECIAL_WORLD_CALLER = 0x00aa7a
const HOOK_AT = 0x019000 // bank 1, unused by any other fixture in this file

/** The 3-byte spans `matchesHook`'s fingerprint masks: not part of "every
 *  byte flipped must refuse", since the ROM is free to vary them. */
const HOOK_MASKED_SPANS: readonly [number, number][] = [
  [HOOK_TABLE_OFFSET + 4, HOOK_TABLE_OFFSET + 7],
  [HOOK_TABLE_OFFSET + 10, HOOK_TABLE_OFFSET + 13],
  [HOOK_TABLE_OFFSET + 16, HOOK_TABLE_OFFSET + 19],
  [HOOK_TAIL_OFFSET + 9, HOOK_TAIL_OFFSET + 12],
  ...HOOK_EXGFX_OPERANDS.map((o): [number, number] => [o, o + 3]),
]
const isHookMasked = (offset: number): boolean =>
  HOOK_MASKED_SPANS.some(([start, end]) => offset >= start && offset < end)

// Erases whatever buildCart's default plant left near the real call sites,
// so a test's own literal-addressed write is what the resolver actually
// finds, not a coincidence of the default landing nearby too.
function clearCallers(rom: RomFile): void {
  rom.writeAt(0x00aa50, new Array(0x40).fill(0xea))
}

describe('readGfxPointerSites', () => {
  it('reads the pointer tables and the decompressor entry out of the routine', () => {
    const sites = readGfxPointerSites(buildCart().rom)
    expect(sites).not.toBeNull()
    expect(sites!.lo).toBe(TABLE_LO)
    expect(sites!.hi).toBe(TABLE_HI)
    expect(sites!.bank).toBe(TABLE_BANK)
    expect(sites!.decompressorEntry).toBe(DECOMP_ENTRY)
  })

  it('follows relocated tables rather than assuming the vanilla addresses', () => {
    const routine = prepareGraphicsFile(0x9100, 0x9132, 0x9164, DECOMP_ENTRY)
    const sites = readGfxPointerSites(buildCart({ routine }).rom)
    expect(sites!.lo).toBe(0x9100)
    expect(sites!.hi).toBe(0x9132)
    expect(sites!.bank).toBe(0x9164)
  })

  it('refuses when the routine is not there at all', () => {
    expect(readGfxPointerSites(buildCart({ routine: [0x60] }).rom)).toBeNull()
  })

  it('excludes exactly the wildcards from the sweep, and no more', () => {
    // Guards the sweep below against the blind spot it used to carry. The
    // exclusion list is now derived from the pattern, so this pins the
    // COUNT independently: widening the pattern by an accidental wildcard
    // would silently shrink the sweep, and this case notices.
    expect(OPERAND_POSITIONS.size).toBe(14)
    for (const forbidden of [20, 24, 28]) {
      // The $00 / $AD / $7E immediates that build the $7EAD00 output-buffer
      // pointer. The pattern matches them literally, so the sweep must
      // plant defects in them rather than skip them.
      expect(OPERAND_POSITIONS.has(forbidden)).toBe(false)
    }
  })

  it('refuses on a planted defect at every non-operand byte of the routine', () => {
    // A resolver that only notices a defect in byte 0 is not a resolver.
    const clean = prepareGraphicsFile(TABLE_LO, TABLE_HI, TABLE_BANK, DECOMP_ENTRY)
    const survived: number[] = []
    for (let i = 0; i < clean.length; i++) {
      if (OPERAND_POSITIONS.has(i)) continue
      const routine = [...clean]
      routine[i] = (routine[i]! + 1) & 0xff
      if (readGfxPointerSites(buildCart({ routine }).rom) !== null) survived.push(i)
    }
    expect(survived).toEqual([])
  })

  it("resolves the tables and decompressor entry in the routine's own relocated bank", () => {
    const streams = freshStreams()
    const { rom } = buildCart({ bank: 1, streams, filler: 64 })
    const sites = readGfxPointerSites(rom)
    expect(sites).not.toBeNull()
    const banks = [sites!.lo, sites!.hi, sites!.bank, sites!.decompressorEntry].map(a => a >>> 16)
    expect(banks).toEqual([1, 1, 1, 1])

    const r = layoutArena(rom, streams)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    for (const w of r.plan.writes.slice(-3)) expect(w.offset).toBeGreaterThanOrEqual(0x8000)
  })

  it('accepts a primary call reaching the matched routine directly through the FastROM mirror', () => {
    const { rom } = buildCart()
    clearCallers(rom)
    const mirrored = loromFromOffset(ROUTINE_AT)! | 0x800000
    rom.writeAt(PRIMARY_CALLER, jsl(mirrored))
    expect(readGfxPointerSites(rom)).not.toBeNull()
  })

  it('refuses when the primary call points elsewhere, even though the special-world call reaches the routine', () => {
    // The special-world call alone proves nothing about normal levels: it
    // only runs for one case (bank_00.asm:5403-5406).
    const { rom } = buildCart()
    clearCallers(rom)
    const matched = loromFromOffset(ROUTINE_AT)!
    rom.writeAt(PRIMARY_CALLER, jsl(0x008000)) // neither the routine nor the hook
    rom.writeAt(SPECIAL_WORLD_CALLER, jsl(matched))
    expect(readGfxPointerSites(rom)).toBeNull()
  })
})

describe('matchesHook', () => {
  it('accepts a synthetic hook signature whose own fingerprint is passed in, tables and JML agreeing', () => {
    const { rom } = buildCart()
    const jsrAt = loromFromOffset(ROUTINE_AT)! + 0x1f
    const fingerprint = plantHookSignature(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt)
    expect(matchesHook(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt, [fingerprint])).toBe(
      true,
    )
  })

  it('accepts a hook whose JML operand reaches the JSR through the FastROM mirror', () => {
    const { rom } = buildCart()
    const jsrAt = loromFromOffset(ROUTINE_AT)! + 0x1f
    const fingerprint = plantHookSignature(
      rom,
      HOOK_AT,
      TABLE_LO,
      TABLE_HI,
      TABLE_BANK,
      jsrAt | 0x800000,
    )
    expect(matchesHook(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt, [fingerprint])).toBe(
      true,
    )
  })

  it('refuses a hook-shaped signature whose fingerprint is not a recognized one', () => {
    // No override: falls back to the real, corpus-measured table, which a
    // synthetic (all-NOP) signature cannot hash to.
    const { rom } = buildCart()
    const jsrAt = loromFromOffset(ROUTINE_AT)! + 0x1f
    plantHookSignature(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt)
    expect(matchesHook(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt)).toBe(false)
  })

  it('refuses a hook whose table operand was relocated', () => {
    const { rom } = buildCart()
    const jsrAt = loromFromOffset(ROUTINE_AT)! + 0x1f
    const fingerprint = plantHookSignature(
      rom,
      HOOK_AT,
      TABLE_LO + 0x40,
      TABLE_HI,
      TABLE_BANK,
      jsrAt,
    )
    expect(matchesHook(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt, [fingerprint])).toBe(
      false,
    )
  })

  it('refuses a hook whose JML target is wrong', () => {
    const { rom } = buildCart()
    const matched = loromFromOffset(ROUTINE_AT)!
    const fingerprint = plantHookSignature(
      rom,
      HOOK_AT,
      TABLE_LO,
      TABLE_HI,
      TABLE_BANK,
      matched + 0x20,
    )
    expect(
      matchesHook(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, matched + 0x1f, [fingerprint]),
    ).toBe(false)
  })

  it('refuses on a planted defect at every byte of both ranges, except the masked operands', () => {
    // The defect this exists to catch: a fixed offset confirms bytes exist
    // there but never checks the path between them, so a retargeted hop or
    // a changed branch anywhere else in the hook survived undetected.
    const { rom } = buildCart()
    const jsrAt = loromFromOffset(ROUTINE_AT)! + 0x1f
    const fingerprint = plantHookSignature(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt)
    const survived: number[] = []
    for (const [rangeOffset, rangeLength] of [
      [HOOK_RANGE_A_OFFSET, HOOK_RANGE_A_LENGTH],
      [HOOK_RANGE_B_OFFSET, HOOK_RANGE_B_LENGTH],
    ] as const) {
      for (let i = 0; i < rangeLength; i++) {
        const offset = rangeOffset + i
        if (isHookMasked(offset)) continue
        const at = HOOK_AT + offset
        const original = rom.readAt(at, 1)![0]!
        rom.writeAt(at, [(original + 1) & 0xff])
        if (matchesHook(rom, HOOK_AT, TABLE_LO, TABLE_HI, TABLE_BANK, jsrAt, [fingerprint])) {
          survived.push(offset)
        }
        rom.writeAt(at, [original])
      }
    }
    expect(survived).toEqual([])
  })
})

describe('checkStockCompression', () => {
  it('passes a cartridge whose decompressor entry is the stock prologue', () => {
    expect(checkStockCompression(buildCart().rom).ok).toBe(true)
  })

  it('refuses when the entry has been replaced, and says so', () => {
    // The shape Invictus 1.0 has here: two JSLs and an RTS, so control never
    // reaches the stock loop. Written from the 65816 encoding, not lifted
    // from the cart.
    const entryBytes = [0x22, 0x00, 0x00, 0x20, 0xea, 0x22, 0x00, 0x00, 0x20, 0x60]
    const r = checkStockCompression(buildCart({ entryBytes }).rom)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/LC_LZ2/i)
  })

  it('refuses on a planted defect at every byte of the entry', () => {
    const survived: number[] = []
    for (let i = 0; i < STOCK_LCLZ2_ENTRY.length; i++) {
      const entryBytes = [...STOCK_LCLZ2_ENTRY]
      entryBytes[i] = (entryBytes[i]! + 1) & 0xff
      if (checkStockCompression(buildCart({ entryBytes }).rom).ok) survived.push(i)
    }
    expect(survived).toEqual([])
  })

  it('refuses when the routine that reaches the decompressor is gone', () => {
    // Existing is not the same as reached: the entry can be pristine while
    // nothing calls it, so with no resolvable call site this fails closed.
    expect(checkStockCompression(buildCart({ routine: [0x60] }).rom).ok).toBe(false)
  })

  it('names the call site and its target when the primary call cannot reach it', () => {
    const { rom } = buildCart()
    clearCallers(rom)
    rom.writeAt(PRIMARY_CALLER, jsl(0x008000))
    const r = checkStockCompression(rom)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/\$00AA6B/i)
    expect(r.reason).toMatch(/\$008000/i)
  })
})

describe('readGfxFileTable', () => {
  it('measures every file the pointer tables name', () => {
    const streams = freshStreams()
    const { rom, offsets } = buildCart({ streams })
    const table = readGfxFileTable(rom)

    expect(table.length).toBe(GFX_FILE_COUNT)
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      expect(table[i]!.offset).toBe(offsets[i])
      expect(table[i]!.byteLength).toBe(streams[i]!.length)
      expect(table[i]!.outputLength).toBe(96)
      expect(table[i]!.terminated).toBe(true)
    }
  })

  it('marks an unterminated stream rather than reporting a length it guessed', () => {
    const streams = freshStreams()
    streams[0] = Uint8Array.from([0x00, 0x01]) // runs off the end of the cart
    const { rom } = buildCart({ streams, outliers: { 0: CART_SIZE - 2 } })
    expect(readGfxFileTable(rom)[0]!.terminated).toBe(false)
  })
})

describe('planRegions', () => {
  it('finds one region when every file is packed', () => {
    const { rom } = buildCart({ filler: 40 })
    const regions = planRegions(rom, readGfxFileTable(rom))

    expect(regions.length).toBe(1)
    expect(regions[0]!.files.length).toBe(GFX_FILE_COUNT)
    expect(regions[0]!.capacity).toBe(regions[0]!.used + 40)
  })

  it('leaves a file placed away from the cluster in its own region', () => {
    // Grand Poo World keeps 47 packed and 3 elsewhere; gathering those in
    // would move data the hack deliberately placed.
    const { rom } = buildCart({ outliers: { 2: 0x8200 } })
    const regions = planRegions(rom, readGfxFileTable(rom))

    expect(regions.length).toBe(2)
    const outlier = regions.find(r => r.start === 0x8200)
    expect(outlier).toBeDefined()
    expect(outlier!.files).toEqual([2])
  })

  it('stops counting filler at the bank boundary', () => {
    // A longer run of $FF is not evidence that nothing else owns it. The
    // bank is where vanilla's own free space ends (SMWDisX freespace.txt
    // gives $0BFD0D..$0BFFFF, $2F3 bytes, on the U cart), and claiming past
    // it would be a guess dressed as a measurement.
    const arenaAt = 0xc000
    const { rom } = buildCart({ arenaAt, filler: 0x4000 }) // filler crosses $10000
    const regions = planRegions(rom, readGfxFileTable(rom))
    expect(regions.length).toBe(1)
    expect(regions[0]!.start).toBe(arenaAt)
    expect(regions[0]!.capacity).toBe(0x10000 - arenaAt)
  })
})

describe('layoutArena', () => {
  it('reproduces the cartridge byte for byte when nothing changed', () => {
    const streams = freshStreams()
    const { rom } = buildCart({ streams, filler: 64 })
    const r = layoutArena(rom, streams)

    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.plan.writes.length).toBeGreaterThan(0)
    for (const w of r.plan.writes) {
      const current = rom.readAtFileOffset(w.offset, w.bytes.length)!
      expect(Buffer.compare(Buffer.from(w.bytes), current)).toBe(0)
    }
  })

  it('re-points every pointer at the stream it now names', () => {
    const base = freshStreams()
    const { rom } = buildCart({ streams: base, filler: 512 })
    // File 0 grows, which shifts all 49 behind it: the pointer rewrite is
    // the only thing that keeps them findable.
    const grown = [...base]
    grown[0] = encode(Uint8Array.from({ length: 96 }, (_, k) => (k * 97) & 0xff))
    const r = layoutArena(rom, grown)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    const after = applyWrites(rom, r.plan.writes)
    const table = readGfxFileTable(after)
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      const at = table[i]!.offset
      expect(at, `file ${i} pointer does not resolve`).not.toBeNull()
      const got = after.readAtFileOffset(at!, grown[i]!.length)!
      expect(Buffer.compare(got, Buffer.from(grown[i]!)), `file ${i} bytes`).toBe(0)
      expect(table[i]!.outputLength).toBe(96)
    }
  })

  it('refuses with the exact overage, swept rather than sampled', () => {
    // A bound tuned to one convenient size is the defect CLAUDE.md names.
    const base = freshStreams()
    const slack = 16
    const { rom } = buildCart({ streams: base, filler: slack })
    const wrong: string[] = []
    for (let delta = -8; delta <= 40; delta++) {
      const grown = [...base]
      grown[7] = resizedStream(base[7]!, delta)
      const r = layoutArena(rom, grown)
      const expected = delta - slack
      if (expected > 0) {
        if (r.status !== 'overflow' || r.overage !== expected) {
          wrong.push(`${delta}: ${r.status}/${r.status === 'overflow' ? r.overage : '-'}`)
        }
      } else if (r.status !== 'ok') {
        wrong.push(`${delta}: ${r.status}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('names the blocked dependency when it refuses for space', () => {
    const base = freshStreams()
    const { rom } = buildCart({ streams: base, filler: 0 })
    const grown = [...base]
    grown[3] = resizedStream(base[3]!, 3)
    const r = layoutArena(rom, grown)
    expect(r.status).toBe('overflow')
    if (r.status !== 'overflow') return
    expect(r.overage).toBe(3)
    expect(r.reason).toMatch(/446/)
  })

  it('refuses a cartridge whose decompressor has been replaced', () => {
    const streams = freshStreams()
    const entryBytes = [0x22, 0, 0, 0x20, 0xea, 0x22, 0, 0, 0x20, 0x60]
    const r = layoutArena(buildCart({ streams, entryBytes }).rom, streams)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/LC_LZ2/i)
  })

  it('refuses when the stream for any one of the 50 files is missing', () => {
    const streams = freshStreams()
    const { rom } = buildCart({ streams })
    const accepted: number[] = []
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      const partial: (Uint8Array | undefined)[] = [...streams]
      partial[i] = undefined
      if (layoutArena(rom, partial as Uint8Array[]).status !== 'unavailable') accepted.push(i)
    }
    expect(accepted).toEqual([])
  })

  it('refuses when a file the cartridge names cannot be read back', () => {
    const streams = freshStreams()
    streams[0] = Uint8Array.from([0x00, 0x01])
    const { rom } = buildCart({ streams, outliers: { 0: CART_SIZE - 2 } })
    expect(layoutArena(rom, streams).status).toBe('unavailable')
  })

  it('erases the tail it reclaims rather than leaving stale bytes behind', () => {
    const base = freshStreams()
    const { rom } = buildCart({ streams: base, filler: 0 })
    const before = planRegions(rom, readGfxFileTable(rom))[0]!
    const shrunk = [...base]
    shrunk[0] = encode(new Uint8Array(96).fill(0x55))
    expect(shrunk[0]!.length).toBeLessThan(base[0]!.length)

    const r = layoutArena(rom, shrunk)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const after = applyWrites(rom, r.plan.writes)
    const reclaimed = base[0]!.length - shrunk[0]!.length
    const tail = after.readAtFileOffset(before.start + before.used - reclaimed, reclaimed)!
    expect(Buffer.compare(tail, Buffer.alloc(reclaimed, 0xff))).toBe(0)
  })
})

/**
 * The same stream, `delta` bytes longer or shorter.
 *
 * Growth is padding PAST the terminator, which the decompressor never reads:
 * layout cares only about the byte count, and a one-byte delta cannot be
 * expressed as a command (a header plus its payload is at least two).
 */
function resizedStream(stream: Uint8Array, delta: number): Uint8Array {
  if (delta >= 0) return Uint8Array.from([...stream, ...new Array<number>(delta).fill(0)])
  return stream.subarray(0, stream.length + delta)
}
