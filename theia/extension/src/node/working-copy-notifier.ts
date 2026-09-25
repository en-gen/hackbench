/**
 * Bridges WorkingRom's in-process change event to a JSON-RPC client.
 *
 * One instance per CONNECTION, not per service: the `*-backend-module.ts`
 * files bind each `*ServiceImpl` inside a `ConnectionContainerModule`, so a
 * second window gets its own instance rather than sharing one whose
 * `client` field the next connection would overwrite. `watch` stays
 * idempotent per `WorkingRom` (keyed by the instance, not a manifest-path
 * flag) because `WorkingRomRegistry.get()` runs on every request.
 *
 * `setClient(undefined)` also reports a closed connection (wired to the
 * client proxy's `onDidCloseConnection` in each backend module) and releases
 * every subscription this instance made, so a closed window's dead proxy is
 * never called again.
 *
 * A palette edit reaching an open GFX view is not a separate mechanism:
 * gfx-server.ts's own connection has its own notifier instance, `watch`ing
 * the same shared `WorkingRom` and pushing to its own client exactly as
 * palette-server.ts's does. This is the only `WorkingRom.onDidChange`
 * subscriber under `theia/extension/src/node`.
 */
import { WorkingRom } from '../../../../src/project/WorkingRom'

export interface WorkingCopyClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export class WorkingCopyNotifier<Client extends WorkingCopyClient> {
  private client: Client | undefined
  private readonly subscriptions = new Map<WorkingRom, () => void>()

  setClient(client: Client | undefined): void {
    this.client = client
    if (!client) {
      for (const unsubscribe of this.subscriptions.values()) unsubscribe()
      this.subscriptions.clear()
    }
  }

  /** Subscribes `working` to notify this service's current client, tagged with `manifestPath`. */
  watch(manifestPath: string, working: WorkingRom): void {
    if (this.subscriptions.has(working)) return
    this.subscriptions.set(
      working,
      working.onDidChange(() => this.client?.onWorkingCopyChanged(manifestPath)),
    )
  }
}
