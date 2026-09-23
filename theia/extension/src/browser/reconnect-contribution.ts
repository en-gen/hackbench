/**
 * Lets the browser build reconnect to a restarted backend without a reload.
 *
 * Each browser backend mints a random connection token at startup and hands
 * it to the page as a cookie on HTTP requests; WebSocket upgrades without
 * the current token are refused with 403 (@theia/core
 * node/hosting/browser-connection-token). A restarted backend has a new
 * token, so the page's socket.io retries fail forever and the app sits
 * offline, although the backend holds nothing that is not on disk.
 *
 * While offline, this makes an ordinary same-origin request, which is how
 * the page got the cookie in the first place: the next socket.io retry then
 * carries the new token. Theia's own reconnect takes it from there. Nothing
 * is weakened, as the cookie stays SameSite=Strict and HttpOnly, reachable
 * only by a page this backend serves. The Electron build validates with its
 * own token and never goes through this.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { FrontendApplicationContribution } from '@theia/core/lib/browser'
import {
  ConnectionStatus,
  ConnectionStatusService,
} from '@theia/core/lib/browser/connection-status-service'

const RETRY_MS = 2000

@injectable()
export class ReconnectContribution implements FrontendApplicationContribution {
  @inject(ConnectionStatusService) protected readonly status!: ConnectionStatusService

  private timer: ReturnType<typeof setInterval> | undefined

  onStart(): void {
    this.status.onStatusChange(s => {
      if (s === ConnectionStatus.OFFLINE) this.poll()
      else this.stopPolling()
    })
  }

  private poll(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      fetch('/', { cache: 'no-store', credentials: 'same-origin' }).catch(() => {
        /* backend still down; try again next tick */
      })
    }, RETRY_MS)
  }

  private stopPolling(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
