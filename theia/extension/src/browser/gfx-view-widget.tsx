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
import { Emitter } from '@theia/core/lib/common'
import {
  GFX_FORMATS,
  GfxFormat,
  GfxService,
  GfxSheetDto,
  PALETTE_ROW_COUNT,
  gfxFormatLabel,
} from '../common/gfx-protocol'
import { GfxFrontendClient } from './gfx-push-client'

export const GFX_VIEW_ID = 'hackbench.gfx-view'

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
 * outside this view has any use for it.
 */
let sharedZoom = DEFAULT_ZOOM
const zoomChangedEmitter = new Emitter<number>()

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

  protected options: GfxViewOptions | undefined
  protected sheet: GfxSheetDto | undefined
  protected error: string | undefined
  /** User overrides; undefined defers to whatever the loader itself reports. */
  protected bppChoice: GfxFormat | undefined
  protected paletteRowChoice: number | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  /** Bumped on every reload; a response is applied only if it is still current,
   * so two rapid control changes cannot have the slower one overwrite the newer. */
  protected reloadToken = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-gfx-view')
    this.title.closable = true
    this.node.tabIndex = 0
    // Every open sheet redraws when any one of them changes the zoom.
    this.toDispose.push(zoomChangedEmitter.event(() => this.update()))
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

  /** React has committed the DOM by the time super returns, so the canvas element is current. */
  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg)
    this.paintCanvas()
  }

  protected paintCanvas(): void {
    if (!this.canvasEl || !this.sheet || this.sheet.height === 0) return
    const { width, height, rgbaBase64 } = this.sheet
    this.canvasEl.width = width
    this.canvasEl.height = height
    // Zoom is CSS only, so the bitmap stays 1:1 with the ROM's pixels and
    // putImageData never has to resample.
    this.canvasEl.style.width = `${width * sharedZoom}px`
    this.canvasEl.style.height = `${height * sharedZoom}px`
    const ctx = this.canvasEl.getContext('2d')
    if (!ctx) return
    ctx.putImageData(new ImageData(decodeRgba(rgbaBase64), width, height), 0, 0)
  }

  protected handleZoomChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    sharedZoom = Number(e.target.value)
    zoomChangedEmitter.fire(sharedZoom)
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
      return <div className="hb-gfx-view-empty">Reading the cartridge...</div>
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
          <label className="hb-gfx-view-control">
            Zoom
            <select
              id="hb-gfx-zoom-select"
              className="theia-select"
              value={sharedZoom}
              onChange={this.handleZoomChange}
            >
              {ZOOM_OPTIONS.map(z => (
                <option key={z} value={z}>{`${z}x`}</option>
              ))}
            </select>
          </label>
        </div>
        {this.error && <div className="hb-gfx-view-error">{this.error}</div>}
        {s && s.height > 0 && (
          <div className="hb-gfx-view-canvas-wrap">
            <canvas
              className="hb-gfx-view-canvas"
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
