/**
 * Locate an N-SPC sound driver's tables inside a 64 KB sound-RAM image.
 *
 * Every address here is read from an operand of the driver's own code,
 * after the surrounding opcodes are matched, so a relocated or rebuilt
 * driver still resolves and a replaced one fails closed. The patterns are
 * the ones SMW's driver uses (SMWDisX bank_0E.asm, cited per pattern) and
 * the "Standard" ones VGMTrans matches for later Nintendo drivers
 * (github.com/vgmtrans/vgmtrans, NinSnesScannerPatterns.cpp, zlib).
 *
 * A pattern matching more than once with different operands is a refusal,
 * not a pick: we cannot say which copy runs.
 */

export type NspcDialect = 'earlier' | 'standard'

export interface NspcEngine {
  dialect: NspcDialect
  /** Song n's block list pointer is the word at songTable + 2n. */
  songTable: number
  instrTable: number
  /** Bytes per instrument: 5 (SRCN ADSR1 ADSR2 GAIN mult) or 6 (+ fraction). */
  instrWidth: number
  /** Earlier dialect: percussion notes use their own table, one extra byte for the note. */
  percTable: number | null
  /** Sample directory base (DSP register DIR * $100). */
  dir: number
  /** First voice command byte; lens[i] is the length of command vcmdFirst + i, opcode included. */
  vcmdFirst: number
  vcmdLens: number[]
  /** Note bytes noteMin..noteMax, then tie, rest; percussion percMin..percMax. */
  noteMin: number
  noteMax: number
  tie: number
  percMin: number
  percMax: number
}

export type EngineResult = { ok: true; engine: NspcEngine } | { ok: false; reason: string }

/** Pattern bytes; -1 is a wildcard. */
type Pattern = number[]
const _ = -1

function matchesAt(aram: Uint8Array, at: number, p: Pattern): boolean {
  if (at + p.length > aram.length) return false
  for (let i = 0; i < p.length; i++) if (p[i] !== _ && aram[at + i] !== p[i]) return false
  return true
}

/** Every offset where the pattern matches. */
export function findAll(aram: Uint8Array, p: Pattern): number[] {
  const hits: number[] = []
  for (let at = 0; at + p.length <= aram.length; at++) if (matchesAt(aram, at, p)) hits.push(at)
  return hits
}

const word = (a: Uint8Array, at: number) => a[at] | (a[at + 1] << 8)

/**
 * Read one value from every match; succeed only if all matches agree.
 * Identical code copies (a driver uploaded twice) are harmless; disagreeing
 * ones are exactly the case where we cannot tell which runs.
 */
function unique(
  aram: Uint8Array,
  p: Pattern,
  read: (at: number) => number,
  what: string,
): number | string {
  const hits = findAll(aram, p)
  if (hits.length === 0) return `${what}: pattern not found`
  const values = new Set(hits.map(read))
  if (values.size > 1) return `${what}: ${values.size} different matches`
  return values.values().next().value as number
}

export function locateEngine(aram: Uint8Array): EngineResult {
  // Read the next block-list word through a direct-page pointer (SMW APU_0BF0,
  // bank_0E.asm:967; VGMTrans ptnIncSectionPtr). Gives that pointer's address.
  const sectionDp = unique(
    aram,
    [0x8d, 0x00, 0xf7, _, 0x3a, _, 0x2d, 0xf7, _, 0x3a, _, 0xfd, 0xae],
    at => aram[at + 3],
    'section pointer',
  )
  if (typeof sectionDp === 'string') return { ok: false, reason: sectionDp }

  // Song start: `ASL A; MOV Y,A; MOV A,table+Y; MOV dp,A; MOV A,table+1+Y; MOV dp+1,A`
  // (SMW APU_0B40, bank_0E.asm:890-895). Earlier dialect.
  const earlier = findAll(aram, [
    0x1c,
    0xfd,
    0xf6,
    _,
    _,
    0xc4,
    sectionDp,
    0xf6,
    _,
    _,
    0xc4,
    sectionDp + 1,
  ])
  // Standard: `MOV A,table+1+X; MOV Y,A; MOV A,table+X; MOVW dp,YA` (VGMTrans makeInitSectionPtrPattern).
  const standard = findAll(aram, [0xf5, _, _, 0xfd, 0xf5, _, _, 0xda, sectionDp])

  let dialect: NspcDialect
  let songTable: number
  if (earlier.length > 0 && standard.length === 0) {
    dialect = 'earlier'
    const bases = new Set(earlier.map(at => word(aram, at + 3)))
    if (bases.size > 1)
      return { ok: false, reason: 'song table: several different song-start routines' }
    songTable = [...bases][0]
    // The high byte is read from table+1: confirm the pair is really one table.
    if (earlier.some(at => word(aram, at + 8) !== songTable + 1))
      return { ok: false, reason: 'song table: high byte read from an unexpected address' }
  } else if (standard.length > 0 && earlier.length === 0) {
    dialect = 'standard'
    const bases = new Set(standard.map(at => word(aram, at + 5)))
    if (bases.size > 1)
      return { ok: false, reason: 'song table: several different song-start routines' }
    songTable = [...bases][0]
  } else {
    return {
      ok: false,
      reason: earlier.length
        ? 'song start matches both dialects'
        : 'song start routine not found (not an N-SPC driver, or a variant not supported yet)',
    }
  }

  // Instrument table. Earlier: `MOV Y,#w; MOV dp,#lo; MOV dp+1,#hi; MUL YA` (SMW APU_0D4B,
  // bank_0E.asm:1182-1186, falls through into APU_0D56's MUL). Standard: `MOV Y,#6; MUL YA;
  // MOVW dp,YA; CLRC; ADC dp,#lo; ADC dp+1,#hi` (VGMTrans ptnLoadInstrTableAddress).
  let instrTable: number
  let instrWidth: number
  let percTable: number | null = null
  if (dialect === 'earlier') {
    const hits = findAll(aram, [0x8d, _, 0x8f, _, _, 0x8f, _, _])
      .filter(at => aram[at + 7] === aram[at + 4] + 1)
      .map(at => ({ at, width: aram[at + 1], table: aram[at + 3] | (aram[at + 6] << 8) }))
    // The instrument load is reached by falling into the MUL; percussion CALLs the shared tail
    // (HandleVCmd, bank_0E.asm:141-145), and its note byte makes its record one wider.
    const instr = hits.filter(h => aram[h.at + 8] === 0xcf)
    const perc = hits.filter(h => aram[h.at + 8] === 0x3f)
    if (instr.length !== 1)
      return { ok: false, reason: `instrument table: ${instr.length} candidates` }
    instrTable = instr[0].table
    instrWidth = instr[0].width
    if (perc.length === 1 && perc[0].width === instrWidth + 1) percTable = perc[0].table
  } else {
    const t = unique(
      aram,
      [0x8d, 0x06, 0xcf, 0xda, _, 0x60, 0x98, _, _, 0x98, _, _],
      at => aram[at + 7] | (aram[at + 10] << 8),
      'instrument table',
    )
    if (typeof t === 'string') return { ok: false, reason: t }
    instrTable = t
    instrWidth = 6
  }

  // Voice command lengths, read where the driver's readahead skips a command:
  // `CMP A,#first; BCC; PUSH Y; MOV Y,A; POP A; [CLRC;] ADC A,lens-first+Y`
  // (SMW APU_10BF, bank_0E.asm:1683-1690; VGMTrans ptnBranchForVcmdReadahead).
  const lensHits = [
    ...findAll(aram, [0x68, _, 0x90, _, 0x6d, 0xfd, 0xae, 0x60, 0x96, _, _]).map(at => ({
      first: aram[at + 1],
      base: word(aram, at + 9),
    })),
    ...findAll(aram, [0x68, _, 0x90, _, 0x6d, 0xfd, 0xae, 0x96, _, _]).map(at => ({
      first: aram[at + 1],
      base: word(aram, at + 8),
    })),
  ]
  const lensKeys = new Set(lensHits.map(h => `${h.first}:${h.base}`))
  if (lensKeys.size !== 1)
    return { ok: false, reason: `voice command lengths: ${lensKeys.size} candidates` }
  const vcmdFirst = lensHits[0].first
  const lensAt = (lensHits[0].base + vcmdFirst) & 0xffff
  const vcmdLens = Array.from(aram.subarray(lensAt, lensAt + (0x100 - vcmdFirst)))

  // Note layout. Earlier: `CMP A,#percMin; BCS; CMP A,#tie; BCC` (SMW HandleVCmd, bank_0E.asm:131-135).
  // Standard's is not a single readable site; its layout is VGMTrans's (NinSnesProfile.cpp).
  let noteMax: number, percMin: number, percMax: number
  if (dialect === 'earlier') {
    const n = findAll(aram, [0x68, _, 0xb0, _, 0x68, _, 0x90, _])
      .map(at => ({ perc: aram[at + 1], tie: aram[at + 5] }))
      .filter(x => x.perc > x.tie && x.perc < vcmdFirst && x.tie > 0x80)
    const keys = new Set(n.map(x => `${x.perc}:${x.tie}`))
    if (keys.size !== 1) return { ok: false, reason: `note layout: ${keys.size} candidates` }
    noteMax = n[0].tie - 1
    percMin = n[0].perc
    percMax = vcmdFirst - 1
  } else {
    noteMax = 0xc7
    percMin = 0xca
    percMax = vcmdFirst - 1
  }

  const dir = locateDir(aram)
  if (typeof dir === 'string') return { ok: false, reason: dir }

  return {
    ok: true,
    engine: {
      dialect,
      songTable,
      instrTable,
      instrWidth,
      percTable,
      dir,
      vcmdFirst,
      vcmdLens,
      noteMin: 0x80,
      noteMax,
      tie: noteMax + 1,
      percMin,
      percMax,
    },
  }
}

/** Sample directory: the value the driver writes to DSP register $5D. */
function locateDir(aram: Uint8Array): number | string {
  const values = new Set<number>()
  // `MOV $F2,#$5D; MOV $F3,#hi` (VGMTrans ptnSetDIR).
  for (const at of findAll(aram, [0x8f, 0x5d, 0xf2, 0x8f, _, 0xf3])) values.add(aram[at + 4] << 8)
  // `MOV A,#hi; MOV Y,#$5D; CALL` (VGMTrans ptnSetDIRYI).
  for (const at of findAll(aram, [0xe8, _, 0x8d, 0x5d, 0x3f])) values.add(aram[at + 1] << 8)
  // SMW writes DSP defaults from a register/value table pair: `MOV X,#n-1; MOV A,regs+X; MOV Y,A;
  // MOV A,vals+X; CALL` (APU_Start, bank_0E.asm:41-46).
  for (const at of findAll(aram, [0xcd, _, 0xf5, _, _, 0xfd, 0xf5, _, _, 0x3f])) {
    const count = aram[at + 1] + 1
    const regs = word(aram, at + 3)
    const vals = word(aram, at + 7)
    for (let i = 0; i < count; i++) if (aram[regs + i] === 0x5d) values.add(aram[vals + i] << 8)
  }
  if (values.size !== 1) return `sample directory: ${values.size} candidates`
  return [...values][0]
}
