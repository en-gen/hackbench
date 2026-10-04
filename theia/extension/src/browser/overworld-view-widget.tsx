/**
 * The Overworld views: L2 (background) under L1 (foreground), one canvas each.
 *
 * The hub (area 0) is the one main-area Overworld view, half 0 at 512x512. An area
 * (1..N) is its own tab, keyed by area: its 256x224 camera window over half 1, in the
 * area's own tileset and palette (#364). Follows ProjectContext, and redraws when the
 * backend reports the working copy changed. A refusal shows its reason and
 * no canvas. Styling reuses the Graphics view's classes (style/gfx.css).
 * The layer toggles re-compose the layers already fetched, with no round trip.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, optional, postConstruct } from '@theia/core/shared/inversify'
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
/** One tab per area; the widget id is `${OVERWORLD_AREA_VIEW_ID}:${area}`. */
export const OVERWORLD_AREA_VIEW_ID = 'hackbench.overworld-area-view'
/** Bound only in an area tab's own container; the hub has none. */
export const OverworldAreaOptions = Symbol('OverworldAreaOptions')
export interface OverworldAreaOptions {
  area: number
}
/** Opens or focuses the one Overworld view; the map explorer's Overworld row runs it. */
export const OVERWORLD_FOCUS_COMMAND_ID = 'hackbench.overworld.focus'
/** Opens or focuses one area's tab; runs with `{ area, activate }`. */
export const OVERWORLD_OPEN_AREA_COMMAND_ID = 'hackbench.overworld.openArea'

@injectable()
export class OverworldViewWidget extends ReactWidget {
  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(GfxFrontendClient) protected readonly pushClient!: GfxFrontendClient
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext
  @inject(OverworldAreaOptions) @optional() protected readonly areaOptions?: OverworldAreaOptions

  /** 0 is the hub. */
  get area(): number {
    return this.areaOptions?.area ?? 0
  }

  protected manifestPath: string | undefined
  protected dto: OverworldDto | undefined
  protected layers: { l1: OwLayerPixels; l2: OwLayerPixels | null } | undefined
  protected visible = { l1: true, l2: true }
  protected error: string | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  protected readonly canvasRef = (el: HTMLCanvasElement | null): void => {
    this.canvasEl = el
    this.paintCanvas()
  }
  protected reloadToken = 0

  @postConstruct()
  protected init(): void {
    const label = this.area === 0 ? 'Overworld' : `Area ${this.area}`
    this.id = this.area === 0 ? OVERWORLD_VIEW_ID : `${OVERWORLD_AREA_VIEW_ID}:${this.area}`
    this.title.label = label
    this.title.caption = label
    this.title.iconClass = this.area === 0 ? 'codicon codicon-globe' : 'codicon codicon-map'
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
        dto =
          this.area === 0
            ? await this.gfx.overworld(manifestPath)
            : await this.gfx.overworldArea(manifestPath, this.area)
      } catch (err) {
        error = (err as Error).message
      }
    }
    if (token !== this.reloadToken) return
    this.dto = dto
    const pixels = (l: OverworldLayerDto, prioCell: number): OwLayerPixels => ({
      rgba: decodeRgba(l.rgbaBase64),
      prio: decodeBase64Bytes(l.prioBase64),
      prioCell,
    })
    this.layers =
      dto?.status === 'ok'
        ? {
            l1: pixels(dto.l1, dto.prioCell),
            l2: dto.l2 ? pixels(dto.l2, dto.prioCell) : null,
          }
        : undefined
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
    if (this.dto?.status !== 'ok' || !this.layers || !this.canvasEl) return
    const { backdrop, width, height } = this.dto
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
          <span className="hb-gfx-view-title">{this.title.label}</span>
          <LayerToggle
            highlight="top"
            label="Effects not drawn yet"
            pressed={false}
            disabled
            control="layer-l3"
            onClick={() => undefined}
          />
          <LayerToggle
            highlight="middle"
            label="Foreground"
            pressed={this.visible.l1}
            control="layer-l1"
            onClick={() => this.toggle('l1')}
          />
          <LayerToggle
            highlight="bottom"
            label="Background"
            pressed={this.visible.l2}
            disabled={dto?.status === 'ok' && !!dto.l2Unavailable}
            control="layer-l2"
            onClick={() => this.toggle('l2')}
          />
          {dto?.status === 'ok' && (
            <span className="hb-gfx-view-summary hb-overworld-note">
              Map data before any event; drawn with area {this.area}&apos;s tileset and palette.
            </span>
          )}
        </div>
        {reason && <div className="hb-gfx-view-error hb-overworld-reason">{reason}</div>}
        {dto?.status === 'ok' && dto.l2Unavailable && (
          <div className="hb-gfx-view-error hb-overworld-l2-reason">
            {`Background unavailable: ${dto.l2Unavailable}`}
          </div>
        )}
        {dto?.status === 'ok' && (
          <div className="hb-gfx-view-canvas-wrap">
            <canvas
              data-area={this.area}
              className="hb-gfx-view-canvas hb-overworld-canvas"
              ref={this.canvasRef}
            />
          </div>
        )}
      </div>
    )
  }
}
