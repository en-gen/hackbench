/**
 * One GFX file's tile sheet, opened from the Graphics explorer.
 *
 * Read-only: no editing, import, export or patch layer, per this change's
 * scope. The bit-depth and palette-row controls change what is DECODED
 * server-side and re-fetch, rather than re-decoding in the browser, so the
 * pure ROM-decode logic stays out of the frontend bundle (project-protocol.ts
 * states the same rule for its DTOs).
 *
 * The controls stay on screen even when the fetch fails: gfxSheet refuses a
 * file GfxLoader cannot place at any depth on its own (a relocated GFX
 * arrangement), and forcing an explicit depth is the only way to look at one
 * anyway, so hiding the picker behind the error would make that unreachable.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { Emitter } from '@theia/core'
import { ThemeService } from '@theia/core/lib/browser/theming'
import {
  GFX_FORMATS,
  GfxFormat,
  GfxService,
  GfxSheetDto,
  PALETTE_ROW_COUNT,
  gfxFormatLabel,
} from '../common/gfx-protocol'
import { GfxFrontendClient } from './gfx-push-client'
import { WheelBinding, ZoomController } from './zoom-controller'
import { ZoomStepper } from './zoom-stepper'
import { GridOverlay } from './grid-overlay'
import { perfEnd, perfStart } from '../common/perf-marks'

export const GFX_VIEW_ID = 'hackbench.gfx-view'
/**
 * Grid visibility is shared by every open GFX tab, like zoom: one switch for
 * the view, not one per sheet.
 */
const gridChanged = new Emitter<void>()
let gridShown = false

/** One 8x8 character, the unit a GFX sheet is built from. */
const GFX_CHAR_PX = 8

export interface GfxViewOptions {
  manifestPath: string
  index: number
  label: string
}

/**
 * A sheet is 128px wide, which is unreadably small on a modern display, so
 * the default is not 1x. Integer factors only: a fractional zoom lands tile
 * edges between device pixels and the sheet shimmers.
 */
const ZOOM_OPTIONS = [1, 2, 3, 4, 6, 8]
const DEFAULT_ZOOM = 4

/**
 * Zoom is a property of how the user is READING sheets, not of one sheet, so
 * it is shared: set 8x on any tab and every open sheet follows, including
 * ones opened later. Module scope rather than a service because nothing
 * outside this view has any use for it. Each widget still binds Ctrl +
 * wheel on its own node and disposes that binding independently.
 */
const sharedZoomController = new ZoomController(ZOOM_OPTIONS, DEFAULT_ZOOM)

/** Decodes the base64 RGBA payload back into bytes a canvas can paint. */
function decodeRgba(base64: string): Uint8ClampedArray {
  const binary = atob(base64)
  const bytes = new Uint8ClampedArray(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

@injectable()
export class GfxViewWidget extends ReactWidget {
  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(GfxFrontendClient) protected readonly pushClient!: GfxFrontendClient
  @inject(ThemeService) protected readonly themes!: ThemeService

  protected options: GfxViewOptions | undefined
  protected sheet: GfxSheetDto | undefined
  protected error: string | undefined
  /** User overrides; undefined defers to whatever the loader itself reports. */
  protected bppChoice: GfxFormat | undefined
  protected paletteRowChoice: number | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  protected wheelBinding: WheelBinding | undefined
  /** Bumped on every reload; a response is applied only if it is still current,
   * so two rapid control changes cannot have the slower one overwrite the newer. */
  protected reloadToken = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-gfx-view')
    this.title.closable = true
    this.node.tabIndex = 0
    // Every open sheet redraws when any one of them changes the zoom.
    this.toDispose.push(sharedZoomController.onDidChange(() => this.update()))
    this.toDispose.push(gridChanged.event(() => this.update()))
    // The grid color is read from the theme at render.
    this.toDispose.push(this.themes.onDidColorThemeChange(() => this.update()))
    // `this.node` (`.hb-gfx-view`) is the widget's own scroll container in
    // BOTH axes - the canvas wrap has no bounded height of its own, so it
    // never scrolls itself. `this.node` exists for the widget's whole life,
    // unlike the canvas, which only exists once a sheet has loaded.
    this.wheelBinding = sharedZoomController.bindWheel(this.node, () => this.canvasEl)
    this.toDispose.push(this.wheelBinding)
    // A palette edit (or anything else touching this project's working
    // copy) re-decodes this sheet, which is what makes an edit visibly
    // recolour an already-open GFX view without the user reopening it.
    this.toDispose.push(
      this.pushClient.onChanged(manifestPath => {
        if (manifestPath === this.options?.manifestPath) void this.reload()
      }),
    )
  }

  async open(options: GfxViewOptions): Promise<void> {
    perfStart('open-gfx')
    this.options = options
    this.id = `${GFX_VIEW_ID}:${options.index}`
    this.title.label = options.label
    this.title.caption = options.label
    this.title.iconClass = 'codicon codicon-file-media'

    this.sheet = undefined
    this.error = undefined
    this.bppChoice = undefined
    this.paletteRowChoice = undefined
    this.update()

    await this.reload()
  }

  protected async reload(): Promise<void> {
    if (!this.options) return
    const token = ++this.reloadToken
    let sheet: GfxSheetDto | undefined
    let error: string | undefined
    try {
      sheet = await this.gfx.gfxSheet(
        this.options.manifestPath,
        this.options.index,
        this.bppChoice,
        this.paletteRowChoice,
      )
    } catch (err) {
      error = (err as Error).message
    }
    if (token !== this.reloadToken) return // superseded by a later change; drop this stale response
    this.sheet = sheet
    this.error = error
    this.update()
  }

  /** Which file this tab shows, so a pin can retire the preview of it. */
  shows(index: number): boolean {
    return this.options?.index === index
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  /** Stable, so React does not detach and re-attach the canvas on every commit. */
  protected readonly bindCanvas = (el: HTMLCanvasElement | null): void => {
    this.canvasEl = el
    this.paintCanvas()
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg)
    this.paintCanvas()
  }

  protected paintCanvas(): void {
    if (!this.canvasEl || !this.sheet || this.sheet.height === 0) {
      // No resize is happening this call; discard rather than let a
      // wheel-driven anchor sit pending and misapply on a later, unrelated
      // canvas - see the anchor's own staleness check in restoreAnchor.
      this.wheelBinding?.restoreAnchor()
      return
    }
    const { width, height, rgbaBase64 } = this.sheet
    const zoom = sharedZoomController.value
    this.canvasEl.width = width
    this.canvasEl.height = height
    // Zoom is CSS only, so the bitmap stays 1:1 with the ROM's pixels and
    // putImageData never has to resample.
    this.canvasEl.style.width = `${width * zoom}px`
    this.canvasEl.style.height = `${height * zoom}px`
    this.wheelBinding?.restoreAnchor()
    const ctx = this.canvasEl.getContext('2d')
    if (!ctx) return
    ctx.putImageData(new ImageData(decodeRgba(rgbaBase64), width, height), 0, 0)
    perfEnd('open-gfx')
  }

  toggleGrid(): void {
    gridShown = !gridShown
    gridChanged.fire()
  }

  protected handleBppChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.bppChoice = GFX_FORMATS.find(f => String(f) === e.target.value)
    void this.reload()
  }

  protected handlePaletteRowChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.paletteRowChoice = Number(e.target.value)
    void this.reload()
  }

  protected render(): React.ReactNode {
    if (!this.options) {
      return <div className="hb-gfx-view-empty">Reading the ROM...</div>
    }

    const s = this.sheet
    // While a sheet is loaded the controls reflect what actually produced
    // it; before the first one arrives (or after a refusal) they reflect
    // only the user's own pending choice, defaulting to the lowest option.
    const bppValue = this.bppChoice ?? s?.bpp ?? GFX_FORMATS[0]
    const rowValue = this.paletteRowChoice ?? s?.paletteRow ?? 0

    return (
      <div className="hb-gfx-view-body">
        <div className="hb-gfx-view-toolbar">
          <span className="hb-gfx-view-title">{this.options.label}</span>
          {s && (
            <span className="hb-gfx-view-summary">
              {`${s.tileCount} tiles · ${s.width}×${s.height}px`}
            </span>
          )}
          <label className="hb-gfx-view-control">
            Depth
            <select
              id="hb-gfx-bpp-select"
              className="theia-select"
              value={bppValue}
              onChange={this.handleBppChange}
            >
              {GFX_FORMATS.map(b => (
                <option key={b} value={b}>
                  {gfxFormatLabel(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="hb-gfx-view-control">
            Palette row
            <select
              id="hb-gfx-palette-row-select"
              className="theia-select"
              value={rowValue}
              onChange={this.handlePaletteRowChange}
            >
              {Array.from({ length: PALETTE_ROW_COUNT }, (_, r) => (
                <option key={r} value={r}>{`Row ${r}`}</option>
              ))}
            </select>
          </label>
          <span className="hb-toolbar-spacer" />
          <button
            data-control="grid-toggle"
            type="button"
            className={'hb-icon-btn' + (gridShown ? ' hb-icon-btn-on' : '')}
            aria-pressed={gridShown}
            title={gridShown ? 'Hide grid' : 'Show grid'}
            aria-label={gridShown ? 'Hide grid' : 'Show grid'}
            onClick={() => this.toggleGrid()}
          >
            <span className="codicon codicon-table" />
          </button>
          <ZoomStepper controller={sharedZoomController} />
        </div>
        {this.error && <div className="hb-gfx-view-error">{this.error}</div>}
        {s && s.height > 0 && (
          <div className="hb-gfx-view-canvas-wrap hb-grid-host">
            <canvas className="hb-gfx-view-canvas hb-pixel-canvas" ref={this.bindCanvas} />
            {gridShown && (
              <GridOverlay
                cellSize={GFX_CHAR_PX}
                width={s.width}
                height={s.height}
                zoom={sharedZoomController.value}
              />
            )}
          </div>
        )}
      </div>
    )
  }
}
