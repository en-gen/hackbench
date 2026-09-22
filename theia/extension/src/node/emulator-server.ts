/**
 * Backend half of the emulator service.
 *
 * Thin on purpose, same rule as project-server.ts: bookkeeping lives in
 * CoreRegistry and RomRegistry, which are shell-free and unit tested without
 * Theia.
 */
import { injectable } from '@theia/core/shared/inversify'
import * as fs from 'fs'
import { openProject } from '../../../../src/project/Project'
import { RomRegistry } from '../../../../src/project/RomRegistry'
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
  private readonly roms = new RomRegistry()
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
    const project = openProject(manifestPath)
    const romPath = this.roms.resolve(project.baseRom.sha256)
    if (!romPath) {
      return { status: 'rom-not-located', baseRom: { title: project.baseRom.title } }
    }
    return { status: 'ok', romBytes: new Uint8Array(fs.readFileSync(romPath)) }
  }
}
