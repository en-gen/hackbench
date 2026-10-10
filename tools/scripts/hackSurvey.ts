/**
 * Re-derives the dated survey figures in docs/rom/hack-corpus.md (#543) from
 * ROM bytes, so the numbers can be recomputed on a bigger corpus instead of
 * carried forward. Pure: takes bytes, reads no files. The CLI is hack-survey.ts.
 *
 * Ported from smw-mcp `scripts/hack-survey.js` (branch feature/hack-survey),
 * trimmed to the checks behind the doc's figures. Addresses are the ones cited
 * there; a verdict is a byte comparison against vanilla, not a reader's gate.
 */
const BANK = 0x8000
const WILD = -1

/** File offset of a LoROM address in banks $00-$7D, or null when it is not ROM. */
export function offsetOf(addr: number, size: number): number | null {
  const bank = (addr >>> 16) & 0x7f
  const lo = addr & 0xffff
  if (bank > 0x7d || lo < 0x8000) return null
  const off = bank * BANK + (lo & 0x7fff)
  return off < size ? off : null
}

/** Drops a 512-byte copier header when present. */
export function stripHeader(raw: Uint8Array): Uint8Array {
  return raw.length % 1024 === 512 ? raw.subarray(512) : raw
}

function at(rom: Uint8Array, addr: number, len: number): Uint8Array | null {
  const off = offsetOf(addr, rom.length)
  return off === null || off + len > rom.length ? null : rom.subarray(off, off + len)
}
const same = (a: Uint8Array | null, b: Uint8Array | null) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])

function find(data: Uint8Array, pattern: readonly number[], limit: number): number[] {
  const hits: number[] = []
  for (let i = 0; i <= data.length - pattern.length && hits.length < limit; i++) {
    let k = 0
    while (k < pattern.length && (pattern[k] === WILD || data[i + k] === pattern[k])) k++
    if (k === pattern.length) hits.push(i)
  }
  return hits
}

// The seven items behind "Held on 97 of 99". Sources: smw-mcp hack-survey.js TABLES/ROUTINES.
const CORE_BLOCKS: readonly [string, number, number][] = [
  ['DATA_05B96B', 0x05b96b, 18],
  ['DATA_05B97D', 0x05b97d, 18],
  ['GFX_SPRITE_TABLE', 0x00a8c3, 32],
  ['GFX_FGBG_TABLE', 0x00a92b, 32],
  ['DATA_00ABD3', 0x00abd3, 24],
  ['CODE_05BB39', 0x05bb39, 4],
  ['CODE_00F545', 0x00f545, 4],
]
const LZ2_ADDR = 0x00b8de // CODE_00B8DE, the LC_LZ2 decompressor entry
const LM_JSL_ADDR = 0x05d8b1 // stock BEQ ($F0), Lunar Magic JSL ($22)
const DISPATCH_ADDR = 0x0da415 // standard object dispatch
const HANDLERS_ADDR = 0x0da455 // 63 x 3-byte handler pointers, tileset 0/7/12
const MARKER_ADDR = 0x0ff0a0
const MARKER = 'Lunar Magic Version '
const SA1_REMAP = [0xe2, 0x30, 0xad, 0x31, 0x79, 0x22, 0xfa, 0x86, 0x00]
// MAP16AppTable reader (Map16.ts APP_READ); vanilla holds two copies.
const APP_READ = [
  0x29,
  0x06,
  0x00,
  0xaa,
  0xa9,
  0x33,
  0x01,
  0x0a,
  0xa8,
  0xa9,
  0x07,
  0x00,
  0x85,
  0x00,
  0xbf,
  WILD,
  WILD,
  WILD,
  0x99,
  0xbe,
  0x0f,
  0xc8,
  0xc8,
  0x18,
  0x69,
  0x08,
  0x00,
  0xc6,
  0x00,
  0x10,
  0xf3,
]
// Sprite data pointer lead-in (LevelTableGate.ts LEAD_IN); operands name Ptrs05EC00.
const SPRITE_LEAD = [0xb9, WILD, WILD, 0x85, 0xce, 0xb9, WILD, WILD, 0x85, 0xcf]

export interface Calibration {
  appReaders: number[]
  spriteTable: number
}

function spriteTable(rom: Uint8Array): number | null {
  const hits = find(rom, SPRITE_LEAD, 2)
  if (hits.length !== 1) return null
  const h = hits[0]!
  const lo = rom[h + 1]! | (rom[h + 2]! << 8)
  const hi = rom[h + 6]! | (rom[h + 7]! << 8)
  return hi === lo + 1 ? ((Math.floor(h / BANK) & 0xff) << 16) | lo : null
}

export function calibrate(vanillaRaw: Uint8Array): Calibration {
  const vanilla = stripHeader(vanillaRaw)
  const appReaders = find(vanilla, APP_READ, 8)
  const table = spriteTable(vanilla)
  if (appReaders.length !== 2 || table === null) {
    throw new Error('vanilla does not hold the two MAP16AppTable readers and one sprite lead-in')
  }
  return { appReaders, spriteTable: table }
}

export interface RomFacts {
  /** Names of the seven core items that differ from vanilla (empty = held). */
  coreMisses: string[]
  /** The sprite pointer lead-in matched zero or several places, so Ptrs05EC00 was not checked. */
  spriteTableUnresolved: boolean
  lz2Replaced: boolean
  /** True when either MAP16AppTable reader is absent or not at its vanilla offset. */
  appReaderMoved: boolean
  jslAt05D8B1: boolean
  /** All 63 standard handlers point into the $8D bank mirror. */
  handlersAllIn8D: boolean
  lmVersion: string | null
  dispatch: 'stock' | 'jml' | 'other'
  sa1Remap: boolean
}

export function surveyRom(vanillaRaw: Uint8Array, romRaw: Uint8Array, cal: Calibration): RomFacts {
  const vanilla = stripHeader(vanillaRaw)
  const rom = stripHeader(romRaw)
  const coreMisses = CORE_BLOCKS.filter(([, a, n]) => !same(at(vanilla, a, n), at(rom, a, n))).map(
    c => c[0],
  )
  // An unresolvable lead-in (0 or 2+ matches) is not evidence of a move; it is counted apart.
  const table = spriteTable(rom)
  if (table !== null && table !== cal.spriteTable) coreMisses.push('Ptrs05EC00')
  const hits = find(rom, APP_READ, 8)
  const handlers = at(rom, HANDLERS_ADDR, 63 * 3)
  const marker = at(rom, MARKER_ADDR, 24)
  const text = marker ? String.fromCharCode(...marker) : ''
  const dispatch = at(rom, DISPATCH_ADDR, 4)
  const remap = at(rom, DISPATCH_ADDR, SA1_REMAP.length)
  return {
    coreMisses,
    spriteTableUnresolved: table === null,
    lz2Replaced: !same(at(vanilla, LZ2_ADDR, 4), at(rom, LZ2_ADDR, 4)),
    appReaderMoved: cal.appReaders.some((v, i) => hits[i] !== v),
    jslAt05D8B1: at(rom, LM_JSL_ADDR, 1)?.[0] === 0x22,
    handlersAllIn8D:
      !!handlers &&
      Array.from({ length: 63 }, (_, i) => handlers[i * 3 + 2]).every(b => b === 0x8d),
    lmVersion: text.startsWith(MARKER) ? text.slice(MARKER.length).replace(/[^0-9.].*$/, '') : null,
    dispatch: same(dispatch, at(vanilla, DISPATCH_ADDR, 4))
      ? 'stock'
      : dispatch?.[0] === 0x5c
        ? 'jml'
        : 'other',
    sa1Remap: !!remap && SA1_REMAP.every((b, i) => remap[i] === b),
  }
}

export interface Figures {
  n: number
  coreHeld: number
  spriteTableUnresolved: number
  lz2Replaced: number
  appReaderMoved: number
  jslAt05D8B1: number
  handlersAllIn8D: number
  lmMarker: number
  dispatch: { stock: number; jml: number; other: number }
  sa1Remap: number
}

export function figures(facts: readonly RomFacts[]): Figures {
  const count = (f: (r: RomFacts) => boolean) => facts.filter(f).length
  return {
    n: facts.length,
    coreHeld: count(r => r.coreMisses.length === 0),
    spriteTableUnresolved: count(r => r.spriteTableUnresolved),
    lz2Replaced: count(r => r.lz2Replaced),
    appReaderMoved: count(r => r.appReaderMoved),
    jslAt05D8B1: count(r => r.jslAt05D8B1),
    handlersAllIn8D: count(r => r.handlersAllIn8D),
    lmMarker: count(r => r.lmVersion !== null),
    dispatch: {
      stock: count(r => r.dispatch === 'stock'),
      jml: count(r => r.dispatch === 'jml'),
      other: count(r => r.dispatch === 'other'),
    },
    sa1Remap: count(r => r.sa1Remap),
  }
}
