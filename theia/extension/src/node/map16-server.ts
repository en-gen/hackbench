/**
 * Backend half of the Map16 view.
 *
 * Reads and writes the project's WORKING COPY (WorkingRomRegistry), never
 * the base cartridge directly - see docs/glossary.md, "Working copy", and
 * workingCopyGate.test.ts, which enforces it mechanically. Subscribed to the
 * shared WorkingRom the same way gfx-server.ts is, so a palette edit made
 * elsewhere recolors an already-open Map16 view, and a Map16 edit made here
 * recolors an already-open GFX sheet - both go through the one
 * WorkingRomRegistry singleton (hackbench-backend-module.ts), never a
 * second store.
 *
 * The write path reuses WorkingRomRegistry.setWord - the SAME mechanism
 * palette-server.ts's setColor uses - with `mask: FULL_WORD_MASK` since a
 * Map16 subtile word is not a BGR555 color (bit 15 is vertical flip, real
 * data). See PaletteOp.ts's `Op.mask` and WorkingRomRegistry's setWord.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { WorkingRomEntry, WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { FULL_WORD_MASK } from '../../../../src/rom/PaletteOp'
import {
  LoadMap16Result,
  Map16Field,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16Service,
  Map16ServiceClient,
  Map16SubtileKey,
  SetMap16Result,
} from '../common/map16-protocol'
import { decodeMap16Sheet, nextSubtileWord, subtileWordAddress } from './map16-decode'
import { WorkingCopyNotifier } from './working-copy-notifier'

function hexWord(word: number): string {
  return `$${(word & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`
}

@injectable()
export class Map16ServiceImpl implements Map16Service {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  private readonly notifier = new WorkingCopyNotifier<Map16ServiceClient>()

  setClient(client: Map16ServiceClient | undefined): void {
    this.notifier.setClient(client)
  }

  async loadMap16(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
  ): Promise<LoadMap16Result> {
    return this.currentSheet(manifestPath, tileset, layer, paletteVariant)
  }

  async setSubtileField(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
    tileId: number,
    which: Map16SubtileKey,
    field: Map16Field,
    value: number | boolean,
  ): Promise<SetMap16Result> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)

    const romFile = this.romFileFrom(r)
    const addr = subtileWordAddress(romFile, tileset, layer, tileId, which)
    // Read the word straight from the working copy: `old` must be exactly
    // what is committed right now, not a re-encode of a decoded struct,
    // or a lossy codec would send a wrong `old` and every stale-check
    // would be comparing against the wrong thing (see WorkingRom.append).
    const oldWord = romFile.readWord(addr) ?? 0
    const newWord = nextSubtileWord(oldWord, field, value)

    const result = this.workingRoms.setWord(manifestPath, {
      romAddr: addr,
      oldHex: hexWord(oldWord),
      newHex: hexWord(newWord),
      mask: FULL_WORD_MASK,
    })
    // setWord's own `get` can, in principle, re-observe 'unreadable' (the
    // cart changed under us between the read above and this write) - not
    // part of SetMap16Result's shape, same as currentSheet's own throw.
    if (result.status === 'unreadable') throw new Error(result.reason)
    if (result.status !== 'ok') return result
    return this.currentSheet(manifestPath, tileset, layer, paletteVariant)
  }

  /**
   * The working copy, decoded to a sheet, or a throw for a genuinely
   * unreadable cart - same split as gfx-server.ts's romFor/palette-server.ts's
   * currentPalettes: `rom-not-located` is an ordinary first-run state, an
   * `unreadable` cart is a real failure the caller should not paper over.
   */
  private currentSheet(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
  ): LoadMap16Result {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)
    this.notifier.watch(manifestPath, r.working)
    return {
      status: 'ok',
      sheet: decodeMap16Sheet(this.smwRomFrom(r), tileset, layer, paletteVariant),
    }
  }

  private romFileFrom(entry: WorkingRomEntry): RomFile {
    return RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes()))
  }

  private smwRomFrom(entry: WorkingRomEntry): SmwRom {
    return new SmwRom(this.romFileFrom(entry))
  }
}
