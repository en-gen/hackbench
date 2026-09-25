/**
 * Backend half of the music service.
 *
 * Reads the project's WORKING COPY (WorkingRomRegistry), never the base
 * ROM directly - see docs/glossary.md, "Working copy". Otherwise thin
 * on purpose, same rule as project-server.ts: the real work is
 * src/rom/MusicData.ts and src/rom/SpcBuilder.ts, unit tested without Theia.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { readLevelMusicTableIfReadable, slotsFor } from '../../../../src/rom/MusicData'
import {
  getLevelMusicBankAddrIfReadable,
  getBankBlockSize,
  readBankSongPointers,
  buildSpc,
} from '../../../../src/rom/SpcBuilder'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { readMusicCatalog, readTrackUsage, MusicBankName } from '../../../../src/rom/MusicCatalog'
import {
  readSfxTable,
  buildSfxSpc,
  SFX_PORTS,
  SFX_PORT_MIRROR,
  SfxPort,
} from '../../../../src/rom/SfxTables'
import { AliasNamespace, aliasKey, readAliases, setAlias } from '../../../../src/project/Aliases'
import {
  LoadBankResult,
  LoadSfxResult,
  SfxPortDto,
  SpcPortRequest,
  LoadMusicResult,
  MusicBankDto,
  MusicFallbackDto,
  MusicListDto,
  MusicService,
  MusicTrackDetailsDto,
  MusicTrackDto,
} from '../common/music-protocol'

/**
 * A bank's alias namespace. Separate per bank because a BGM command means
 * a different song in each, so naming $02 in one must not rename $02 in
 * another (src/project/Aliases.ts).
 */
const ALIAS_NS: Record<MusicBankName, AliasNamespace> = {
  level: 'music.level',
  overworld: 'music.overworld',
  credits: 'music.credits',
}

/**
 * The three port bytes this panel can send, from constants.asm.
 *
 * Named here rather than inlined so the citation travels with the value:
 * !SFX_HURRYUP is -1, which assembles to $FF (constants.asm:322).
 */
const SFX_HURRYUP = 0xff
const SFX_YOSHI_DRUM_ON = 0x02
const SFX_YOSHI_DRUM_OFF = 0x03

const hex = (n: number, w = 2): string => `$${n.toString(16).toUpperCase().padStart(w, '0')}`

@injectable()
export class MusicServiceImpl implements MusicService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry

  async loadMusic(manifestPath: string): Promise<LoadMusicResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)

    const rom = RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes()))
    const bankRomAddr = getLevelMusicBankAddrIfReadable(rom)
    if (bankRomAddr === null) {
      return { status: 'bank-unreadable' }
    }

    const levelTable = readLevelMusicTableIfReadable(rom)
    const tracks: MusicTrackDto[] = readBankSongPointers(rom, bankRomAddr).map(p => ({
      bgmCommand: p.bgmCommand,
      bgmHex: hex(p.bgmCommand),
      // Which level-header music indices (0-7) select this track.
      levelIndices: slotsFor(levelTable, p.bgmCommand),
    }))

    const list: MusicListDto = { tracks, trackCount: tracks.length }
    return { status: 'ok', list }
  }

  async trackDetails(manifestPath: string, bgmCommand: number): Promise<MusicTrackDetailsDto> {
    const rom = this.romFor(manifestPath)
    const bankRomAddr = getLevelMusicBankAddrIfReadable(rom)
    if (bankRomAddr === null) {
      throw new Error('The level music bank is not readable on this ROM')
    }

    const pointers = readBankSongPointers(rom, bankRomAddr)
    const entry = pointers.find(p => p.bgmCommand === bgmCommand)
    if (!entry) {
      throw new Error(`No track ${hex(bgmCommand)} in the level music bank`)
    }

    const levelTable = readLevelMusicTableIfReadable(rom)

    return {
      bgmCommand: entry.bgmCommand,
      bgmHex: hex(entry.bgmCommand),
      levelIndices: slotsFor(levelTable, entry.bgmCommand),
      bankRomAddr: hex(bankRomAddr, 6),
      bankSize: getBankBlockSize(rom, bankRomAddr),
      aramPointer: hex(entry.aramPointer, 4),
    }
  }

  async loadBank(manifestPath: string, bank: MusicBankName): Promise<LoadBankResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)

    const smw = new SmwRom(RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes())))
    const aliases = readAliases(manifestPath, ALIAS_NS[bank])
    const catalog = readMusicCatalog(smw, bank)

    if (catalog.status !== 'ok') {
      // Not a throw and not an empty list. On every AddmusicK ROM in the
      // corpus all three banks refuse, and an empty panel would say less
      // than the map attribution that is still readable.
      return {
        status: 'bank-unreadable',
        bank,
        reason: catalog.reason,
        // The level namespace, not `bank`'s: the fallback is map
        // attribution, and only the level bank's commands are selected by
        // a map. Passing the requested bank's names here would label a
        // credits command with whatever the user called level track $02.
        fallback: this.fallbackFor(smw, readAliases(manifestPath, ALIAS_NS.level)),
      }
    }

    const dto: MusicBankDto = {
      bank,
      romAddrHex: hex(catalog.bank.romAddr, 6),
      blockSize: catalog.bank.blockSize,
      tracks: catalog.bank.tracks.map(t => ({
        bgmCommand: t.bgmCommand,
        bgmHex: hex(t.bgmCommand),
        alias: aliases[aliasKey(t.bgmCommand)] ?? '',
        levelIndices: t.levelSlots,
        aramPointerHex: hex(t.aramPointer, 4),
        sharedWith: t.sharedWith,
        maps: t.maps,
      })),
      ...(catalog.bank.attributionUnavailable
        ? { attributionUnavailable: catalog.bank.attributionUnavailable }
        : {}),
    }
    return { status: 'ok', bank: dto }
  }

  async trackSpc(
    manifestPath: string,
    bank: MusicBankName,
    bgmCommand: number,
    ports: SpcPortRequest = {},
  ): Promise<number[] | null> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status !== 'ok') return null

    const rom = RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes()))
    const smw = new SmwRom(rom)

    // Gated first, so a ROM whose bank cannot be verified never reaches
    // buildSpc's ungated reads and never produces a snapshot assembled from
    // addresses this ROM does not use.
    const catalog = readMusicCatalog(smw, bank)
    if (catalog.status !== 'ok') return null
    if (!catalog.bank.tracks.some(t => t.bgmCommand === bgmCommand)) return null

    const spc = buildSpc(rom, bgmCommand, bank, {
      ...(ports.hurryUp ? { port0: SFX_HURRYUP } : {}),
      ...(ports.yoshiDrums === undefined
        ? {}
        : { port1: ports.yoshiDrums ? SFX_YOSHI_DRUM_ON : SFX_YOSHI_DRUM_OFF }),
    })
    return spc ? Array.from(spc) : null
  }

  async loadSfx(manifestPath: string): Promise<LoadSfxResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)

    const rom = RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes()))
    const ports: SfxPortDto[] = []
    const reasons: Array<{ port: number; mirror: string; reason: string }> = []

    for (const port of SFX_PORTS) {
      const result = readSfxTable(rom, port)
      if (result.status !== 'ok') {
        reasons.push({ port, mirror: SFX_PORT_MIRROR[port], reason: result.reason })
        continue
      }
      ports.push({
        port,
        mirror: SFX_PORT_MIRROR[port],
        tableAramHex: hex(result.table.tableAram, 4),
        entries: result.table.entries.map(e => ({
          id: e.id,
          idHex: e.idHex,
          aramPointerHex: hex(e.aramPointer, 4),
          empty: e.empty,
        })),
      })
    }

    // Any refusal refuses the listing. readSfxTable establishes a table's
    // length from the table above it, so it already declines every port
    // when one is unreadable; a partial 'ok' here would report a length it
    // could not establish. See docs/sfx-tables.md.
    if (reasons.length > 0) return { status: 'unavailable', reasons }
    return { status: 'ok', ports }
  }

  async sfxSpc(manifestPath: string, port: number, id: number): Promise<number[] | null> {
    if (!SFX_PORTS.includes(port as SfxPort)) return null
    const r = this.workingRoms.get(manifestPath)
    if (r.status !== 'ok') return null

    const rom = RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes()))
    const spc = buildSfxSpc(rom, port as SfxPort, id)
    return spc ? Array.from(spc) : null
  }

  async setTrackAlias(
    manifestPath: string,
    bank: MusicBankName,
    bgmCommand: number,
    alias: string,
  ): Promise<string> {
    const table = setAlias(manifestPath, ALIAS_NS[bank], bgmCommand, alias)
    return table[aliasKey(bgmCommand)] ?? ''
  }

  /**
   * What is still knowable when no bank resolves: which commands the maps
   * ask for, and how many maps each.
   *
   * Only the level bank's namespace is consulted, because the level-header
   * decode is the only attribution there is; overworld and credits music
   * is not selected by a map.
   */
  private fallbackFor(smw: SmwRom, levelAliases: Record<string, string>): MusicFallbackDto {
    const usage = readTrackUsage(smw)
    const mapCounts = [...usage.mapsByCommand.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bgmCommand, maps]) => ({
        bgmCommand,
        bgmHex: hex(bgmCommand),
        alias: levelAliases[aliasKey(bgmCommand)] ?? '',
        mapCount: maps.length,
      }))

    return {
      mapCounts,
      realMapCount: usage.realMapCount,
      ...(usage.tableUnavailable ? { unavailable: usage.tableUnavailable } : {}),
    }
  }

  /**
   * The ROM behind a project, working copy included, or a throw.
   *
   * Read fresh from the registry each call: it is itself the shared cache,
   * so this never needs its own.
   */
  private romFor(manifestPath: string): RomFile {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') {
      throw new Error(
        `The base ROM for ${r.baseRom.title || 'this project'} is not on this machine`,
      )
    }
    if (r.status === 'unreadable') throw new Error(r.reason)
    return RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes()))
  }
}
