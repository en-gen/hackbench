/**
 * Backend half of the palette view.
 *
 * Reads and writes the project's WORKING COPY (WorkingRomRegistry), never
 * the base cartridge directly - see docs/glossary.md, "Working copy". The
 * registry is a shared singleton (bound in hackbench-backend-module.ts) so
 * an edit made here is visible to gfx-server.ts's decode without either
 * server re-reading the ROM file.
 *
 * The per-cell table attribution itself lives in src/rom/PaletteStockTables.ts,
 * not here, so it stays theia-free and importable by a plain Vitest test.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import {
  buildStockTables,
  countCustomPaletteLevels,
  AttributedCell,
  AttributedGroup,
} from '../../../../src/rom/PaletteStockTables'
import { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import {
  LoadPaletteResult,
  PaletteCellDto,
  PaletteColorDto,
  PaletteGroupDto,
  PaletteService,
  PaletteServiceClient,
  PaletteVariantDto,
  RomPalettesDto,
  SetColorResult,
} from '../common/palette-protocol'
import { WorkingCopyNotifier } from './working-copy-notifier'

@injectable()
export class PaletteServiceImpl implements PaletteService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  private readonly notifier = new WorkingCopyNotifier<PaletteServiceClient>()

  setClient(client: PaletteServiceClient | undefined): void {
    this.notifier.setClient(client)
  }

  async loadPalettes(manifestPath: string): Promise<LoadPaletteResult> {
    return this.currentPalettes(manifestPath)
  }

  async setColor(
    manifestPath: string,
    romAddr: number,
    oldHex: string,
    newHex: string,
  ): Promise<SetColorResult> {
    const r = this.workingRoms.setColor(manifestPath, { romAddr, oldHex, newHex })
    if (r.status !== 'ok') return r
    return this.currentPalettes(manifestPath)
  }

  /**
   * The working copy, reshaped for the wire.
   *
   * A short or garbage file has PaletteLoader silently default every read
   * to a filler colour rather than throw (RomFile.readAt returns null past
   * the end of the file, and readEntry falls back to its row default),
   * which would otherwise come back `ok` with a full grid of fabricated
   * cells and no signal anything failed.
   *
   * Every PaletteLoader.ts address folds to a file offset under 16 KB
   * (LoROM bank 0), well inside SmwRom's own map-mode check (SmwRom.ts's
   * _validateOrWarn reads file offset $7FD5, needing 32 KB+) - so a file
   * too short for the palette tables is already too short for THAT check
   * and throws there first. Catching it here, rather than duplicating a
   * second bounds check that could never be the one to fire, is what
   * actually reflects where a truncated file first fails.
   */
  private currentPalettes(manifestPath: string): LoadPaletteResult {
    const r = this.workingRoms.get(manifestPath)
    if (r.status !== 'ok') return r
    this.notifier.watch(manifestPath, r.working)

    let rom: SmwRom
    try {
      rom = new SmwRom(RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes())))
    } catch (err) {
      return { status: 'unreadable', reason: (err as Error).message }
    }

    return {
      status: 'ok',
      palettes: toDto(buildStockTables(rom.rom), countCustomPaletteLevels(rom.rom)),
      romName: rom.internalName.trim(),
    }
  }
}

function toColorDto([r, g, b, a]: RgbaColor): PaletteColorDto {
  return { r, g, b, a }
}

function toCellDto(cell: AttributedCell): PaletteCellDto {
  if (!cell.written || !cell.color) return { written: false }
  return {
    written: true,
    color: toColorDto(cell.color),
    table: cell.table as string,
    romAddr: cell.romAddr,
  }
}

function toDto(groups: AttributedGroup[], customPaletteLevelCount: number): RomPalettesDto {
  return {
    customPaletteLevelCount,
    groups: groups.map((g): PaletteGroupDto => ({
      id: g.id,
      label: g.label,
      description: g.description,
      cgRamRow: g.cgRamRow,
      variants: g.variants.map((v): PaletteVariantDto => ({
        label: v.label,
        romAddr: v.romAddr,
        rows: v.rows.map(row => row.map(toCellDto)),
      })),
    })),
  }
}
