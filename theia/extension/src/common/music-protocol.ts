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

/**
 * Where the backend serves the SPC player's two assets.
 *
 * In common because both halves must agree: node/spc-assets.ts mounts the
 * route and browser/spc-playback.ts loads spc.js and spc.wasm from it.
 */
export const SPC_ASSET_ROUTE = '/hackbench/spc'

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
  /**
   * The user's name for this track, or '' when they have not given one.
   *
   * A cartridge holds no track names at all. The disassembly's constants
   * (ATHLETIC, CASTLE) describe a STOCK cart and read as nonsense on a
   * hack, so the panel shows the user's own name or the hex id, never a
   * name derived from the cart. See src/project/Aliases.ts.
   */
  alias?: string
  /** ARAM address this command resolves to in the bank's pointer table. */
  aramPointerHex?: string
  /**
   * Other commands in the same bank resolving to the SAME song, ascending.
   * The stock level bank has two such pairs, $04 with $16 and $0F with $10.
   */
  sharedWith?: number[]
  /** Real map slots that play this track, ascending. Level bank only. */
  maps?: number[]
}

/**
 * Which of the three banks a listing is for.
 *
 * They all upload to the same ARAM address, so only one is resident at a
 * time and a BGM command means a different song in each. The panel shows
 * one at a time for that reason.
 */
export type MusicBankName = 'level' | 'overworld' | 'credits'

export interface MusicBankDto {
  bank: MusicBankName
  /** ROM address of the bank's upload block, hex. */
  romAddrHex: string
  blockSize: number
  tracks: MusicTrackDto[]
  /**
   * Why no track carries `maps`, when the level bank should have them.
   * Absent on success, and always absent for the other two banks, which
   * level headers do not select from.
   */
  attributionUnavailable?: string
}

/**
 * What the panel can still say when a bank cannot be located.
 *
 * On all three AddmusicK cartridges in the corpus every bank refuses, so
 * without this the panel would be empty for them. The level-header decode
 * survives, so the commands the maps ask for are still known even though
 * the songs behind them are not.
 */
export interface MusicFallbackDto {
  /** BGM command to the number of real maps playing it. */
  mapCounts: Array<{ bgmCommand: number; bgmHex: string; alias: string; mapCount: number }>
  realMapCount: number
  /** Why even this is empty, when it is. */
  unavailable?: string
}

/**
 * Controls the game drives with a single SPC port write, which the player
 * can only receive baked into the snapshot.
 *
 * The engine exposes loadSPC, pause, resume, seek and a gain node, and no
 * way to write a port once a snapshot is loaded. So toggling either of
 * these rebuilds the snapshot and reloads it, which RESTARTS the track. The
 * panel says so rather than presenting them as live toggles.
 */
export interface SpcPortRequest {
  /** True writes $FF to port 0: the 099-seconds hurry-up, jingle and all. */
  hurryUp?: boolean
  /** True writes $02 to port 1, false $03: Yoshi's drums on and off. */
  yoshiDrums?: boolean
}

/**
 * One sound effect, identified only by the byte the game writes.
 *
 * Never a name: a ROM holds none for effects any more than it does for
 * tracks, and the id is the whole of its cartridge-derived identity.
 */
export interface SfxEntryDto {
  id: number
  idHex: string
  aramPointerHex: string
  /** The phrase is a bare end marker, so this id is silent by design. */
  empty: boolean
}

export interface SfxPortDto {
  /** 0 or 3; the two ports with a pointer table behind them. */
  port: number
  /** The SNES-side mirror, $1DF9 or $1DFC, for the row label. */
  mirror: string
  tableAramHex: string
  entries: SfxEntryDto[]
}

export type LoadSfxResult =
  | { status: 'ok'; ports: SfxPortDto[] }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | {
      status: 'unavailable'
      /** Per port, why it could not be read. Never a stock fallback. */
      reasons: Array<{ port: number; mirror: string; reason: string }>
    }

export type LoadBankResult =
  | { status: 'ok'; bank: MusicBankDto }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | {
      status: 'bank-unreadable'
      bank: MusicBankName
      reason: string
      /** What is still knowable about this cart's music. */
      fallback: MusicFallbackDto
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

  /**
   * One bank's full listing, with the user's names and map attribution.
   *
   * Never throws for an unreadable bank: that is an ordinary state on a
   * cart with custom music, and it comes back with a reason plus whatever
   * attribution is still readable.
   */
  loadBank(manifestPath: string, bank: MusicBankName): Promise<LoadBankResult>

  /**
   * A playable .spc snapshot for one track, as a plain byte array.
   *
   * Built fresh per call from the project's working copy, so an edit is
   * audible without restarting. Returns null when the bank cannot be
   * located, which is the same refusal `loadBank` reports; the panel
   * disables its transport rather than offering a control that would do
   * nothing.
   *
   * A number[] rather than a Uint8Array because this crosses JSON-RPC.
   */
  trackSpc(
    manifestPath: string,
    bank: MusicBankName,
    bgmCommand: number,
    ports?: SpcPortRequest,
  ): Promise<number[] | null>

  /**
   * Both sound effect tables, or why neither could be read.
   *
   * Unavailable rather than empty on a ROM whose sound driver has been
   * replaced: listing the stock 42 and 52 there would name effects the ROM
   * does not have. See docs/sfx-tables.md.
   */
  loadSfx(manifestPath: string): Promise<LoadSfxResult>

  /** A playable snapshot of one effect, or null when the port will not read. */
  sfxSpc(manifestPath: string, port: number, id: number): Promise<number[] | null>

  /**
   * Name a track, or clear its name with an empty string. Returns the name
   * as stored, which is the trimmed and cleaned form.
   */
  setTrackAlias(
    manifestPath: string,
    bank: MusicBankName,
    bgmCommand: number,
    alias: string,
  ): Promise<string>
}
