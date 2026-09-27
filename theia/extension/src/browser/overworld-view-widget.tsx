/**
 * The Overworld view: the overworld's L1 (foreground) as one 1024x512 map.
 *
 * One instance in the main area. Follows ProjectContext, and redraws when the
 * backend reports the working copy changed. A refusal shows its reason and
 * no canvas. Styling reuses the Graphics view's classes (style/gfx.css).
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { Emitter, Event } from '@theia/core/lib/common'
import {
  OverworldL1Dto,
  OverworldService,
  OverworldServiceClient,
} from '../common/overworld-protocol'
import { decodeRgba, paintScaled } from './map16-pixels'
import { ProjectContext } from './project-context'

export const OVERWORLD_VIEW_ID = 'hackbench.overworld-view'

/** See palette-push-client.ts for why this is its own singleton. */
@injectable()
export class OverworldFrontendClient implements OverworldServiceClient {
  private readonly emitter = new Emitter<string>()
  readonly onChanged: Event<string> = this.emitter.event
  onWorkingCopyChanged(manifestPath: string): void {
    this.emitter.fire(manifestPath)
  }
}

@injectable()
export class OverworldViewWidget extends ReactWidget {
  @inject(OverworldService) protected readonly overworld!: OverworldService
  @inject(OverworldFrontendClient) protected readonly pushClient!: OverworldFrontendClient
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  protected manifestPath: string | undefined
  protected l1: OverworldL1Dto | undefined
  protected error: string | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  protected reloadToken = 0

  @postConstruct()
  protected init(): void {
    this.id = OVERWORLD_VIEW_ID
    this.title.label = 'Overworld'
    this.title.caption = 'Overworld'
    this.title.iconClass = 'codicon codicon-globe'
    this.title.closable = true
    this.addClass('hb-gfx-view')
    this.toDispose.push(this.projectContext.onChanged(p => void this.load(p?.manifestPath)))
    this.toDispose.push(
      this.pushClient.onChanged(path => {
        if (path === this.manifestPath) void this.load(path)
      }),
    )
    void this.load(this.projectContext.current?.manifestPath)
  }

  async load(manifestPath: string | undefined): Promise<void> {
    this.manifestPath = manifestPath
    const token = ++this.reloadToken
    let l1: OverworldL1Dto | undefined
    let error: string | undefined
    if (manifestPath) {
      try {
        l1 = await this.overworld.overworldL1(manifestPath)
      } catch (err) {
        error = (err as Error).message
      }
    }
    if (token !== this.reloadToken) return
    this.l1 = l1
    this.error = error
    this.update()
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg)
    this.paintCanvas()
  }

  protected paintCanvas(): void {
    if (!this.canvasEl || this.l1?.status !== 'ok') return
    const { width, height, rgbaBase64 } = this.l1
    paintScaled(this.canvasEl, decodeRgba(rgbaBase64), width, height, 1)
  }

  protected render(): React.ReactNode {
    if (!this.manifestPath) {
      return <div className="hb-gfx-view-empty">Open a project to see its overworld.</div>
    }
    const l1 = this.l1
    const reason = this.error ?? (l1?.status === 'unavailable' ? l1.reason : undefined)
    return (
      <div className="hb-gfx-view-body">
        <div className="hb-gfx-view-toolbar">
          <span className="hb-gfx-view-title">Overworld: Foreground</span>
          {l1?.status === 'ok' && (
            <span className="hb-gfx-view-summary hb-overworld-note">
              Drawn in the main map&apos;s tileset and palette; colors outside it may be wrong.
            </span>
          )}
        </div>
        {reason && <div className="hb-gfx-view-error hb-overworld-reason">{reason}</div>}
        {l1?.status === 'ok' && (
          <div className="hb-gfx-view-canvas-wrap">
            <canvas
              className="hb-gfx-view-canvas hb-overworld-canvas"
              ref={el => {
                this.canvasEl = el
                this.paintCanvas()
              }}
            />
          </div>
        )}
      </div>
    )
  }
}
