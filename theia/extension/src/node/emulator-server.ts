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
import * as fs from 'fs' // core files only; the cartridge comes from the working copy
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { CoreRegistry } from '../../../../src/project/CoreRegistry'
import {
  CoreFilesResult,
  CoreIdentityDto,
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
    return { status: 'ok', romBytes: Uint8Array.from(r.working.bytes()) }
  }
}
