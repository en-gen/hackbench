/**
 * The Overworld view: L2 (background) under L1 (foreground), half 0 left of half 1.
 *
 * One instance in the main area. Follows ProjectContext, and redraws when the
 * backend reports the working copy changed. A refusal shows its reason and
 * no canvas. Styling reuses the Graphics view's classes (style/gfx.css).
 * The layer toggles re-compose the layers already fetched, with no round trip.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { GfxService, OverworldDto, OverworldLayerDto } from '../common/gfx-protocol'
import {
  compositeOverworld,
  type OwLayerPixels,
} from '../../../../src/rom/render/OverworldComposite'
import { GfxFrontendClient } from './gfx-push-client'
import { LayerToggle } from './layer-icon'
import { decodeBase64Bytes, decodeRgba, paintScaled } from './map16-pixels'
import { ProjectContext } from './project-context'

export const OVERWORLD_VIEW_ID = 'hackbench.overworld-view'

@injectable()
export class OverworldViewWidget extends ReactWidget {
  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(GfxFrontendClient) protected readonly pushClient!: GfxFrontendClient
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  protected manifestPath: string | undefined
  protected dto: OverworldDto | undefined
  protected layers: { l1: OwLayerPixels; l2: OwLayerPixels | null } | undefined
  protected visible = { l1: true, l2: true }
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
    this.node.tabIndex = 0
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
    let dto: OverworldDto | undefined
    let error: string | undefined
    if (manifestPath) {
      try {
        dto = await this.gfx.overworld(manifestPath)
      } catch (err) {
        error = (err as Error).message
      }
    }
    if (token !== this.reloadToken) return
    this.dto = dto
    const pixels = (l: OverworldLayerDto): OwLayerPixels => ({
      rgba: decodeRgba(l.rgbaBase64),
      prio: decodeBase64Bytes(l.prioBase64),
    })
    this.layers =
      dto?.status === 'ok' ? { l1: pixels(dto.l1), l2: dto.l2 ? pixels(dto.l2) : null } : undefined
    this.error = error
    this.update()
  }

  /** Theia counts a widget active only once focus lands inside it. */
  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg)
    this.paintCanvas()
  }

  protected paintCanvas(): void {
    if (!this.canvasEl || this.dto?.status !== 'ok' || !this.layers) return
    const { width, height, backdrop } = this.dto
    const { l1, l2 } = this.layers
    const px = compositeOverworld(
      width,
      height,
      backdrop,
      this.visible.l2 ? l2 : null,
      this.visible.l1 ? l1 : null,
    )
    paintScaled(this.canvasEl, px, width, height, 1)
  }

  protected toggle(layer: 'l1' | 'l2'): void {
    this.visible[layer] = !this.visible[layer]
    this.update()
  }

  protected render(): React.ReactNode {
    if (!this.manifestPath) {
      return <div className="hb-gfx-view-empty">Open a project to see its overworld.</div>
    }
    const dto = this.dto
    const reason = this.error ?? (dto?.status === 'unavailable' ? dto.reason : undefined)
    return (
      <div className="hb-gfx-view-body">
        <div className="hb-gfx-view-toolbar">
          <span className="hb-gfx-view-title">Overworld</span>
          <LayerToggle
            highlight="top"
            label="L3 (overlay) not drawn yet"
            pressed={false}
            disabled
            control="layer-l3"
            onClick={() => undefined}
          />
          <LayerToggle
            highlight="middle"
            label="L1 (foreground)"
            pressed={this.visible.l1}
            control="layer-l1"
            onClick={() => this.toggle('l1')}
          />
          <LayerToggle
            highlight="bottom"
            label="L2 (background)"
            pressed={this.visible.l2}
            disabled={dto?.status === 'ok' && !dto.l2}
            control="layer-l2"
            onClick={() => this.toggle('l2')}
          />
          {dto?.status === 'ok' && (
            <span className="hb-gfx-view-summary hb-overworld-note">
              Map data before any event; drawn with area 0&apos;s tileset and palette, so the right
              half may differ in game.
            </span>
          )}
        </div>
        {reason && <div className="hb-gfx-view-error hb-overworld-reason">{reason}</div>}
        {dto?.status === 'ok' && dto.l2Unavailable && (
          <div className="hb-gfx-view-error hb-overworld-l2-reason">
            {`L2 (background) unavailable: ${dto.l2Unavailable}`}
          </div>
        )}
        {dto?.status === 'ok' && (
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
