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
import { blankStockRom, flip, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

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

/** Restated, not imported: CODE_00B8DE's entry (bank_00.asm:6294-6300), and the
 *  XOR prelude and fast LC_LZ2 call #663 recognizes. */
const DECOMP = 0x00b8de
const STOCK_ENTRY = [0xc2, 0x10, 0xa0, 0x00, 0x00, 0x20, 0x83, 0xb9, 0xc9, 0xff]
// prettier-ignore
const PRELUDE = (key: number): number[] => [
  0x08, 0xc2, 0x30, 0xa5, 0x8a, 0x49, key & 0xff, key >> 8, 0x85, 0x8a, 0x28, 0xc2, 0x10, 0xa0,
  0x00, 0x00, 0x6b,
]
const PRELUDE_AT = 0x018000
const FAST_AT = 0x019000
const FAST_LENGTH = 0x1bc
const FAST_BODY = Array.from({ length: FAST_LENGTH }, (_, i) => (i * 37 + 11) & 0xff)
const FAST = [
  {
    length: FAST_LENGTH,
    fingerprint: createHash('sha256').update(Buffer.from(FAST_BODY)).digest('hex'),
  },
]
const jsl = (at: number): number[] => [0x22, at & 0xff, (at >> 8) & 0xff, at >> 16]

interface Decomp {
  /** The prelude's key; the caller's operand is keyed with `stored`. */
  key?: number
  stored?: number
  fast?: boolean
  /** The stored stream as is, in place of `table` encoded. */
  raw?: number[]
}

function build(
  table: Uint8Array,
  entry?: ReturnType<typeof lmEntry>,
  { key, stored = key, fast, raw }: Decomp = {},
): RomFile {
  entry ??= lmEntry(false, 2, false, stored)
  const rom = blankStockRom()
  rom.writeAt(ENTRY, entry.bytes)
  rom.writeAt(ENTRY + entry.bytes.length + 0x10, [0x64, 0x0f, 0x20, 0x49, 0xda])
  rom.writeAt(0x00804d, [0x6b])
  rom.writeAt(DECOMP, STOCK_ENTRY)
  if (key !== undefined) {
    rom.writeAt(PRELUDE_AT, PRELUDE(key))
    rom.writeAt(DECOMP, [...jsl(PRELUDE_AT), 0xea])
  }
  if (fast) {
    rom.writeAt(FAST_AT, FAST_BODY)
    rom.writeAt(DECOMP + 5, [...jsl(FAST_AT), 0x60])
  }
  rom.writeAt(TABLE_AT, raw ?? [...encode(table)])
  return rom
}
const derive = (rom: RomFile) =>
  deriveOverworldEntrances(new SmwRom(rom), undefined, {
    ...SYNTHETIC_FINGERPRINTS,
    decompressor: FAST,
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

  it('refuses a command above 4 on the fast routine and reads it on stock', () => {
    // A literal, then short command 5 (a copy on stock), then the table.
    const raw = [0x00, 0x11, 0xa0, 0x00, 0x00, ...encode(tableOf({ 0x07: 9 }))]
    expect(derive(build(new Uint8Array(), undefined, { raw })).overworldReadable).toBe(true)
    const fast = derive(build(new Uint8Array(), undefined, { raw, fast: true }))
    expect(fast.overworldReadable).toBe(false)
    expect(fast.notes[0]).toMatch(/reads differently from stock/)
  })

  it.each([
    ['an entry JSL to something else', { key: 0x0300 }, PRELUDE_AT, /\$00B8DE.*calls \$018000/],
    ['a JSL body that is not a known routine', { fast: true }, FAST_AT, /calls \$019000/],
    ['a stock entry with another body', {}, DECOMP + 5, /\$00B8DE.*unrecognized body/],
  ] as const)('refuses %s, naming it', (_what, opts, at, reason) => {
    const rom = build(tableOf({ 0x01: 1 }), undefined, opts)
    flip(rom, at)
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.notes[0]).toMatch(reason)
  })

  // Every byte the recognizer pins, on each build it accepts: the stock entry, the
  // JSL / NOP into the prelude and the prelude less its key, the JSL / RTS into the
  // fast body and the body itself.
  const sweep: [string, Decomp, number][] = [
    ...STOCK_ENTRY.map((_, i) => ['stock', {}, DECOMP + i] as [string, Decomp, number]),
    ...[0, 1, 2, 3, 4].map(i => ['keyed', { key: 0x0300 }, DECOMP + i] as [string, Decomp, number]),
    ...PRELUDE(0)
      .flatMap((_, i) => (i === 6 || i === 7 ? [] : [i]))
      .map(i => ['keyed', { key: 0x0300 }, PRELUDE_AT + i] as [string, Decomp, number]),
    ...[5, 6, 7, 8, 9].map(i => ['fast', { fast: true }, DECOMP + i] as [string, Decomp, number]),
    ...FAST_BODY.map((_, i) => ['fast', { fast: true }, FAST_AT + i] as [string, Decomp, number]),
  ]
  it('refuses with any pinned decompressor byte flipped', () => {
    const survived = sweep.flatMap(([what, opts, at]) => {
      const rom = build(tableOf({ 0x01: 1 }), undefined, opts)
      if (!derive(rom).overworldReadable) return [`${what} unflipped refused`]
      flip(rom, at)
      return derive(rom).overworldReadable ? [`${what} $${at.toString(16)}`] : []
    })
    expect(sweep.length).toBe(10 + 5 + 15 + 5 + FAST_LENGTH)
    expect(survived).toEqual([])
  })

  it('refuses a table shorter than the $800 tiles', () => {
    const rom = build(new Uint8Array(0x7ff))
    expect(derive(rom).notes[0]).toContain('short of $800')
  })
})
