/**
 * Bridges WorkingRom's in-process change event to a JSON-RPC client.
 *
 * Every `*ServiceImpl` that reads a project's working copy uses one of
 * these to push "something changed, re-fetch" to its own frontend widget.
 * `watch` is idempotent per `WorkingRom` instance (a `WeakSet`, not a flag
 * keyed by manifest path) because `WorkingRomRegistry.get()` is called on
 * every request - without it, each call would add another subscriber and
 * a single edit would fire the client once per RPC call ever made.
 *
 * This is server-to-frontend, over JSON-RPC. Server-to-server (gfx-server.ts
 * reacting to a palette edit) is a DIFFERENT subscription, added directly
 * against the shared `WorkingRom` instance both services get from the same
 * `WorkingRomRegistry` - see gfx-server.ts.
 */
import { WorkingRom } from '../../../../src/project/WorkingRom'

export interface WorkingCopyClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export class WorkingCopyNotifier<Client extends WorkingCopyClient> {
  private client: Client | undefined
  private readonly subscribed = new WeakSet<WorkingRom>()

  setClient(client: Client | undefined): void {
    this.client = client
  }

  /** Subscribes `working` to notify this service's current client, tagged with `manifestPath`. */
  watch(manifestPath: string, working: WorkingRom): void {
    if (this.subscribed.has(working)) return
    this.subscribed.add(working)
    working.onDidChange(() => this.client?.onWorkingCopyChanged(manifestPath))
  }
}
