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
 * Every DECISION the write path makes lives in map16-decode.ts's
 * `gateQuadrantWrite`, not here, and deliberately: this file imports
 * `@theia/core/shared/inversify`, the unit job does not install the
 * `theia/` workspace, and a test that reaches it fails to load in CI while
 * passing on any machine that has the workspace. What is left here is what
 * genuinely needs the container - resolving the working copy and handing
 * the op to WorkingRomRegistry.setWord, the SAME mechanism
 * palette-server.ts's setColor uses.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { WorkingRomEntry, WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import {
  LoadMap16Result,
  Map16Field,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16Service,
  Map16ServiceClient,
  Map16QuadrantKey,
  SetMap16Result,
} from '../common/map16-protocol'
import { decodeMap16Sheet, gateQuadrantWrite } from './map16-decode'
import { WorkingCopyNotifier } from './working-copy-notifier'

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

  async setQuadrantField(
    manifestPath: string,
    tileset: number,
    layer: Map16Layer,
    paletteVariant: Map16PaletteVariantDto,
    tileId: number,
    which: Map16QuadrantKey,
    field: Map16Field,
    value: number | boolean,
  ): Promise<SetMap16Result> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)

    // Every refusal is the gate's, and none of them reaches setWord.
    const gate = gateQuadrantWrite(this.romFileFrom(r), tileset, layer, tileId, which, field, value)
    if (gate.status !== 'ok') return gate

    const result = this.workingRoms.setWord(manifestPath, gate.write)
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
    // decodeMap16Sheet's own refusal ('unavailable', an unreadable or
    // expanded Map16) is a LOAD result, not a throw: the view says why it
    // cannot show the table rather than rendering two pages of one that is
    // bigger. See DecodeMap16Result.
    return decodeMap16Sheet(this.smwRomFrom(r), tileset, layer, paletteVariant)
  }

  private romFileFrom(entry: WorkingRomEntry): RomFile {
    return RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes()))
  }

  private smwRomFrom(entry: WorkingRomEntry): SmwRom {
    return new SmwRom(this.romFileFrom(entry))
  }
}
