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
  GfxBpp,
  GfxEditStateDto,
  GfxPixelDto,
  GfxSaveDto,
  GfxService,
  GfxServiceClient,
  GfxSheetDto,
  LoadGfxFilesResult,
  SetGfxPixelDto,
} from '../common/gfx-protocol'
import { decodeGfxSheet, listGfxFileInfos } from './gfx-decode'
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

  /**
   * The sheet as the PAINTER sees it, which is ahead of the cartridge.
   *
   * Pixels come from the decoded table (the edit is there the moment it is
   * painted) and colours from the working copy (so a palette edit made in
   * another view recolours it). A file the table could not decode falls back
   * to the cartridge's own bytes, which is what makes the read-only case
   * still viewable.
   */
  async gfxSheet(
    manifestPath: string,
    index: number,
    bpp?: GfxBpp,
    paletteRow?: number,
  ): Promise<GfxSheetDto> {
    const rom = this.romFor(manifestPath)
    const gfx = this.workingRoms.gfxTable(manifestPath)
    const edited = gfx.status === 'ok' ? gfx.table.files[index]?.bytes : undefined
    return decodeGfxSheet(rom, index, bpp, paletteRow, edited?.length ? edited : undefined)
  }

  async setGfxPixel(manifestPath: string, pixel: GfxPixelDto): Promise<SetGfxPixelDto> {
    const r = this.workingRoms.setGfxPixel(manifestPath, { kind: 'gfxPixel', ...pixel })
    if (r.status === 'ok') return { status: 'ok' }
    if (r.status === 'refused') return r
    return { status: 'refused', reason: reasonOf(r) }
  }

  async saveGfx(manifestPath: string): Promise<GfxSaveDto> {
    const r = this.workingRoms.saveGfx(manifestPath)
    return toSaveDto(r)
  }

  async gfxEditState(manifestPath: string): Promise<GfxEditStateDto> {
    const r = this.workingRoms.gfxTable(manifestPath)
    if (r.status !== 'ok') {
      return {
        dirtyFiles: [],
        skippedOps: 0,
        lastSave: { status: 'unavailable', reason: reasonOf(r) },
      }
    }
    return {
      dirtyFiles: r.table.dirtyFiles(),
      skippedOps: r.skipped.length,
      lastSave: r.lastSave ? toSaveDto(r.lastSave) : null,
    }
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
      throw new Error(
        `The base cartridge for ${r.baseRom.title || 'this project'} is not on this machine`,
      )
    }
    if (r.status === 'unreadable') throw new Error(r.reason)
    this.notifier.watch(manifestPath, r.working)
    return this.smwRomFrom(r)
  }

  private smwRomFrom(entry: WorkingRomEntry): SmwRom {
    return new SmwRom(RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes())))
  }
}

/**
 * One phrasing for "we could not stand this project up", so a refusal the
 * user sees always says which of the three it was.
 */
function reasonOf(r: { status: string; reason?: string; baseRom?: { title: string } }): string {
  if (r.status === 'rom-not-located') {
    return `The base cartridge for ${r.baseRom?.title || 'this project'} is not on this machine`
  }
  return r.reason ?? r.status
}

function toSaveDto(r: {
  status: string
  reason?: string
  overage?: number
  bytesChanged?: number
  baseRom?: { title: string }
}): GfxSaveDto {
  if (r.status === 'ok') return { status: 'ok', bytesChanged: r.bytesChanged ?? 0 }
  if (r.status === 'overflow') {
    return { status: 'overflow', overage: r.overage ?? 0, reason: r.reason ?? '' }
  }
  return { status: 'unavailable', reason: reasonOf(r) }
}
