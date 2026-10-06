/**
 * What one connection's project service pushes, and the wiring that keeps it
 * pushing: the edit event for every working copy the registry holds (whichever
 * service asked for it) and the ROM-changed event (#576). Plain TypeScript
 * with no Theia import, so a unit test covers it in CI; ProjectServiceImpl
 * only forwards `setClient` here.
 *
 * The registry is read through a getter because the impl receives it by
 * property injection, after construction.
 */
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { WorkingCopyClient, WorkingCopyNotifier } from './working-copy-notifier'
import { RomChangedClient, RomChangedNotifier } from './rom-changed-notifier'

export type ProjectConnectionClient = WorkingCopyClient & RomChangedClient

/**
 * The function ProjectServiceImpl assigns as its `setClient`: the real path
 * from the RPC call to the registry, kept out of the decorated class so a
 * plain-TS test can run it.
 */
export function forwardSetClient(
  registry: () => WorkingRomRegistry,
): (client: ProjectConnectionClient | undefined) => void {
  const connection = new ProjectConnection(registry)
  return client => connection.setClient(client)
}

export class ProjectConnection {
  private readonly edits = new WorkingCopyNotifier<ProjectConnectionClient>()
  private readonly roms: RomChangedNotifier
  private unwatchCopies: (() => void) | undefined

  constructor(private readonly registry: () => WorkingRomRegistry) {
    this.roms = new RomChangedNotifier(registry)
  }

  /** `undefined` is the closed connection: every subscription is released. */
  setClient(client: ProjectConnectionClient | undefined): void {
    this.edits.setClient(client)
    this.roms.setClient(client)
    this.unwatchCopies?.()
    this.unwatchCopies = client
      ? this.registry().onWorkingCopy(
          (manifestPath, working) => this.edits.watch(manifestPath, working),
          working => this.edits.unwatch(working),
        )
      : undefined
  }
}
