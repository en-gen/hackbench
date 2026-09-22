/**
 * Backend half of the palette view.
 *
 * Read-only, so the only work here is resolving the cartridge (same
 * registry-lookup pattern as ProjectServiceImpl.romFor / loadMaps in
 * project-server.ts) and reshaping PaletteStockTables' output onto the wire.
 * The per-cell table attribution itself lives in src/rom/PaletteStockTables.ts,
 * not here, so it stays theia-free and importable by a plain Vitest test.
 */
import { injectable } from '@theia/core/shared/inversify'
import { openProject } from '../../../../src/project/Project'
import { RomRegistry } from '../../../../src/project/RomRegistry'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
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
  PaletteVariantDto,
  RomPalettesDto,
} from '../common/palette-protocol'

@injectable()
export class PaletteServiceImpl implements PaletteService {
  private readonly registry = new RomRegistry()

  async loadPalettes(manifestPath: string): Promise<LoadPaletteResult> {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      return { status: 'rom-not-located', baseRom: project.baseRom }
    }

    // A short or garbage file has PaletteLoader silently default every read
    // to a filler colour rather than throw (RomFile.readAt returns null past
    // the end of the file, and readEntry falls back to its row default),
    // which would otherwise come back `ok` with a full grid of fabricated
    // cells and no signal anything failed.
    //
    // Every PaletteLoader.ts address folds to a file offset under 16 KB
    // (LoROM bank 0), well inside SmwRom's own map-mode check (SmwRom.ts's
    // _validateOrWarn reads file offset $7FD5, needing 32 KB+) - so a file
    // too short for the palette tables is already too short for THAT check
    // and throws there first. Catching it here, rather than duplicating a
    // second bounds check that could never be the one to fire, is what
    // actually reflects where a truncated file first fails.
    let rom: SmwRom
    try {
      rom = new SmwRom(RomFile.load(romPath))
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
      variants: g.variants.map((v): PaletteVariantDto => {
        const dto: PaletteVariantDto = {
          label: v.label,
          romAddr: v.romAddr,
          rows: v.rows.map(row => row.map(toCellDto)),
        }
        if (v.backAreaColor) dto.backAreaColor = toColorDto(v.backAreaColor)
        return dto
      }),
    })),
  }
}
