/**
 * The Overworld views: L2 (background) under L1 (foreground), one canvas each.
 *
 * The hub (area 0) is half 0 at 512x512. An area (1..N) is its 256x224 camera window over
 * half 1, in the area's own tileset and palette (#364). Rows open like map rows
 * (PreviewTabs): a click shows an area in the one preview tab, a double-click pins it as
 * its own tab, so one widget class serves all of them and `open(area)` retargets it.
 * Ctrl + wheel and the stepper zoom the canvas (CSS only). Follows ProjectContext, and redraws when the
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
import { LayerToggle } from './layer-icon'
import { WheelBinding, ZoomController } from './zoom-controller'
import { decodeBase64Bytes, decodeRgba, paintScaled } from './map16-pixels'
import { ProjectContext } from './project-context'
import { previewId } from './preview-id'

export const OVERWORLD_VIEW_ID = 'hackbench.overworld-view'
/** A pinned area's widget id is `${OVERWORLD_AREA_VIEW_ID}:${area}`; the hub keeps OVERWORLD_VIEW_ID. */
export const OVERWORLD_AREA_VIEW_ID = 'hackbench.overworld-area-view'
/** The id of area `area`'s pinned tab (0 is the hub). */
export const overworldTabId = (area: number): string =>
  area === 0 ? OVERWORLD_VIEW_ID : `${OVERWORLD_AREA_VIEW_ID}:${area}`
/** Shows the hub (area 0): `{ activate }` false previews it, true pins it. */
export const OVERWORLD_FOCUS_COMMAND_ID = 'hackbench.overworld.focus'
/** Shows one area, as `{ area, activate }`: previewed, or pinned when `activate`. */
export const OVERWORLD_OPEN_AREA_COMMAND_ID = 'hackbench.overworld.openArea'

/** Canvas zoom. Integer factors only, so tile edges stay on device pixels. */
const ZOOM_OPTIONS = [1, 2, 3, 4]

@injectable()
export class OverworldViewWidget extends ReactWidget {
  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  /** 0 is the hub. */
  area = 0
  protected opened = false
  protected readonly zoomController = new ZoomController(ZOOM_OPTIONS, 1)
  protected wheelBinding: WheelBinding | undefined

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

  /** The scroll container: Ctrl + wheel binds here and anchors on the cursor within it. */
  protected readonly scrollerRef = (el: HTMLDivElement | null): void => {
    this.wheelBinding?.dispose()
    this.wheelBinding = el ? this.zoomController.bindWheel(el, () => this.canvasEl) : undefined
  }

  @postConstruct()
  protected init(): void {
    // A fresh widget is nobody's tab yet; PreviewTabs gives the preview this id, and the pin
    // path sets `overworldTabId(area)` before attaching, so open() never owns the id.
    this.id = previewId(OVERWORLD_VIEW_ID)
    this.title.closable = true
    this.addClass('hb-map-view')
    this.addClass('hb-overworld-view')
    this.node.tabIndex = 0
    this.toDispose.push(this.zoomController.onDidChange(() => this.update()))
    this.toDispose.push(this.zoomController)
    this.toDispose.push({ dispose: () => this.wheelBinding?.dispose() })
    this.toDispose.push(
      this.projectContext.onChanged(p => {
        if (this.opened) void this.load(p?.manifestPath)
      }),
    )
    this.toDispose.push(
      this.projectContext.onEdit(event => {
        if (event.subject === this.manifestPath) void this.load(event.subject)
      }),
    )
    this.toDispose.push(
      this.projectContext.onRomChanged(path => {
        if (path === this.manifestPath) void this.load(path)
      }),
    )
  }

  /** Points the widget at `area` (0 is the hub) and draws it. */
  async open(area: number): Promise<void> {
    this.area = area
    this.opened = true
    const label = area === 0 ? 'Overworld' : `Area ${area}`
    this.title.label = label
    this.title.caption = label
    this.title.iconClass = area === 0 ? 'codicon codicon-globe' : 'codicon codicon-map'
    this.node.dataset.area = String(area)
    this.dto = undefined
    this.layers = undefined
    await this.load(this.projectContext.current?.manifestPath)
  }

  shows(area: number): boolean {
    return this.opened && this.area === area
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
    if (this.dto?.status !== 'ok' || !this.layers || !this.canvasEl) {
      // No resize this call: drop a wheel anchor rather than misapply it to a later canvas.
      this.wheelBinding?.restoreAnchor()
      return
    }
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
    // Zoom is CSS only, so the bitmap stays 1:1 with the map's pixels.
    const zoom = this.zoomController.value
    this.canvasEl.style.width = `${width * zoom}px`
    this.canvasEl.style.height = `${height * zoom}px`
    this.wheelBinding?.restoreAnchor()
  }

  protected toggle(layer: 'l1' | 'l2'): void {
    this.visible[layer] = !this.visible[layer]
    this.update()
  }

  protected render(): React.ReactNode {
    if (!this.manifestPath) {
      return <div className="hb-map-view-empty">Open a project to see its overworld.</div>
    }
    const dto = this.dto
    const reason = this.error ?? (dto?.status === 'unavailable' ? dto.reason : undefined)
    const z = this.zoomController
    return (
      <div className="hb-map-view-main">
        <div className="hb-map-view-toolbar">
          <LayerToggle
            glyph="1"
            label="Layer 1 · Foreground"
            pressed={this.visible.l1}
            control="layer-l1"
            onClick={() => this.toggle('l1')}
          />
          <LayerToggle
            glyph="2"
            label="Layer 2 · Background"
            pressed={this.visible.l2}
            disabled={dto?.status === 'ok' && !!dto.l2Unavailable}
            control="layer-l2"
            onClick={() => this.toggle('l2')}
          />
          <LayerToggle
            glyph="3"
            label="Layer 3 not drawn yet: overworld layer 3"
            pressed={false}
            disabled
            control="layer-l3"
            onClick={() => undefined}
          />
          <LayerToggle
            glyph="S"
            label="Sprite toggle not wired yet"
            pressed={false}
            disabled
            control="layer-sprites"
            onClick={() => undefined}
          />
          <span className="hb-toolbar-spacer" />
          <button
            type="button"
            data-control="zoom-out"
            className="hb-icon-btn"
            disabled={!z.canZoomOut}
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => z.step(-1)}
          >
            <span className="codicon codicon-zoom-out" />
          </button>
          <span data-control="zoom-indicator" className="hb-zoom-indicator">
            {`${Math.round(z.value * 100)}%`}
          </span>
          <button
            type="button"
            data-control="zoom-in"
            className="hb-icon-btn"
            disabled={!z.canZoomIn}
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => z.step(1)}
          >
            <span className="codicon codicon-zoom-in" />
          </button>
        </div>
        {reason && (
          <div className="hb-map-view-note hb-map-view-error hb-overworld-reason">{reason}</div>
        )}
        {dto?.status === 'ok' && dto.l2Unavailable && (
          <div className="hb-map-view-note hb-overworld-l2-reason">
            {`Background unavailable: ${dto.l2Unavailable}`}
          </div>
        )}
        <div className="hb-map-view-scroller" ref={this.scrollerRef}>
          {dto?.status === 'ok' && (
            <canvas
              data-area={this.area}
              className="hb-pixel-canvas hb-overworld-canvas"
              ref={this.canvasRef}
            />
          )}
        </div>
      </div>
    )
  }
}
