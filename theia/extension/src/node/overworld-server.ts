/**
 * Backend half of the Overworld service. Reads the WORKING COPY and pushes a
 * redraw when it changes, exactly as gfx-server.ts does.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import {
  OverworldL1Dto,
  OverworldService,
  OverworldServiceClient,
} from '../common/overworld-protocol'
import { decodeOverworldL1 } from './overworld-decode'
import { WorkingCopyNotifier } from './working-copy-notifier'

@injectable()
export class OverworldServiceImpl implements OverworldService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  private readonly notifier = new WorkingCopyNotifier<OverworldServiceClient>()

  setClient(client: OverworldServiceClient | undefined): void {
    this.notifier.setClient(client)
  }

  async overworldL1(manifestPath: string): Promise<OverworldL1Dto> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') {
      throw new Error(`${r.baseRom.title || 'The base ROM'} is not on this machine`)
    }
    if (r.status === 'unreadable') throw new Error(r.reason)
    this.notifier.watch(manifestPath, r.working)
    const rom = new SmwRom(RomFile.fromBytes(r.romPath, Buffer.from(r.working.bytes())))
    return decodeOverworldL1(rom)
  }
}
