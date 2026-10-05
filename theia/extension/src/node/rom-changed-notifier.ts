/**
 * Bridges WorkingRomRegistry's ROM-swapped event to one JSON-RPC client (#576).
 * Per connection, like WorkingCopyNotifier: `setClient(undefined)` (a closed
 * window) releases the subscription so a dead proxy is never called again.
 * Plain TypeScript with no Theia import, so a unit test covers it in CI.
 */
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'

export interface RomChangedClient {
  onRomChanged(manifestPath: string): void
}

export class RomChangedNotifier {
  private unsubscribe: (() => void) | undefined

  constructor(private readonly registry: WorkingRomRegistry) {}

  setClient(client: RomChangedClient | undefined): void {
    this.unsubscribe?.()
    this.unsubscribe = client
      ? this.registry.onRomChanged(manifestPath => client.onRomChanged(manifestPath))
      : undefined
  }
}
