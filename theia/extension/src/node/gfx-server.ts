/**
 * Backend half of the Graphics service.
 *
 * Thin on purpose, mirroring project-server.ts: ROM resolution and decoding
 * live in plain modules (src/rom/, gfx-decode.ts) that are unit tested
 * without Theia.
 */
import { injectable } from '@theia/core/shared/inversify'
import { openProject } from '../../../../src/project/Project'
import { RomRegistry } from '../../../../src/project/RomRegistry'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { GfxBpp, GfxService, GfxSheetDto, LoadGfxFilesResult } from '../common/gfx-protocol'
import { decodeGfxSheet, listGfxFileInfos } from './gfx-decode'

@injectable()
export class GfxServiceImpl implements GfxService {
  private readonly registry = new RomRegistry()

  async listGfxFiles(manifestPath: string): Promise<LoadGfxFilesResult> {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      return { status: 'rom-not-located', baseRom: project.baseRom }
    }
    return { status: 'ok', files: listGfxFileInfos(new SmwRom(RomFile.load(romPath))) }
  }

  async gfxSheet(
    manifestPath: string,
    index: number,
    bpp?: GfxBpp,
    paletteRow?: number,
  ): Promise<GfxSheetDto> {
    return decodeGfxSheet(this.romFor(manifestPath), index, bpp, paletteRow)
  }

  /**
   * The cartridge behind a project, or a refusal.
   *
   * Opened per call rather than cached: the registry re-verifies the hash, so
   * a cart the user swapped under us never keeps resolving to the old one.
   */
  private romFor(manifestPath: string): SmwRom {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      throw new Error(`The base cartridge for ${project.name} is not on this machine`)
    }
    return new SmwRom(RomFile.load(romPath))
  }
}
