/**
 * The music service, as seen from both sides.
 *
 * Mirrors project-protocol.ts's loadMaps/mapDetails shape (a backend service
 * the frontend calls over JSON-RPC) but kept in its own file so this view and
 * the sibling palette/GFX views never touch the same contract.
 */
import { RomIdentityDto } from './project-protocol'

/** Where the frontend reaches the backend. Must match the backend binding. */
export const MUSIC_SERVICE_PATH = '/services/hackbench-music'

export const MusicService = Symbol('MusicService')

/**
 * One BGM track in the level music bank, as
 * SpcBuilder.readBankSongPointers enumerates it (src/rom/SpcBuilder.ts).
 */
export interface MusicTrackDto {
  /** 1-based SPC BGM command byte; the track's own ROM-derived identity. */
  bgmCommand: number
  bgmHex: string
  /** Level header music indices (0-7, LevelMusicTable) that select this track. */
  levelIndices: number[]
}

export interface MusicListDto {
  tracks: MusicTrackDto[]
  trackCount: number
}

/**
 * Why loading music is a result rather than a throw.
 *
 * 'rom-not-located' mirrors project-protocol's LoadMapsResult: a project
 * names its cartridge by hash, so not finding it on this machine is an
 * ordinary first-run state the UI answers by asking the user to locate it.
 *
 * 'bank-unreadable' is a different refusal and must not collapse into
 * 'ok' with zero tracks: the level music bank's ROM address is derived from
 * operand bytes in an upload routine a hack can replace (AddmusicK does), and
 * a replaced routine is detected before enumeration ever runs (see
 * getLevelMusicBankAddrIfReadable in src/rom/SpcBuilder.ts). A cart with a
 * genuinely empty bank and a cart HackBench cannot read are different facts;
 * conflating them read as "no music" for carts whose soundtrack is the point.
 */
export type LoadMusicResult =
  | { status: 'ok'; list: MusicListDto }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'bank-unreadable' }

/**
 * What one track's bank entry holds, read from the cartridge.
 *
 * bankRomAddr/bankSize describe the level music bank's upload block
 * (src/rom/SpcBuilder.ts); aramPointer is this track's own entry in that
 * bank's song pointer table.
 */
export interface MusicTrackDetailsDto extends MusicTrackDto {
  bankRomAddr: string
  bankSize: number
  aramPointer: string
}

export interface MusicService {
  /** Every BGM track the project's base cartridge's level music bank holds. */
  loadMusic(manifestPath: string): Promise<LoadMusicResult>

  /**
   * Read one track's bank entry.
   *
   * Throws when bgmCommand names no track in the bank's current listing: a
   * selection stale against a changed ROM is a real refusal, not a blank
   * panel.
   */
  trackDetails(manifestPath: string, bgmCommand: number): Promise<MusicTrackDetailsDto>
}
