/**
 * Where a ROM keeps the code and data HackBench reads, found by following the
 * ROM's own pointers instead of assuming vanilla's banks (en-gen/hackbench#755).
 *
 * First slice: the layer 1 object code bank. LoadLevelData branches to
 * `JSR LevLoadNrmObj` for a standard object (SMWDisX bank_05.asm:783-788) and
 * that routine is `SEP #$30; JSL CODE_0DA40F; RTS` (bank_05.asm:805-808). The
 * JSL operand's bank byte is the bank: $0D on vanilla, $8D on hacks that use
 * the FastROM mirror. A hack that re-points the JSL to its own hook is out of
 * scope and reports not found.
 *
 * No VS Code or Theia imports, same rule as the rest of src/rom/.
 */
import { cachedByVersion, type RomFile } from './RomFile'
import { ENTRY_STANDARD } from './objectHandlers/interpret'

/** The bank, or why none could be named. A refusal is data: readers note it and draw the port. */
export type BankResult = { bank: number } | { notFound: string }

export interface DataBanks {
  objectCode: BankResult
}

/** Low 16 bits of CODE_0DA40F, the entry the loader's JSL must reach (bank_0D.asm:1319). */
const ENTRY_LOW = ENTRY_STANDARD & 0xffff
/** LevLoadNrmObj: SEP #$30; JSL; RTS (bank_05.asm:805-808). */
const LOADER_ROUTINE = 0x0586ea
const LOADER_LEN = 7
/** The `JSR LevLoadNrmObj` in LoadLevelData (bank_05.asm:788): where the loader reaches that routine. */
const LOADER_CALL_SITE = 0x0586cf
/** `LDA LvlLoadObjNo; BNE +6` (bank_05.asm:783-784): the branch that sends a standard object to that call. */
const LOADER_BRANCH = 0x0586c5
const LOADER_BRANCH_BYTES = [0xa5, 0x5a, 0xd0, 0x06]

const hex6 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(6, '0')

/** Reads bytes at the three loader sites; the bank is the JSL operand's bank byte. */
export function locateObjectCodeBank(rom: RomFile): BankResult {
  const branch = rom.readAt(LOADER_BRANCH, LOADER_BRANCH_BYTES.length)
  if (!branch || LOADER_BRANCH_BYTES.some((v, i) => branch[i] !== v))
    return {
      notFound: `the loader's branch to its standard-object call at ${hex6(LOADER_BRANCH)} is not LDA $5A, BNE +6`,
    }
  const call = rom.readAt(LOADER_CALL_SITE, 3)
  if (!call || call[0] !== 0x20 || (call[1] | (call[2] << 8)) !== (LOADER_ROUTINE & 0xffff))
    return {
      notFound: `the loader's call at ${hex6(LOADER_CALL_SITE)} is not JSR ${hex6(LOADER_ROUTINE)}`,
    }
  const b = rom.readAt(LOADER_ROUTINE, LOADER_LEN)
  if (!b || b[0] !== 0xe2 || b[1] !== 0x30 || b[2] !== 0x22 || b[6] !== 0x60)
    return { notFound: `the loader's routine at ${hex6(LOADER_ROUTINE)} is not SEP, JSL, RTS` }
  const to = b[3] | (b[4] << 8) | (b[5] << 16)
  if ((to & 0xffff) !== ENTRY_LOW)
    return {
      notFound: `the loader's JSL at ${hex6(LOADER_ROUTINE + 2)} reaches ${hex6(to)}, not offset $A40F in any bank`,
    }
  return { bank: b[5] }
}

const DETECTED = new WeakMap<RomFile, { version: number; value: DataBanks }>()

/**
 * The banks a reader should use: the ones the backend attached to this RomFile
 * (project config, hand edits applied), else detected from its own bytes. The
 * detection is memoized per RomFile version, so a write to the loader's sites
 * is seen.
 */
export function dataBanksOf(rom: RomFile): DataBanks {
  return (
    rom.dataBanks ??
    cachedByVersion(DETECTED, rom, () => ({ objectCode: locateObjectCodeBank(rom) }))
  )
}
