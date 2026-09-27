/**
 * Backend half of the Graphics service.
 *
 * Reads the project's WORKING COPY (WorkingRomRegistry), never the base
 * cartridge directly - see docs/glossary.md, "Working copy". This is what
 * makes a palette edit visibly recolour a GFX sheet: the same shared
 * `WorkingRom` instance palette-server.ts writes through is read here, and
 * subscribed to directly (in-process, not over RPC - see
 * working-copy-notifier.ts) so a change pushes a re-render to whatever GFX
 * view is open, the same way palette-server.ts pushes to its own view.
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
  GfxServiceClient,
  GfxSheetDto,
  LoadGfxFilesResult,
  OverworldL1Dto,
} from '../common/gfx-protocol'
import { decodeGfxSheet, listGfxFileInfos } from './gfx-decode'
import { decodeOverworldL1 } from './overworld-decode'
import { WorkingCopyNotifier } from './working-copy-notifier'

@injectable()
export class GfxServiceImpl implements GfxService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  private readonly notifier = new WorkingCopyNotifier<GfxServiceClient>()

  setClient(client: GfxServiceClient | undefined): void {
    this.notifier.setClient(client)
  }

  async listGfxFiles(manifestPath: string): Promise<LoadGfxFilesResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)
    this.notifier.watch(manifestPath, r.working)
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

  async overworldL1(manifestPath: string): Promise<OverworldL1Dto> {
    return decodeOverworldL1(this.romFor(manifestPath))
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
    this.notifier.watch(manifestPath, r.working)
    return this.smwRomFrom(r)
  }

  private smwRomFrom(entry: WorkingRomEntry): SmwRom {
    return new SmwRom(RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes())))
  }
}
