/**
 * Reading the SPC engine's sound-effect tables, on synthetic ROMs only.
 *
 * CI is permanently the corpus-absent case, so every gate and refusal is
 * proven here rather than only against test/roms/. The ROMs are built byte
 * by byte in this file: an engine upload whose first block holds the reader
 * routines and whose second block holds the tables and the phrase data,
 * which is the shape a real ROM has.
 *
 * The refusal that matters most is the last one. On an AddmusicK ROM the
 * whole sound driver is replaced and the stock reader is simply absent, and
 * reporting the stock table anyway would list 42 effects a ROM does not
 * have and play none of them. See docs/sfx-tables.md.
 *
 * Every assertion was proven able to fail by planting the matching defect
 * in src/rom/SfxTables.ts; the mutation list is in docs/testing.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { readSfxTable, buildSfxSpc, SfxPort } from '../../../src/rom/SfxTables'

const CART_SIZE = 0x80000
const fileOffset = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)

/** LDA #lo : STA $0000 : LDA #hi : STA $0001 : LDA #bank : STA $0002 */
const uploadRoutine = (romAddr: number): number[] => [
  0xa9,
  romAddr & 0xff,
  0x8d,
  0x00,
  0x00,
  0xa9,
  (romAddr >> 8) & 0xff,
  0x8d,
  0x01,
  0x00,
  0xa9,
  (romAddr >> 16) & 0xff,
  0x8d,
  0x02,
  0x00,
]

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]

/** An upload block: [size, aramDest] then the data. */
const block = (dest: number, bytes: number[]): number[] => [
  ...u16(bytes.length),
  ...u16(dest),
  ...bytes,
]

const TERMINATOR = [...u16(0), ...u16(0)]

/** Where the stock engine's routines and data land, mirrored here. */
const ENGINE_ARAM = 0x0500
const DATA_ARAM = 0x5000
const ENGINE_ROM = 0x0e8000
const SAMPLES_ROM = 0x0f8000

/**
 * Deliberately NOT the stock $51/$36 that buildSpc hardcodes. If these
 * matched, a reader that ignored the engine's operands and used the stock
 * values would pass and nothing would say so.
 */
const TEMPO_DP = 0x57
const TEMPO_VALUE = 0x42

/**
 * MOV A,$04+port : ASL A : MOV Y,A : MOV A,!t-2+Y : MOV dp,A
 * : MOV A,!t-1+Y : MOV dp+1,A     (bank_0E.asm:320-328)
 */
function reader(port: SfxPort, table: number, opts: { opcode?: number; highOffset?: number } = {}) {
  const low = table - 2
  const high = low + (opts.highOffset ?? 1)
  return [
    opts.opcode ?? 0xe4,
    0x04 + port,
    0x1c,
    0xfd,
    0xf6,
    low & 0xff,
    (low >> 8) & 0xff,
    0xc4,
    0x10,
    0xf6,
    high & 0xff,
    (high >> 8) & 0xff,
    0xc4,
    0x11,
  ]
}

/** The three engine operands buildSfxSpc reads instead of assuming. */
const engineInit = (regsAt: number, valsAt: number, tempoDp: number): number[] => [
  // MOV X,#$0B : MOV A,!regs+X : MOV Y,A : MOV A,!vals+X : CALL
  0xcd,
  0x0b,
  0xf5,
  regsAt & 0xff,
  (regsAt >> 8) & 0xff,
  0xfd,
  0xf5,
  valsAt & 0xff,
  (valsAt >> 8) & 0xff,
  0x3f,
  0x00,
  0x00,
  // MOV A,#tempo : MOV dp,A : MOV A,#$01 : MOV !$00F1,A : MOV Y,!$00FD
  0xe8,
  TEMPO_VALUE,
  0xc4,
  tempoDp,
  0xe8,
  0x01,
  0xc5,
  0xf1,
  0x00,
  0xec,
  0xfd,
  0x00,
]

interface Options {
  /** How many entries port 0's table holds. */
  port0Count?: number
  /** How many entries port 3's table holds. */
  port3Count?: number
  /** Port 0 ids (1-based) whose phrase is a bare end marker. */
  emptyIds?: number[]
  /** Corrupt the reader's first opcode. */
  readerOpcode?: number
  /** Break the -2/-1 operand pair by offsetting the second operand. */
  highOffset?: number
  /** Replace the engine upload routine, as AddmusicK does. */
  engineReplaced?: boolean
  /** Leave the port 3 reader out entirely. */
  omitPort3?: boolean
  /**
   * Leave the PORT 0 reader out. This is the dangerous direction: port 3's
   * table is bounded by port 0's, so without port 0 there is nothing above
   * it to fence against and only the block bound stops the scan.
   */
  omitPort0?: boolean
  /** Plant a second, decoy reader for the OTHER port. */
  duplicateOtherReader?: boolean
  /** ARAM address for port 3's table; defaults just below port 0's. */
  port3Table?: number
  /**
   * Fill the phrase area with bytes that read as valid in-range pointers.
   * Only the lowest-pointer bound can then stop the scan, which is the
   * situation port 0 is really in: its table is the higher of the two, so
   * it has no other table above it to fence against.
   */
  decoyPhrases?: boolean
  /** Plant the engine init sequence twice, so neither can be picked. */
  duplicateInit?: boolean
}

/**
 * A ROM whose engine upload carries a code block and a data block.
 *
 * Port 3's table sits immediately below port 0's by default, which is the
 * real layout and the reason the fence exists: without it a scan of port 3
 * walks straight on into port 0's entries.
 */
function buildRom(opts: Options = {}): RomFile {
  const {
    port0Count = 3,
    port3Count = 2,
    readerOpcode,
    highOffset,
    engineReplaced = false,
    omitPort3 = false,
    emptyIds = [],
    decoyPhrases = false,
    duplicateInit = false,
    omitPort0 = false,
    duplicateOtherReader = false,
  } = opts

  // The real layout: port 3's table runs straight into port 0's, and the
  // phrase data begins immediately after them. Reproduced exactly, because
  // a gap here would be filled by padding that reads as valid pointers and
  // the entry bound would never be exercised.
  const port3Table = opts.port3Table ?? DATA_ARAM + 0x100
  const port0Table = port3Table + port3Count * 2
  const phrasesAt = port0Table + port0Count * 2
  // Port 0's lowest pointer is the very first phrase, immediately after the
  // two tables. That is the real layout, and it is what makes the
  // lowest-pointer bound tight: leave a gap and the scan has slack to run
  // into, which is exactly the defect this fixture has to be able to show.
  const port0 = Array.from({ length: port0Count }, (_, i) => phrasesAt + i * 16)
  const port3 = Array.from({ length: port3Count }, (_, i) => phrasesAt + (port0Count + i) * 16)

  const buf = Buffer.alloc(CART_SIZE, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode

  buf.set(
    engineReplaced ? [0x20, 0xca, 0xd0, 0x60] : uploadRoutine(ENGINE_ROM),
    fileOffset(0x0080e8),
  )
  buf.set(uploadRoutine(SAMPLES_ROM), fileOffset(0x0080fd))

  // Code block: the two readers, then the init sequence buildSfxSpc reads.
  const code: number[] = []
  if (!omitPort0) code.push(...reader(0, port0Table, { opcode: readerOpcode, highOffset }))
  if (!omitPort3) code.push(...reader(3, port3Table))
  // A second port 0 reader naming a DIFFERENT table. Ambiguous, so it must
  // not be used as a bound for port 3.
  if (duplicateOtherReader) code.push(...reader(0, port0Table + 0x40))
  code.push(...engineInit(DATA_ARAM + 0x400, DATA_ARAM + 0x410, TEMPO_DP))
  if (duplicateInit) code.push(...engineInit(DATA_ARAM + 0x420, DATA_ARAM + 0x430, 0x58))
  while (code.length < 0x200) code.push(0xff) // padding, matches nothing

  // Data block: both tables and the phrases they point at.
  const data = new Array(0x800).fill(0xaa)
  const put = (aram: number, bytes: number[]) => {
    for (let i = 0; i < bytes.length; i++) data[aram - DATA_ARAM + i] = bytes[i]
  }
  put(port3Table, port3.flatMap(u16))
  put(port0Table, port0.flatMap(u16))
  // Phrase data: a non-zero first byte means audible, $00 means an empty
  // phrase, which is what port 0's $22 and $24 really are.
  for (const p of [...port0, ...port3]) put(p, [0x0b, 0x00])
  if (decoyPhrases) {
    // Every phrase byte now reads as a pointer well inside the bank.
    for (let a = phrasesAt; a < DATA_ARAM + 0x780; a += 2) put(a, u16(phrasesAt + 0x40))
  }
  for (const id of emptyIds) put(port0[id - 1], [0x00])
  // DSP default tables the init sequence points at.
  put(DATA_ARAM + 0x400, [0x0c, 0x1c, 0x2c])
  put(DATA_ARAM + 0x410, [0x7f, 0x7f, 0x7f])

  buf.set(
    [...block(ENGINE_ARAM, code), ...block(DATA_ARAM, data), ...TERMINATOR],
    fileOffset(ENGINE_ROM),
  )
  buf.set([...block(0x8000, new Array(16).fill(0)), ...TERMINATOR], fileOffset(SAMPLES_ROM))

  return new RomFile('synthetic.sfc', buf)
}

const ok = (r: ReturnType<typeof readSfxTable>) => {
  expect(r.status).toBe('ok')
  if (r.status !== 'ok') throw new Error('not ok')
  return r.table
}

describe('readSfxTable', () => {
  it('reads a port table from the reader routine, not from a fixed address', () => {
    const table = ok(readSfxTable(buildRom(), 0))

    // The address is recovered from the reader's own operands, so moving
    // the table moves the answer with it.
    // port 3's two-entry table sits first, so port 0's begins four bytes on.
    expect(table.tableAram).toBe(DATA_ARAM + 0x104)
    expect(table.entries).toHaveLength(3)
    expect(table.entries[0]).toMatchObject({ id: 1, idHex: '$01' })
    expect(table.entries[0].aramPointer).toBeGreaterThan(table.tableAram)
  })

  it('follows a relocated table', () => {
    // Nothing is hardcoded, so moving both tables moves the answer with
    // them. A reader anchored on the stock $5683 would report the old one.
    const moved = DATA_ARAM + 0x300
    const table = ok(readSfxTable(buildRom({ port3Table: moved }), 0))

    expect(table.tableAram).toBe(moved + 4)
  })

  it('numbers ids from 1, because that is the byte the game writes', () => {
    const table = ok(readSfxTable(buildRom(), 0))

    expect(table.entries.map(e => e.id)).toEqual([1, 2, 3])
  })

  it('marks an empty phrase rather than hiding or dropping it', () => {
    // Port 0's $22 and $24 point at a single end marker and render silent.
    // That is correct behaviour, so they belong in the list, flagged.
    const table = ok(readSfxTable(buildRom({ port0Count: 3, emptyIds: [2] }), 0))

    expect(table.entries).toHaveLength(3)
    expect(table.entries.map(e => e.empty)).toEqual([false, true, false])
  })

  it('stops at the other table, which sits immediately below it', () => {
    // Port 3's table runs straight into port 0's. Without the fence a scan
    // of port 3 keeps going and reports port 0's entries as its own.
    const table = ok(readSfxTable(buildRom({ port3Count: 2, port0Count: 5 }), 3))

    // Two, not seven: the scan stops at port 0's table rather than reading
    // its five entries as more of its own.
    expect(table.entries).toHaveLength(2)
  })

  it('stops at the first pointer target when nothing fences it above', () => {
    // Port 0's table is the higher of the two, so no other table bounds it
    // and the lowest-pointer rule is the only thing that ends the scan.
    // With every trailing byte reading as a valid pointer, a scan without
    // that rule runs on for hundreds of entries.
    const table = ok(readSfxTable(buildRom({ port0Count: 3, decoyPhrases: true }), 0))

    expect(table.entries).toHaveLength(3)
  })

  it('refuses port 3 when port 0 is unreadable, rather than swallowing its table', () => {
    // Port 3's own pointers leave slack above its table, so port 0's table
    // is the only thing that ends it. Without port 0 the scan runs straight
    // through and reports 2 + 5 entries, and that over-read is
    // SELF-CONSISTENT, so no check on port 3's own data can catch it.
    // Refusing is the only honest answer.
    const result = readSfxTable(buildRom({ port3Count: 2, port0Count: 5, omitPort0: true }), 3)

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/port 0/)
    expect(result.reason).toMatch(/bounded by the next one above/i)
  })

  it('refuses when the other port has two candidate readers', () => {
    // Picking one of several would silently truncate this port and still
    // report ok: the same mistake in the opposite direction.
    const result = readSfxTable(buildRom({ port3Count: 2, duplicateOtherReader: true }), 3)

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/candidate readers for port 0/i)
  })

  it('caps entries at what an 8-bit ASL can index', () => {
    // The reader doubles the id in 8 bits, so ids above $7F alias onto low
    // ones and a longer table is entries the game cannot ask for.
    const table = ok(readSfxTable(buildRom({ port0Count: 3 }), 0))

    expect(table.entries.every(e => e.id <= 0x7f)).toBe(true)
  })

  it('refuses when the reader opcode is not the one it expects', () => {
    const result = readSfxTable(buildRom({ readerOpcode: 0xe5 }), 0)

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/no table reader for port 0/i)
  })

  it('refuses when the two absolute operands are not consecutive', () => {
    // The routine reads a pointer's low byte from table-2+Y and its high
    // byte from table-1+Y. Operands that are not consecutive are not this
    // routine, however much the opcodes match.
    const result = readSfxTable(buildRom({ highOffset: 5 }), 0)

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/no table reader for port 0/i)
  })

  it('refuses when the engine upload routine has been replaced', () => {
    // The AddmusicK shape: $0080E8 no longer holds the LDA #imm triple, so
    // no engine image can be built and nothing downstream is trustworthy.
    const result = readSfxTable(buildRom({ engineReplaced: true }), 0)

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toMatch(/engine upload routine could not be verified/i)
    // Never the stock answer.
    expect(result.reason).not.toMatch(/\$5683/)
  })

  it('refuses BOTH ports when either reader is unreadable', () => {
    // This test previously asserted the opposite, that port 0 still read
    // when port 3 was missing, and that premise is what hid the over-read.
    // A table's length is established by the table above it, so one
    // unresolvable port leaves the other's length unproven even where the
    // number would happen to be right.
    const rom = buildRom({ omitPort3: true })

    for (const port of [0, 3] as const) {
      const result = readSfxTable(rom, port)
      expect(result.status).toBe('unavailable')
      if (result.status !== 'unavailable') continue
      expect(result.reason).toMatch(/port 3/)
    }
  })

  it('cites the reader address, so the claim can be checked', () => {
    const table = ok(readSfxTable(buildRom(), 0))

    expect(table.readerAram).toBe(ENGINE_ARAM)
  })
})

describe('buildSfxSpc', () => {
  it('refuses when the engine init sequence is not unique', () => {
    // Two candidates means we cannot say which one the engine runs, and
    // starting a snapshot at the wrong loop entry gives silence or noise
    // with nothing to say which. Unavailable beats a coin toss.
    expect(buildSfxSpc(buildRom({ duplicateInit: true }), 0, 1)).toBeNull()
  })

  it('puts the id on the port input register and leaves the others alone', () => {
    const A = 256 // where a .spc file's ARAM dump starts
    const spc = buildSfxSpc(buildRom(), 0, 2)

    expect(spc).not.toBeNull()
    expect(spc!.length).toBe(65920)
    expect(String.fromCharCode(...spc!.slice(0, 27))).toBe('SNES-SPC700 Sound File Data')
    expect(spc![A + 0xf4]).toBe(2) // port 0 input
    // No BGM command: the effect plays over silence.
    expect(spc![A + 0xf6]).toBe(0)
  })

  it('uses port 3 input register for a port 3 effect', () => {
    const A = 256
    const spc = buildSfxSpc(buildRom(), 3, 1)

    expect(spc![A + 0xf7]).toBe(1)
    expect(spc![A + 0xf4]).toBe(0)
  })

  it('refuses an id the table does not hold, rather than playing garbage', () => {
    // The engine does no bounds check, so an id past the table plays
    // whatever follows it. The table bound is the only thing keeping that
    // out of the listing, and out of the player.
    expect(buildSfxSpc(buildRom(), 0, 99)).toBeNull()
  })

  it('refuses when the engine cannot be verified', () => {
    expect(buildSfxSpc(buildRom({ engineReplaced: true }), 0, 1)).toBeNull()
  })

  it('reads the tempo and DSP defaults from engine operands, not fixed addresses', () => {
    const A = 256
    const spc = buildSfxSpc(buildRom(), 0, 1)!

    // The synthetic engine writes its tempo to a dp that is NOT the stock
    // $51, and both the address and the value come from its own operands.
    // buildSpc still hardcodes the stock equivalents; see #461.
    expect(spc[A + TEMPO_DP]).toBe(TEMPO_VALUE)
    // The DSP block is built from the tables the init sequence points at.
    const dspBase = 256 + 65536
    expect(spc[dspBase + 0x0c]).toBe(0x7f)
    expect(spc[dspBase + 0x1c]).toBe(0x7f)
  })
})
