/**
 * Backend half of the music service.
 *
 * Thin on purpose, same rule as project-server.ts: the real work is
 * src/rom/MusicData.ts and src/rom/SpcBuilder.ts, unit tested without Theia.
 */
import { injectable } from '@theia/core/shared/inversify'
import { openProject } from '../../../../src/project/Project'
import { RomRegistry } from '../../../../src/project/RomRegistry'
import { RomFile } from '../../../../src/rom/RomFile'
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
  private readonly registry = new RomRegistry()

  async loadMusic(manifestPath: string): Promise<LoadMusicResult> {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      return { status: 'rom-not-located', baseRom: project.baseRom }
    }

    const rom = RomFile.load(romPath)
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
   * The cartridge behind a project, or a refusal.
   *
   * Opened per call, same as project-server.ts's romFor: the registry
   * re-verifies the hash, so a cart swapped under us never resolves stale.
   */
  private romFor(manifestPath: string): RomFile {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      throw new Error(`The base cartridge for ${project.name} is not on this machine`)
    }
    return RomFile.load(romPath)
  }
}
