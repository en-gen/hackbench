/**
 * Lunar Magic's stored translevel table on synthetic ROMs: each layout reads,
 * translevels come from the table rather than a count, every pinned byte of
 * the walk entry is load-bearing, the two recognized replacement decompressors
 * read (the key applied, fast-only commands refused), and any other refuses.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { encode } from '../../../src/rom/LcLz2'
import { ENTER_COMPARE, deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { WILD } from '../../../src/rom/BytePattern'
import { STOCK_LCLZ2_ENTRY } from '../../../src/rom/GfxDecompressor'
import { blankStockRom, flip, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'
import {
  BACKREF_AT,
  BACKREF_DISPATCH,
  backRefRoutine,
  plantBackRef,
  DECOMP_ENTRY,
  DISPATCH_AT,
  FAST_DIVERGENT_COMMANDS,
  PRELUDE_KEY_BYTES,
  plantFast,
  plantPrelude,
  syntheticRoutine,
  xorPrelude,
} from '../support/syntheticGfxCart'

const ENTRY = 0x04d7f2
const TABLE_AT = 0x0e8000

/** The walk entry as Lunar Magic lays it out, from its parts; `pinned` marks bytes the reader checks. */
function lmEntry(bankFirst: boolean, blocks: 1 | 2, fastRom = false, key = 0) {
  const bytes: number[] = []
  const pinned: boolean[] = []
  const put = (b: number[], pin = true): void => {
    bytes.push(...b)
    b.forEach(() => pinned.push(pin))
  }
  const source = (addr: number): void => {
    const [lo, hi, bank] = [addr & 0xff, (addr >> 8) & 0xff, addr >> 16]
    for (const [op, operand, sta] of bankFirst
      ? ([
          [0xa9, [bank], 0x8c],
          [0xa2, [lo, hi], 0x8a],
        ] as const)
      : ([
          [0xa2, [lo, hi], 0x8a],
          [0xa9, [bank], 0x8c],
        ] as const)) {
      put([op])
      put([...operand], false)
      put(sta === 0x8a ? [0x86, 0x8a] : [0x85, 0x8c])
    }
  }
  // prettier-ignore
  const call = (): void =>
    put([0x08, 0x4b, 0x62, 0x06, 0x00, 0xf4, 0x4c, 0x80, 0x5c, 0xde, 0xb8, fastRom ? 0x80 : 0, 0x28])
  put([0xc2, 0x30, 0xa9, 0x00, 0x00, 0xe2, 0x20])
  put([0xa2, 0x00, 0xd0, 0x86, 0x00, 0xa9, 0x7e, 0x85, 0x02])
  source(TABLE_AT ^ key)
  call()
  if (blocks === 2) {
    put([0xa2, 0x00, 0xc8, 0x86, 0x00, 0xa9, 0x7f, 0x85, 0x02])
    source(TABLE_AT ^ key)
    call()
  }
  put([0x80, 0x10])
  return { bytes, pinned }
}

const PRELUDE_AT = 0x018000
const FAST_AT = 0x019000
const FAST_LENGTH = 0x1bc
/** CODE_00B8DE's $AF-byte body from entry+5: the stock entry's tail, then arithmetic. */
const BODY_AT = DECOMP_ENTRY + 5
const BODY = [...STOCK_LCLZ2_ENTRY.slice(5), ...syntheticRoutine(0xaf - 5, 3).bytes]
// The gate follows the dispatch to the back-reference routine, so the body carries both.
BODY.splice(DISPATCH_AT - 5, BACKREF_DISPATCH.length, ...BACKREF_DISPATCH)
BODY.splice(BACKREF_AT - 5, backRefRoutine('be').length, ...backRefRoutine('be'))
const KNOWN = {
  stockBody: [createHash('sha256').update(Buffer.from(BODY)).digest('hex')],
  fast: [{ length: FAST_LENGTH, fingerprint: syntheticRoutine(FAST_LENGTH).sha }],
}

interface Decomp {
  /** The prelude's key; the caller's operand is keyed with `stored`. */
  key?: number
  stored?: number
  fast?: boolean
  /** The stored stream as is, in place of `table` encoded. */
  raw?: number[]
  /** The XBA form of the back-reference routine behind the entry. */
  le?: boolean
}

function build(
  table: Uint8Array,
  entry?: ReturnType<typeof lmEntry>,
  { key, stored = key, fast, raw, le }: Decomp = {},
): RomFile {
  entry ??= lmEntry(false, 2, false, stored)
  const rom = blankStockRom()
  rom.writeAt(ENTRY, entry.bytes)
  rom.writeAt(ENTRY + entry.bytes.length + 0x10, [0x64, 0x0f, 0x20, 0x49, 0xda])
  rom.writeAt(0x00804d, [0x6b])
  rom.writeAt(DECOMP_ENTRY, STOCK_LCLZ2_ENTRY)
  rom.writeAt(BODY_AT, BODY)
  if (le) plantBackRef(rom, 'le')
  if (key !== undefined) plantPrelude(rom, PRELUDE_AT, key)
  if (fast) plantFast(rom, FAST_AT, FAST_LENGTH)
  rom.writeAt(TABLE_AT, raw ?? [...encode(table)])
  return rom
}
const derive = (rom: RomFile, known = KNOWN) =>
  deriveOverworldEntrances(new SmwRom(rom), undefined, {
    ...SYNTHETIC_FINGERPRINTS,
    decompressor: known,
  })
const tableOf = (entries: Record<number, number>): Uint8Array => {
  const t = new Uint8Array(0x1000)
  for (const [i, tl] of Object.entries(entries)) t[Number(i)] = tl
  return t
}
const walked = (rom: RomFile): number[][] =>
  derive(rom).entrances.map(e => [e.bufferIndex, e.translevel, e.slot])

describe('deriveOverworldEntrances: OWPU_NotOnPipe tile compare', () => {
  const entrances = (rom: RomFile) => derive(rom).entrances
  it('leaves stock classification verified', () => {
    expect(entrances(build(tableOf({ 0x01: 1 })))[0]).not.toHaveProperty('actionUnverified')
  })

  it.each(ENTER_COMPARE.flatMap((b, i) => (b === WILD ? [] : [i])))(
    'marks every entrance unverified with compare byte %i flipped, roots unchanged',
    i => {
      const stock = derive(build(tableOf({ 0x01: 1, 0x420: 0x30 })))
      const rom = build(tableOf({ 0x01: 1, 0x420: 0x30 }))
      rom.writeAt(0x049199 + i, [ENTER_COMPARE[i]! ^ 0xff])
      const result = derive(rom)
      expect(result.roots).toEqual(stock.roots)
      for (const e of result.entrances) expect(e.actionUnverified).toContain('OWPU_NotOnPipe')
    },
  )
})

describe('deriveOverworldEntrances: Lunar Magic stored translevels', () => {
  it.each([
    [false, 1],
    [false, 2],
    [true, 1],
    [true, 2],
  ] as const)('reads the table with bank-first %s and %i block(s)', (bankFirst, blocks) => {
    for (const fastRom of [false, true]) {
      const rom = build(tableOf({ 0x10: 3, 0x420: 0x30 }), lmEntry(bankFirst, blocks, fastRom))
      // $30 is past #601's threshold: slot $10C on either map.
      expect(walked(rom)).toEqual([
        [0x10, 3, 0x003],
        [0x420, 0x30, 0x10c],
      ])
    }
  })

  it('moves an entrance with its table entry', () => {
    expect(walked(build(tableOf({ 0x07: 9, 0x06: 2 })))).toEqual([
      [0x06, 2, 0x002],
      [0x07, 9, 0x009],
    ])
  })

  it('ignores the table past $800, the directions the game keeps there', () => {
    expect(walked(build(tableOf({ 0x01: 1, 0x801: 5 })))).toEqual([[0x01, 1, 0x001]])
  })

  const entry = lmEntry(false, 2)
  const pinned = entry.bytes.flatMap((_, i) => (entry.pinned[i] ? [i] : []))
  it.each(pinned)('refuses with entry byte %i flipped', i => {
    const rom = build(tableOf({ 0x01: 1 }), entry)
    rom.writeAt(ENTRY + i, [entry.bytes[i]! ^ 0xff])
    expect(derive(rom).overworldReadable).toBe(false)
  })

  it.each([
    ['the stock tail', ENTRY + entry.bytes.length + 0x10],
    ['the RTL at $00804D', 0x00804d],
  ])('refuses without %s', (_what, at) => {
    const rom = build(tableOf({ 0x01: 1 }))
    rom.writeAt(at, [0x00])
    expect(derive(rom).overworldReadable).toBe(false)
  })

  it('reads through the XOR prelude, for two keys, and only with the key it holds', () => {
    const t = tableOf({ 0x10: 3, 0x420: 0x30 })
    for (const key of [0x0300, 0x5aa5]) {
      expect(walked(build(t, undefined, { key })), `key ${key}`).toEqual([
        [0x10, 3, 0x003],
        [0x420, 0x30, 0x10c],
      ])
    }
    expect(derive(build(t, undefined, { key: 0x5aa5, stored: 0x0300 })).overworldReadable).toBe(
      false,
    )
  })

  it('reads through the fast routine, and behind the prelude', () => {
    const t = tableOf({ 0x07: 9 })
    expect(walked(build(t, undefined, { fast: true }))).toEqual([[0x07, 9, 0x009]])
    expect(walked(build(t, undefined, { fast: true, key: 0x0300 }))).toEqual([[0x07, 9, 0x009]])
  })

  it.each(FAST_DIVERGENT_COMMANDS)(
    'refuses %s on the fast routine and reads it on stock',
    (_, command) => {
      // A literal, the command (a copy on stock), then the table.
      const raw = [0x00, 0x11, ...command, ...encode(tableOf({ 0x07: 9 }))]
      expect(derive(build(new Uint8Array(), undefined, { raw })).overworldReadable).toBe(true)
      const fast = derive(build(new Uint8Array(), undefined, { raw, fast: true }))
      expect(fast.overworldReadable).toBe(false)
      expect(fast.notes[0]).toMatch(/reads differently from stock/)
    },
  )

  it.each([
    ['an entry JSL to something else', { key: 0x0300 }, PRELUDE_AT, /\$00B8DE.*calls \$018000/],
    ['a JSL body that is not a known routine', { fast: true }, FAST_AT, /calls \$019000/],
    ['a stock entry with another body', {}, BODY_AT, /\$00B8DE.*unrecognized body/],
    [
      'a stock entry with an unknown build',
      {},
      BODY_AT + 0x20,
      /the translevel decompressor at \$00B8DE .*body is not a recognized build/,
    ],
  ] as const)('refuses %s, naming it', (_what, opts, at, reason) => {
    const rom = build(tableOf({ 0x01: 1 }), undefined, opts)
    flip(rom, at)
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.notes[0]).toMatch(reason)
    // Only the translevel table is refused; this check says nothing about GFX.
    if (at === BODY_AT + 0x20) expect(result.notes[0]).not.toMatch(/GFX/)
  })

  // Every pinned byte on each accepted build: entry, prelude less its key, stock body, fast body.
  type Case = [what: string, opts: Decomp, at: number]
  const span = (what: string, opts: Decomp, at: number, n: number, skip: number[] = []): Case[] =>
    [...Array(n).keys()].filter(i => !skip.includes(i)).map(i => [what, opts, at + i])
  const keyed = { key: 0x0300 }
  const sweep: Case[] = [
    ...span('stock', {}, DECOMP_ENTRY, 5 + 0xaf),
    ...span('keyed', keyed, DECOMP_ENTRY, 5),
    ...span('keyed', keyed, PRELUDE_AT, xorPrelude(0).length, PRELUDE_KEY_BYTES),
    ...span('keyed', keyed, BODY_AT, 0xaf),
    ...span('fast', { fast: true }, BODY_AT, 5),
    ...span('fast', { fast: true }, FAST_AT, FAST_LENGTH),
  ]
  it('refuses with any pinned decompressor byte flipped', () => {
    // One ROM per variant, each byte flipped and flipped back: building a ROM
    // per byte took ~37 s under CI coverage (#385).
    const roms = new Map<string, RomFile>()
    const survived = sweep.flatMap(([what, opts, at]) => {
      let rom = roms.get(what)
      if (!rom) {
        rom = build(tableOf({ 0x01: 1 }), undefined, opts)
        if (!derive(rom).overworldReadable) return [`${what} unflipped refused`]
        roms.set(what, rom)
      }
      flip(rom, at)
      const readable = derive(rom).overworldReadable
      flip(rom, at)
      return readable ? [`${what} $${at.toString(16)}`] : []
    })
    expect(sweep.length).toBe(0xb4 + 5 + 15 + 0xaf + 5 + FAST_LENGTH)
    expect(survived).toEqual([])
    // Every flip was undone, so each variant still reads; a missed restore
    // would refuse later bytes for the wrong reason and hide a survivor.
    for (const [what, rom] of roms) expect(derive(rom).overworldReadable, what).toBe(true)
  }, 90_000) // ~900 derives; the default 5 s is too tight under a full parallel run

  it('refuses a table shorter than the $800 tiles', () => {
    const rom = build(new Uint8Array(0x7ff))
    expect(derive(rom).notes[0]).toContain('short of $800')
  })
})

describe('deriveOverworldEntrances: little-endian back-references', () => {
  // 7 zeros, the literal 9, then a 1-byte copy from index 7 (so index 8 is 9 too), then zeros to $800.
  const stream = (addr: [number, number]): number[] => [
    0x26,
    0x00,
    0x00,
    0x09,
    0x80,
    ...addr,
    ...[0xe7, 0xff, 0x00, 0xe7, 0xff, 0x00], // two 1024-byte zero fills
    0xff,
  ]
  const leKnown = (rom: RomFile) => ({
    ...KNOWN,
    stockBody: [
      createHash('sha256')
        .update(Buffer.from(rom.readAt(BODY_AT, 0xaf)!))
        .digest('hex'),
    ],
  })
  const translevels = (rom: RomFile) =>
    derive(rom, leKnown(rom)).entrances.map(e => [e.bufferIndex, e.translevel])

  it('reads the table little-endian when the routine has the XBA', () => {
    const rom = build(new Uint8Array(), undefined, { raw: stream([0x07, 0x00]), le: true })
    expect(translevels(rom)).toEqual([
      [7, 9],
      [8, 9],
    ])
  })

  it('does not read a big-endian stream on a little-endian routine', () => {
    const rom = build(new Uint8Array(), undefined, { raw: stream([0x00, 0x07]), le: true })
    expect(translevels(rom)).toEqual([])
  })
})
