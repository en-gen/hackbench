/**
 * Everything the music panel needs about one bank, composed from the
 * readers that each answer one question.
 *
 * Pure: no project, no Theia, no fs. The backend service is a thin adapter
 * over this (same rule as the rest of src/rom/), and the user's own names
 * for tracks are merged in there, because those are project data rather
 * than anything the cartridge holds.
 *
 * ── Why a bank is the unit ───────────────────────────────────────────────
 *
 * SMW has three music banks and they all upload to the SAME ARAM address,
 * $1360 on a stock cart, so only one is resident at a time. A BGM command
 * therefore names a different song depending on which bank the game last
 * uploaded: $02 is OVERWORLD in the level bank and DONUTPLAINS in the
 * overworld bank. Listing all three together as one numbered sequence
 * would be listing three different meanings of the same number.
 *
 * ── Two tiers, and why the panel needs both ──────────────────────────────
 *
 * Locating a bank means verifying the path to its upload routine, and on
 * the three AddmusicK cartridges in this repo's corpus that fails for all
 * three banks - no track in any of them can be enumerated or played.
 *
 * Attribution is different. Which maps play which track comes from the
 * level-header decode, which survives AddmusicK on all six carts. So a
 * cart whose bank is unreadable can still be told what its maps ask for,
 * and `readTrackUsage` is exposed separately for exactly that: the panel
 * calls it whether or not the bank resolved.
 */
import { RomFile } from './RomFile'
import { SmwRom } from './SmwRom'
import {
  getLevelMusicBankAddrIfReadable,
  getOverworldMusicBankAddrIfReadable,
  getCreditsMusicBankAddrIfReadable,
  getBankBlockSize,
  readBankSongPointers,
} from './SpcBuilder'
import { readLevelMusicTableIfReadable, readLevelMusicUsage, slotsFor } from './MusicData'

export type MusicBankName = 'level' | 'overworld' | 'credits'

export const MUSIC_BANKS: readonly MusicBankName[] = ['level', 'overworld', 'credits'] as const

/**
 * Each bank's gated locator, and the call site it traces from, so a refusal
 * can name the address a reader would check.
 */
const LOCATORS: Record<
  MusicBankName,
  { locate: (rom: RomFile) => number | null; callSite: string; label: string }
> = {
  level: { locate: getLevelMusicBankAddrIfReadable, callSite: '$009702', label: 'level' },
  overworld: {
    locate: getOverworldMusicBankAddrIfReadable,
    callSite: '$0096C3',
    label: 'overworld',
  },
  credits: { locate: getCreditsMusicBankAddrIfReadable, callSite: '$0094A0', label: 'credits' },
}

export interface CatalogTrack {
  /** 1-based BGM command; the track's only cartridge-derived identity. */
  bgmCommand: number
  /** This command's entry in the bank's song pointer table. */
  aramPointer: number
  /**
   * Other commands in this bank whose pointer is identical, ascending.
   *
   * Not a curiosity: a stock level bank has two such pairs, $0F with $10
   * and $04 with $16. Showing them as four unrelated tracks invites
   * someone to replace one and be surprised the other changed too.
   */
  sharedWith: number[]
  /** Level header slots (0-7) selecting this command. Level bank only. */
  levelSlots: number[]
  /** Real map slots that play it, ascending. Level bank only. */
  maps: number[]
}

export interface MusicCatalogBank {
  bank: MusicBankName
  /** ROM address of the bank's upload block. */
  romAddr: number
  /** Block size in bytes, from the block's own 4-byte header. */
  blockSize: number
  tracks: CatalogTrack[]
  /**
   * Why `levelSlots` and `maps` are empty across every track, when they
   * are. Absent when attribution succeeded, and always absent for the
   * overworld and credits banks, which level headers do not select from.
   */
  attributionUnavailable?: string
}

export type MusicCatalogResult =
  | { status: 'ok'; bank: MusicCatalogBank }
  | { status: 'unavailable'; bank: MusicBankName; reason: string }

/** Commands sharing each song pointer, so `sharedWith` is one pass not N. */
function groupByPointer(
  pointers: { bgmCommand: number; aramPointer: number }[],
): Map<number, number[]> {
  const byPointer = new Map<number, number[]>()
  for (const p of pointers) {
    const seen = byPointer.get(p.aramPointer)
    if (seen) seen.push(p.bgmCommand)
    else byPointer.set(p.aramPointer, [p.bgmCommand])
  }
  return byPointer
}

/**
 * One bank's full listing, or a refusal naming the call site that failed.
 *
 * Attribution is attached only to the level bank. The overworld bank is
 * indexed by `OverworldMusic` (bank_04.asm:1214) and the credits bank by
 * hardcoded commands in the credits code; neither is reachable from a
 * level header, so an empty `maps` there is a fact rather than a gap, and
 * `attributionUnavailable` stays absent to say so.
 */
export function readMusicCatalog(smw: SmwRom, bank: MusicBankName): MusicCatalogResult {
  const { locate, callSite, label } = LOCATORS[bank]

  const romAddr = locate(smw.rom)
  if (romAddr === null) {
    return {
      status: 'unavailable',
      bank,
      reason:
        `The ${label} music bank's upload routine could not be verified: the call at ` +
        `${callSite} does not reach an intact routine. A music patch such as AddmusicK ` +
        `replaces these, and reporting the stock address anyway would name a bank this ` +
        `ROM never uploads.`,
    }
  }

  const pointers = readBankSongPointers(smw.rom, romAddr)
  const byPointer = groupByPointer(pointers)

  // Attribution costs a walk of all 512 pointer-table slots, so it is done
  // once per call and only where it means something.
  const usage = bank === 'level' ? readLevelMusicUsage(smw) : null
  const table = bank === 'level' ? readLevelMusicTableIfReadable(smw.rom) : null

  const tracks: CatalogTrack[] = pointers.map(p => ({
    bgmCommand: p.bgmCommand,
    aramPointer: p.aramPointer,
    sharedWith: (byPointer.get(p.aramPointer) ?? []).filter(c => c !== p.bgmCommand),
    levelSlots: table ? slotsFor(table, p.bgmCommand) : [],
    maps: usage?.mapsByCommand.get(p.bgmCommand) ?? [],
  }))

  return {
    status: 'ok',
    bank: {
      bank,
      romAddr,
      blockSize: getBankBlockSize(smw.rom, romAddr),
      tracks,
      ...(usage?.tableUnavailable ? { attributionUnavailable: usage.tableUnavailable } : {}),
    },
  }
}

/**
 * Map attribution on its own, for a cartridge whose banks cannot be read.
 *
 * The panel calls this regardless of whether `readMusicCatalog` succeeded:
 * on the three AddmusicK carts it is the only music information available,
 * and an empty panel would be a worse answer than "your maps ask for these
 * eight commands, and this build cannot locate the songs behind them".
 */
export function readTrackUsage(smw: SmwRom): ReturnType<typeof readLevelMusicUsage> {
  return readLevelMusicUsage(smw)
}
