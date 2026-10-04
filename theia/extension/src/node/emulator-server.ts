/**
 * Backend half of the emulator service.
 *
 * Thin on purpose, same rule as project-server.ts: bookkeeping lives in
 * CoreRegistry and WorkingRomRegistry, which are shell-free and unit tested
 * without Theia.
 *
 * The cartridge handed to the core is the project's WORKING COPY, every
 * edit layer applied - the same bytes an export would write. It used to be
 * `fs.readFileSync` of the base cartridge, so booting the emulator after
 * editing a palette showed the unedited cart and the edit looked lost.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import * as fs from 'fs' // core files only; the ROM comes from the working copy
import { createHash } from 'crypto'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { CoreRegistry, validateCore } from '../../../../src/project/CoreRegistry'
import * as saves from '../../../../src/project/SaveStore'
import * as path from 'path'
import {
  CoreFilesResult,
  CoreIdentityDto,
  SaveSlotDto,
  EmulatorRomResult,
  EmulatorService,
  LocateCoreResult,
} from '../common/emulator-protocol'

@injectable()
export class EmulatorServiceImpl implements EmulatorService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry

  private readonly cores = new CoreRegistry()

  async registeredCore(): Promise<CoreIdentityDto | undefined> {
    const entry = this.cores.current()
    return entry ? { label: entry.label } : undefined
  }

  async forgetCore(): Promise<void> {
    this.cores.forget()
  }

  async locateCore(jsPath: string): Promise<LocateCoreResult> {
    try {
      const entry = this.cores.register(jsPath)
      return { status: 'ok', core: { label: entry.label } }
    } catch (err) {
      return { status: 'invalid', message: (err as Error).message }
    }
  }

  async checkCore(jsPath: string): Promise<LocateCoreResult> {
    const check = validateCore(path.resolve(jsPath))
    return check.ok
      ? { status: 'ok', core: { label: path.basename(jsPath) } }
      : { status: 'invalid', message: check.message ?? 'Not a usable core' }
  }

  async coreFiles(): Promise<CoreFilesResult> {
    const entry = this.cores.current()
    if (!entry) return { status: 'no-core' }
    return {
      status: 'ok',
      files: {
        js: fs.readFileSync(entry.jsPath, 'utf8'),
        wasm: new Uint8Array(fs.readFileSync(entry.wasmPath)),
      },
    }
  }

  /**
   * Mirrors ProjectServiceImpl's private romFor(), but hands back bytes rather
   * than a parsed SmwRom: the frontend cannot read the filesystem itself, and
   * this is the RPC boundary the driver's callMain('/rom.sfc') needs them
   * to cross.
   */
  async romForEmulator(manifestPath: string): Promise<EmulatorRomResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') {
      return { status: 'rom-not-located', baseRom: { title: r.baseRom.title } }
    }
    if (r.status !== 'ok') {
      return { status: 'rom-not-located', baseRom: { title: 'the base ROM' } }
    }
    // A COPY, not the registry's buffer: this crosses the RPC boundary and
    // the working copy's own cache must not be handed out by reference.
    const bytes = r.working.bytes()
    return { status: 'ok', romBytes: Uint8Array.from(bytes), digest: digestOf(bytes) }
  }

  async listSaves(manifestPath: string): Promise<SaveSlotDto[]> {
    const { dir, title } = this.project(manifestPath)
    return saves
      .listSaves(dir, title)
      .map(({ slot, label }) => (label ? { slot, label } : { slot }))
  }

  async loadSave(manifestPath: string, slot: number): Promise<Uint8Array | undefined> {
    const { dir, title } = this.project(manifestPath)
    return saves.loadSave(dir, title, slot)
  }

  async storeSave(manifestPath: string, slot: number, bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.length > saves.MAX_SAVE_BYTES) {
      throw new Error('not a save file')
    }
    const { dir, title } = this.project(manifestPath)
    saves.storeSave(dir, title, slot, bytes)
  }

  async deleteSave(manifestPath: string, slot: number): Promise<void> {
    const { dir, title } = this.project(manifestPath)
    saves.deleteSave(dir, title, slot)
  }

  async duplicateSave(
    manifestPath: string,
    slot: number,
    reserved: number[] = [],
  ): Promise<number> {
    const { dir, title } = this.project(manifestPath)
    return saves.duplicateSave(dir, title, slot, numbers(reserved))
  }

  async labelSave(manifestPath: string, slot: number, label: string): Promise<void> {
    if (typeof label !== 'string') throw new Error('not a label')
    const { dir, title } = this.project(manifestPath)
    saves.labelSave(dir, title, slot, label)
  }

  async listForeignSaves(manifestPath: string): Promise<string[]> {
    const { dir, title } = this.project(manifestPath)
    return saves.listForeignSaves(dir, title)
  }

  async importSave(manifestPath: string, file: string, reserved: number[] = []): Promise<number> {
    if (typeof file !== 'string') throw new Error('not a file name')
    const { dir, title } = this.project(manifestPath)
    return saves.importSave(dir, title, file, numbers(reserved))
  }

  async nextFreeSlot(manifestPath: string, reserved: number[] = []): Promise<number> {
    const { dir, title } = this.project(manifestPath)
    return saves.nextFreeSlot(dir, title, numbers(reserved))
  }

  /**
   * The folder of a real HackBench project: a manifest still on disk whose
   * ROM this machine has located. The path comes from the frontend, so it
   * must not become a way to write a saves/ folder next to an arbitrary
   * file, nor to recreate the folder of a project deleted since it was
   * cached.
   */
  private project(manifestPath: string): { dir: string; title: string } {
    if (!manifestPath.endsWith('.hbproj') || !fs.existsSync(manifestPath)) {
      throw new Error(`not a project: ${manifestPath}`)
    }
    const r = this.workingRoms.get(manifestPath)
    if (r.status !== 'ok') throw new Error(`not a project with a located ROM: ${manifestPath}`)
    // Saves are named for the title in the ROM's own header, recorded in
    // the manifest: the same on every machine the project is opened on.
    return { dir: path.dirname(manifestPath), title: r.project.baseRom.title }
  }

  async romDigest(manifestPath: string): Promise<string | undefined> {
    const r = this.workingRoms.get(manifestPath)
    return r.status === 'ok' ? digestOf(r.working.bytes()) : undefined
  }
}

/** Content identity: an undo back to the booted state reads as unchanged. */
function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Reserved slot numbers from the frontend: integers only, anything else dropped. */
function numbers(values: unknown): number[] {
  return Array.isArray(values) ? values.filter((v): v is number => Number.isInteger(v)) : []
}
