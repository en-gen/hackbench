/**
 * Which uploader the game runs for a level mode (#506). CODE_058955 reads
 * LevelModeSetting and JSLs ExecutePtrLong, then 32 long pointers follow the JSL,
 * one per mode (SMWDisX bank_05.asm:1099-1135). The kind of a map's L2 is the
 * mode's entry, not the L2 pointer's bank byte, which only has to agree with it.
 *
 * Found by bytes, and each target is classified by the opening bytes of its own
 * routine rather than its address, so a relocated routine still resolves and an
 * unrecognized one refuses for that mode alone instead of passing as vanilla.
 *
 * Limit: only a routine's opening 14-16 bytes are fingerprinted. A hack that keeps them and
 * changes the body further on (say, an early PLP/RTL) still classifies as stock; walking the
 * body is its own issue, like the other hack hooks (#764).
 */
import { RomFile, cachedByVersion } from './RomFile'
import { loromToOffset } from './addressing'
import { BytePattern, WILD, findExactlyOneSite, matchesAt } from './BytePattern'

export type L2UploaderKind = 'image' | 'objects' | 'none' | 'unrecognized'

export interface L2UploaderEntry {
  kind: L2UploaderKind
  /** SNES address of the routine the mode jumps to. */
  target: number
}

export type L2UploaderTable =
  { ok: true; entries: readonly L2UploaderEntry[] } | { ok: false; reason: string }

const MODES = 32
const WHAT = 'the level-mode uploader dispatch (bank_05.asm:1099-1101)'

// Four sibling dispatchers (CODE_05881A, CODE_058883, CODE_0588EC, CODE_058955) open with the same
// SEP / LDA.W LevelModeSetting / JSL ExecutePtrLong, so that run alone matches four times. The
// caller tells them apart: the strip loop JSLs CODE_0588EC, then the uploader, then
// UploadOneMap16Strip (bank_05.asm:111-114).
const CALLER: BytePattern = [0xc2, 0x30, 0x22, WILD, WILD, WILD, 0x22, WILD, WILD, WILD, 0x22, WILD, WILD, WILD] // prettier-ignore
const CALL_OFF = 6
// SEP #$30 / LDA.W LevelModeSetting / JSL <ExecutePtrLong>; the pointers start after the JSL.
const SITE: BytePattern = [0xe2, 0x30, 0xad, 0x25, 0x19, 0x22, WILD, WILD, WILD]
const JSL_OFF = 5
const TABLE_OFF = 9

// ExecutePtrLong's opening (bank_00.asm:864-873), so a JSL to something else refuses.
// prettier-ignore
const EXEC_PTR_LONG: BytePattern = [
  0x84, 0x05, 0x7a, 0x84, 0x02, 0xc2, 0x30, 0x29, 0xff, 0x00, 0x85, 0x03, 0x0a, 0x65, 0x03, 0xa8,
]

// Entry bytes of the three routines (bank_05.asm:1378-1386, 1495-1503, 1636-1644).
// The two object streamers open identically and differ only further on.
// prettier-ignore
const IMAGE: BytePattern = [0x08, 0xe2, 0x30, 0xad, WILD, WILD, 0x29, 0x0f, 0x0a, 0x8d, WILD, WILD, 0xa0, 0x30]
// prettier-ignore
const OBJECTS: BytePattern = [0x08, 0xc2, 0x30, 0xad, WILD, WILD, 0x29, 0xff, 0x00, 0x0a, 0xaa, 0xe2, 0x20, 0xa0, 0x00, 0x00]
const RTL: BytePattern = [0x6b] // Return058C70

// BytePattern offsets are cart-relative (copier header excluded), unlike `fileOffsetOf`.
const cartOffset = (rom: RomFile, snes: number): number | null =>
  loromToOffset(snes, rom.romSize, false)

const long = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)

const cache = new WeakMap<RomFile, { version: number; value: L2UploaderTable }>()

/** The 32 per-mode uploader kinds, or why the dispatch cannot be read. */
export function readL2UploaderTable(rom: RomFile): L2UploaderTable {
  return cachedByVersion(cache, rom, () => compute(rom))
}

function classify(rom: RomFile, target: number): L2UploaderKind {
  const at = cartOffset(rom, target)
  if (at === null) return 'unrecognized'
  if (matchesAt(rom, at, IMAGE)) return 'image'
  if (matchesAt(rom, at, OBJECTS)) return 'objects'
  if (matchesAt(rom, at, RTL)) return 'none'
  return 'unrecognized'
}

function compute(rom: RomFile): L2UploaderTable {
  const caller = findExactlyOneSite(rom, CALLER, 'the strip loop that calls the L2 uploader (bank_05.asm:111-114)') // prettier-ignore
  if (!caller.ok) return caller
  const call = rom.readAtFileOffset(caller.offset + CALL_OFF, 4)!
  const siteAt = cartOffset(rom, long(call, 1))
  if (siteAt === null || !matchesAt(rom, siteAt, SITE)) {
    return { ok: false, reason: `${WHAT} is not present on this ROM` }
  }
  const jsl = rom.readAtFileOffset(siteAt + JSL_OFF, 4)!
  const exec = cartOffset(rom, long(jsl, 1))
  if (exec === null || !matchesAt(rom, exec, EXEC_PTR_LONG)) {
    return { ok: false, reason: `${WHAT} no longer calls ExecutePtrLong` }
  }
  const raw = rom.readAtFileOffset(siteAt + TABLE_OFF, MODES * 3)
  if (raw === null) return { ok: false, reason: `${WHAT} has no pointer table after it` }
  const entries: L2UploaderEntry[] = []
  for (let m = 0; m < MODES; m++) {
    const target = long(raw, m * 3)
    entries.push({ kind: classify(rom, target), target })
  }
  return { ok: true, entries }
}
