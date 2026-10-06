/**
 * Backend half of the Graphics service.
 *
 * Reads the project's WORKING COPY (WorkingRomRegistry), never the base
 * cartridge directly - see docs/glossary.md, "Working copy". This is what
 * makes a palette edit visibly recolour a GFX sheet: the same shared
 * `WorkingRom` instance palette-server.ts writes through is read here. An
 * open GFX view hears about an edit from the one edit event the project
 * service pushes (working-copy-notifier.ts), not from this service.
 *
 * `bytes()` is always re-decoded fresh (no cache to invalidate here), which
 * is the correct-first choice the brief asked for: a recolour-only fast
 * path (skip re-decoding tile INDICES when only a palette word changed) is
 * a real future optimization, not built yet, because it was not measured to
 * be needed.
 *
 * Thin otherwise, mirroring project-server.ts: decoding lives in plain
 * modules (src/rom/, gfx-decode.ts) that are unit tested without Theia.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { WorkingRomEntry, WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import {
  GfxFormat,
  GfxService,
  GfxSheetDto,
  LoadGfxFilesResult,
  OverworldAreasDto,
  OverworldDto,
} from '../common/gfx-protocol'
import { decodeGfxSheet, listGfxFileInfos } from './gfx-decode'
import { decodeAreaView, decodeOverworld, decodeOverworldAreas } from './overworld-decode'

@injectable()
export class GfxServiceImpl implements GfxService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  async listGfxFiles(manifestPath: string): Promise<LoadGfxFilesResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)
    return { status: 'ok', files: listGfxFileInfos(this.smwRomFrom(r)) }
  }

  async gfxSheet(
    manifestPath: string,
    index: number,
    bpp?: GfxFormat,
    paletteRow?: number,
  ): Promise<GfxSheetDto> {
    return decodeGfxSheet(this.romFor(manifestPath), index, bpp, paletteRow)
  }

  async overworld(manifestPath: string): Promise<OverworldDto> {
    return decodeOverworld(this.romFor(manifestPath))
  }

  async overworldAreas(manifestPath: string): Promise<OverworldAreasDto> {
    return decodeOverworldAreas(this.romFor(manifestPath))
  }

  async overworldArea(manifestPath: string, area: number): Promise<OverworldDto> {
    return decodeAreaView(this.romFor(manifestPath), area)
  }

  /**
   * The cartridge behind a project, working copy included, or a throw.
   *
   * Read fresh from the registry each call rather than cached here: the
   * registry itself is the shared cache, and re-reading it (not the ROM
   * file) is what lets an edit made through another view show up on the
   * very next sheet decode.
   */
  private romFor(manifestPath: string): SmwRom {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') {
      throw new Error(`${r.baseRom.title || 'The base ROM'} is not on this machine`)
    }
    if (r.status === 'unreadable') throw new Error(r.reason)
    return this.smwRomFrom(r)
  }

  private smwRomFrom(entry: WorkingRomEntry): SmwRom {
    return new SmwRom(RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes())))
  }
}
