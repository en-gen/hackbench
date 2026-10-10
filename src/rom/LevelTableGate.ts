/**
 * Two level-load reads pinned by their own instructions: CODE_05D8B7's
 * sprite pointer table + bank (bank_05.asm:7248-7258) and CODE_0584E3's
 * VerticalTable (bank_05.asm:552). Each names its own data rather than being
 * told where to look, and each is found by `findPattern` so a relocated
 * routine still resolves. The sprite gate's anchor is a lead-in that is
 * byte-identical on every corpus ROM; the segments around it are read at
 * fixed offsets from that one match. A handful of Lunar Magic hook shapes,
 * measured on the corpus, are recognized alongside the vanilla bytes at
 * every segment; anything else refuses with a reason.
 */
import { createHash } from 'crypto'
import { RomFile, cachedByVersion } from './RomFile'
import { BytePattern, WILD, findExactlyOneSite, matchesAt, matchesBytes } from './BytePattern'
import { loromFromOffset, mirror } from './addressing'

export type SpriteBankSource =
  { kind: 'fixed'; bank: number } | { kind: 'perLevel'; tableAddr: number }

export type SpritePointerSite =
  { ok: true; tableAddr: number; bank: SpriteBankSource } | { ok: false; reason: string }

// CODE_05D8B7 (bank_05.asm:7248-7258), split into four fixed-offset segments
// from the lead-in, the one byte-identical on every corpus ROM.
const LEAD_IN_WHAT = 'the sprite pointer read (bank_05.asm:7253-7258)'
// prettier-ignore
const LEAD_IN: BytePattern = [
  0xb9, WILD, WILD, // LDA.W Ptrs05EC00,Y
  0x85, 0xce, // STA.B SpriteDataPtr
  0xb9, WILD, WILD, // LDA.W Ptrs05EC00+1,Y
  0x85, 0xcf, // STA.B SpriteDataPtr+1
]
const INDEX_OFF = -9 // bank_05.asm:7248-7250 (LDA _E / ASL A / TAY)
const MID_OFF = -5 // bank_05.asm:7251-7252 (LDA #$0000 / SEP #$20)
const TAIL_OFF = 10 // bank_05.asm:7257-7258 (bank byte / STA SpriteDataPtr+2)

const INDEX_VANILLA: BytePattern = [0xa5, 0x0e, 0x0a, 0xa8]
// The SEP operand is pinned, not just its opcode: #$30 (also 8-bit X/Y) would
// truncate the 16-bit index this code just computed into Y, same as #$20.
const MID_VANILLA: BytePattern = [0xa9, 0x00, 0x00, 0xe2, 0x20]
const TAIL_FIXED: BytePattern = [0xa9, WILD, 0x85, 0xd0]
const TAIL_JSL: BytePattern = [0x22, WILD, WILD, WILD]

// Lunar Magic's per-level index routine, JSL'd from INDEX_OFF in place of
// INDEX_VANILLA. Straight-line, no branches; Y ends at level*2 either way.
// docs/rom/level-table-gate.md has the corpus measurement and byte trace.
const INDEX_ROUTINE_A: BytePattern = [0xa5, 0x0e, 0x1a, 0x85, 0xfe, 0x3a, 0x0a, 0xa8, 0x6b]
const INDEX_ROUTINE_B: BytePattern = [
  0xa5, 0x0e, 0x8d, 0x0b, 0x01, 0x1a, 0x85, 0xfe, 0x3a, 0x0a, 0xa8, 0x6b,
]

// Lunar Magic's per-level sprite-bank routine, JSL'd from TAIL_OFF in place
// of TAIL_FIXED. The table operand is read, not assumed; its bank is the
// JSL's own target bank (PB after a JSL is always the target's bank).
// prettier-ignore
const BANK_ROUTINE: BytePattern = [
  0x8b, 0x4b, 0xab, // PHB / PHK / PLB
  0xa4, 0x0e, // LDY LevelNumber
  0xb9, WILD, WILD, // LDA <table>,Y
  0x85, 0xd0, // STA SpriteDataPtr+2
  0xab, 0x6b, // PLB / RTL
]
const BANK_ROUTINE_TABLE_OFF = 6

const spriteSiteCache = new WeakMap<RomFile, { version: number; value: SpritePointerSite }>()

/** The sprite pointer table's SNES address and bank source, read from
 *  CODE_05D8B7's own operands rather than assumed. */
export function readSpritePointerSite(rom: RomFile): SpritePointerSite {
  return cachedByVersion(spriteSiteCache, rom, () => computeSpritePointerSite(rom))
}

function computeSpritePointerSite(rom: RomFile): SpritePointerSite {
  const lead = findExactlyOneSite(rom, LEAD_IN, LEAD_IN_WHAT)
  if (!lead.ok) return lead

  // The bank is the lead-in's OWN bank, not assumed: CODE_05D796's PHB/PHK/PLB
  // (bank_05.asm:7080-7082) sets the data bank to whatever bank this code
  // actually runs under, and a relocated copy of the routine carries its own.
  const hitAddr = loromFromOffset(lead.offset)
  if (hitAddr === null) {
    return { ok: false, reason: `${LEAD_IN_WHAT} resolves outside LoROM addressing` }
  }
  const bank = (hitAddr >>> 16) & 0xff

  if (!matchesAt(rom, lead.offset + MID_OFF, MID_VANILLA)) {
    return {
      ok: false,
      reason:
        "the sprite pointer read's setup (bank_05.asm:7251-7252) is diverted through " +
        'code that branches on RAM state ($141A on the corpus), so its effect on Y ' +
        'and the sprite pointer cannot be verified statically',
    }
  }
  if (!recognizedIndex(rom, lead.offset + INDEX_OFF)) {
    return {
      ok: false,
      reason:
        "the sprite pointer read's level index (bank_05.asm:7248-7250) is neither vanilla nor a recognized hook",
    }
  }

  const site = rom.readAtFileOffset(lead.offset, LEAD_IN.length)!
  const lo = site[1]! | (site[2]! << 8)
  const hi = site[6]! | (site[7]! << 8)
  // The two LDA.W operands are the same table's low and high half; stock
  // code always compiles the second as the first plus one (Ptrs05EC00+1,Y).
  if (hi !== lo + 1) {
    return { ok: false, reason: `${LEAD_IN_WHAT} does not address one contiguous table` }
  }
  const tableAddr = (bank << 16) | lo

  const bankSource = recognizedBank(rom, lead.offset + TAIL_OFF)
  if (!bankSource) {
    return {
      ok: false,
      reason:
        "the sprite pointer read's bank byte (bank_05.asm:7257) is neither vanilla nor a recognized hook",
    }
  }
  return { ok: true, tableAddr, bank: bankSource }
}

function recognizedIndex(rom: RomFile, offset: number): boolean {
  if (matchesAt(rom, offset, INDEX_VANILLA)) return true
  const jsl = matchesAt(rom, offset, TAIL_JSL) // same 4-byte JSL shape as the tail
  if (!jsl) return false
  const target = jsl[1]! | (jsl[2]! << 8) | (jsl[3]! << 16)
  const body = rom.readAt(target, INDEX_ROUTINE_B.length)
  return matchesBytes(body, INDEX_ROUTINE_A) || matchesBytes(body, INDEX_ROUTINE_B)
}

function recognizedBank(rom: RomFile, offset: number): SpriteBankSource | null {
  const fixed = matchesAt(rom, offset, TAIL_FIXED)
  if (fixed) return { kind: 'fixed', bank: fixed[1]! }
  const jsl = matchesAt(rom, offset, TAIL_JSL)
  if (!jsl) return null
  const target = jsl[1]! | (jsl[2]! << 8) | (jsl[3]! << 16)
  const body = rom.readAt(target, BANK_ROUTINE.length)
  if (!matchesBytes(body, BANK_ROUTINE)) return null
  const tableLo = body![BANK_ROUTINE_TABLE_OFF]! | (body![BANK_ROUTINE_TABLE_OFF + 1]! << 8)
  const routineBank = (target >>> 16) & 0xff // PB after a JSL is the target's own bank
  return { kind: 'perLevel', tableAddr: (routineBank << 16) | tableLo }
}

export type VerticalTableSite =
  { ok: true; table: readonly number[] } | { ok: false; reason: string }

// CODE_0584E3 (bank_05.asm:552). LDA.L is absolute-long: the operand IS the
// SNES address, independent of any data bank register.
const VT_WHAT = 'the VerticalTable read (bank_05.asm:552)'
const VT_TAIL: BytePattern = [0x85, 0x5b] // STA.B ScreenMode
// prettier-ignore
const VT_VANILLA: BytePattern = [0xbf, WILD, WILD, WILD, ...VT_TAIL] // LDA.L VerticalTable,X
const VT_JML: BytePattern = [0x5c, WILD, WILD, WILD, ...VT_TAIL]
const VT_ADDR_OFF = 1
export const VERTICAL_TABLE_LENGTH = 32

// Grand Poo World 2's VerticalTable detour: both the not-taken (bit 7 set)
// and taken (bit 7 clear, every non-boss level) paths of its own BPL, and
// both paths' JML back. docs/rom/level-table-gate.md has the offset-by-
// offset trace and the corpus measurement. 36 bytes, over this project's
// ~32-byte threshold for a literal pattern, so the fixed-opcode skeleton is
// pinned as a hash (VT_JML_BODY_HASH) rather than carried as raw bytes; the
// five ranges below are the operands masked out before hashing.
const VT_JML_BODY_LEN = 36
const VT_JML_BODY_MASKS: ReadonlyArray<readonly [number, number]> = [
  [1, 4], // table operand, 1st load (BPL setup)
  [13, 16], // table operand, 2nd load (not-taken path)
  [19, 22], // JML return, not-taken path
  [29, 32], // table operand, 3rd load (taken path)
  [33, 36], // JML return, taken path
]
const VT_JML_BODY_HASH = '5fa0791dd523188f219a2ae106b61213083a32d6ab952533569c2a294c8064ee'
const VT_JML_ADDR_OFFS = [1, 13, 29] // the three LDA.L operands; must all agree
const VT_JML_RET_OFFS = [19, 33] // the two JML operands; must both be the return address

function maskedHash(bytes: Uint8Array): string {
  const masked = Uint8Array.from(bytes)
  for (const [start, end] of VT_JML_BODY_MASKS) masked.fill(0, start, end)
  return createHash('sha256').update(Buffer.from(masked)).digest('hex')
}

const verticalTableCache = new WeakMap<RomFile, { version: number; value: VerticalTableSite }>()

/** VerticalTable's 32 bytes, read from CODE_0584E3's own operand. */
export function readVerticalTable(rom: RomFile): VerticalTableSite {
  return cachedByVersion(verticalTableCache, rom, () => computeVerticalTable(rom))
}

function computeVerticalTable(rom: RomFile): VerticalTableSite {
  const vanilla = findExactlyOneSite(rom, VT_VANILLA, VT_WHAT)
  const addr = vanilla.ok ? vanillaAddr(rom, vanilla.offset) : recognizedJmlAddr(rom)
  if (addr === null) {
    return vanilla.ok
      ? { ok: false, reason: `${VT_WHAT} does not resolve to a recognized hook` }
      : vanilla
  }
  const table = rom.readAt(addr, VERTICAL_TABLE_LENGTH)
  if (!table) {
    return { ok: false, reason: `${VT_WHAT} names $${addr.toString(16)}, which is not readable` }
  }
  return { ok: true, table: Array.from(table) }
}

function vanillaAddr(rom: RomFile, offset: number): number {
  const site = rom.readAtFileOffset(offset, VT_VANILLA.length)!
  return site[VT_ADDR_OFF]! | (site[VT_ADDR_OFF + 1]! << 8) | (site[VT_ADDR_OFF + 2]! << 16)
}

/**
 * The Grand Poo World 2 JML shape only: the detour's masked-byte skeleton
 * must match VT_JML_BODY_HASH, its three table loads (the BPL setup and
 * both of its own paths) must name the same address, and both of its JML
 * returns must land on the STA ScreenMode this JML itself replaced the
 * LDA.L ahead of -- never trusted from the body, always recomputed from
 * where the outer JML was actually found.
 */
function recognizedJmlAddr(rom: RomFile): number | null {
  const jml = findExactlyOneSite(rom, VT_JML, VT_WHAT)
  if (!jml.ok) return null
  const site = rom.readAtFileOffset(jml.offset, VT_JML.length)!
  const target = readAddr(site, 1)
  const body = rom.readAt(target, VT_JML_BODY_LEN)
  if (!body || body.length < VT_JML_BODY_LEN || maskedHash(body) !== VT_JML_BODY_HASH) {
    return null
  }

  const addrs = VT_JML_ADDR_OFFS.map(off => readAddr(body, off))
  if (!addrs.every(a => a === addrs[0])) return null

  const jmlSiteAddr = loromFromOffset(jml.offset)
  if (jmlSiteAddr === null) return null
  // Keys: both sides of the return comparison are normalized, never read through.
  const expectedReturn = mirror(jmlSiteAddr + VT_JML.length - VT_TAIL.length)
  const returns = VT_JML_RET_OFFS.map(off => mirror(readAddr(body, off)))
  if (!returns.every(r => r === expectedReturn)) return null

  return addrs[0]! // read, not key: `rom.readAt` takes the bank as written
}

function readAddr(bytes: Uint8Array, off: number): number {
  return bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16)
}

// LoadLevel's boss-mode check (bank_05.asm:432-437, then :439-442): for the
// modes it compares, Layer 1 is never read. The modes are the CMP immediates,
// read here rather than assumed. The trailing LDY/LDA [Layer1DataPtr],Y/CMP #$FF
// is the empty-stream check that follows, and anchors the run to this routine.
const BOSS_WHAT = "LoadLevel's boss-mode check (bank_05.asm:432-437)"
const LEVEL_MODE_ADDR = [0x25, 0x19] // LevelModeSetting, $1925
// prettier-ignore
const BOSS_CHECK: BytePattern = [
  0xad, WILD, WILD, // LDA.W LevelModeSetting
  0xc9, WILD, 0xf0, WILD, // CMP #imm / BEQ LoadLevelDone
  0xc9, WILD, 0xf0, WILD,
  0xc9, WILD, 0xf0, WILD,
  0xa0, 0x00, 0xb7, 0x65, 0xc9, 0xff, // LDY #0 / LDA [Layer1DataPtr],Y / CMP #$FF
]
const BOSS_CMP_OFFS = [4, 8, 12]
const BOSS_BEQ_OFFS = [6, 10, 14] // displacement byte of each BEQ

export type BossModes = { ok: true; modes: ReadonlySet<number> } | { ok: false; reason: string }

const bossModesCache = new WeakMap<RomFile, { version: number; value: BossModes }>()

/** The level modes LoadLevel skips Layer 1 for, read from its own CMP
 *  immediates. Refuses when the check is absent, ambiguous, reads another
 *  RAM byte, or its three BEQs do not share one target. */
export function readBossModes(rom: RomFile): BossModes {
  return cachedByVersion(bossModesCache, rom, () => computeBossModes(rom))
}

function computeBossModes(rom: RomFile): BossModes {
  const site = findExactlyOneSite(rom, BOSS_CHECK, BOSS_WHAT)
  if (!site.ok) return site
  const b = rom.readAtFileOffset(site.offset, BOSS_CHECK.length)!
  if (b[1] !== LEVEL_MODE_ADDR[0] || b[2] !== LEVEL_MODE_ADDR[1]) {
    return { ok: false, reason: `${BOSS_WHAT} reads a RAM byte other than LevelModeSetting` }
  }
  // Each BEQ's target is its own end plus a signed displacement; all three
  // must land on one address, or one of them is not "skip to LoadLevelDone".
  const targets = BOSS_BEQ_OFFS.map(o => o + 1 + ((b[o]! << 24) >> 24))
  if (!targets.every(t => t === targets[0])) {
    return { ok: false, reason: `${BOSS_WHAT} branches to different places` }
  }
  return { ok: true, modes: new Set(BOSS_CMP_OFFS.map(o => b[o]!)) }
}
