/**
 * Backend half of the music service.
 *
 * Reads the project's WORKING COPY (WorkingRomRegistry), never the base
 * cartridge directly - see docs/glossary.md, "Working copy". Otherwise thin
 * on purpose, same rule as project-server.ts: the real work is
 * src/rom/MusicData.ts and src/rom/SpcBuilder.ts, unit tested without Theia.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { readLevelMusicTable } from '../../../../src/rom/MusicData'
import {
  getLevelMusicBankAddrIfReadable,
  getBankBlockSize,
  readBankSongPointers,
} from '../../../../src/rom/SpcBuilder'
import {
  LoadMusicResult,
  MusicListDto,
  MusicService,
  MusicTrackDetailsDto,
  MusicTrackDto,
} from '../common/music-protocol'

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

    const levelTable = readLevelMusicTable(rom)
    const tracks: MusicTrackDto[] = readBankSongPointers(rom, bankRomAddr).map(p => ({
      bgmCommand: p.bgmCommand,
      bgmHex: hex(p.bgmCommand),
      // Which level-header music indices (0-7) select this track.
      levelIndices: levelTable.filter(e => e.bgmCommand === p.bgmCommand).map(e => e.index),
    }))

    const list: MusicListDto = { tracks, trackCount: tracks.length }
    return { status: 'ok', list }
  }

  async trackDetails(manifestPath: string, bgmCommand: number): Promise<MusicTrackDetailsDto> {
    const rom = this.romFor(manifestPath)
    const bankRomAddr = getLevelMusicBankAddrIfReadable(rom)
    if (bankRomAddr === null) {
      throw new Error('The level music bank is not readable on this cartridge')
    }

    const pointers = readBankSongPointers(rom, bankRomAddr)
    const entry = pointers.find(p => p.bgmCommand === bgmCommand)
    if (!entry) {
      throw new Error(`No track ${hex(bgmCommand)} in the level music bank`)
    }

    const levelTable = readLevelMusicTable(rom)

    return {
      bgmCommand: entry.bgmCommand,
      bgmHex: hex(entry.bgmCommand),
      levelIndices: levelTable.filter(e => e.bgmCommand === entry.bgmCommand).map(e => e.index),
      bankRomAddr: hex(bankRomAddr, 6),
      bankSize: getBankBlockSize(rom, bankRomAddr),
      aramPointer: hex(entry.aramPointer, 4),
    }
  }

  /**
   * The cartridge behind a project, working copy included, or a throw.
   *
   * Read fresh from the registry each call: it is itself the shared cache,
   * so this never needs its own.
   */
  private romFor(manifestPath: string): RomFile {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') {
      throw new Error(
        `The base cartridge for ${r.baseRom.title || 'this project'} is not on this machine`,
      )
    }
    if (r.status === 'unreadable') throw new Error(r.reason)
    return RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes()))
  }
}
