/**
 * One GFX file's tile sheet, and a painter for it.
 *
 * The bit-depth and palette-row controls change what is DECODED server-side
 * and re-fetch, rather than re-decoding in the browser, so the pure
 * ROM-decode logic stays out of the frontend bundle (project-protocol.ts
 * states the same rule for its DTOs).
 *
 * The controls stay on screen even when the fetch fails: gfxSheet refuses a
 * file GfxLoader cannot place at any depth on its own (a relocated GFX
 * arrangement), and forcing an explicit depth is the only way to look at one
 * anyway, so hiding the picker behind the error would make that unreachable.
 *
 * Painting is optimistic locally and authoritative on release: the stroke
 * lands on the canvas immediately, and the sheet is re-fetched when the
 * pointer comes up, so a refusal corrects the view rather than leaving a
 * pixel the cartridge never took. A painted pixel does NOT reach the
 * cartridge bytes until Save, which the toolbar says out loud, because an
 * emulator preview keeps showing the unedited graphics until then.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { Emitter } from '@theia/core/lib/common'
import {
  GfxBpp,
  GfxColorDto,
  GfxSaveDto,
  GfxService,
  GfxSheetDto,
  PALETTE_ROW_COUNT,
} from '../common/gfx-protocol'
import { GfxFrontendClient } from './gfx-push-client'

export const GFX_VIEW_ID = 'hackbench.gfx-view'

export interface GfxViewOptions {
  manifestPath: string
  index: number
  label: string
}

const BPP_OPTIONS: GfxBpp[] = [2, 3, 4]

/** 16 tiles per sheet row, matching the server's own layout. */
export const TILES_PER_ROW = 16

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

/** Which tile and which pixel inside it a sheet coordinate names. */
export function pixelAddress(px: number, py: number): { tile: number; x: number; y: number } {
  return { tile: (py >> 3) * TILES_PER_ROW + (px >> 3), x: px & 7, y: py & 7 }
}

function cssColor(c: GfxColorDto): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`
}

function saveMessage(save: GfxSaveDto): string {
  if (save.status === 'ok') {
    return save.bytesChanged === 0
      ? 'Saved. Nothing changed on the cartridge.'
      : `Saved. ${save.bytesChanged} cartridge bytes changed.`
  }
  if (save.status === 'overflow') {
    return `Cannot save: the repack is ${save.overage} bytes too big. ${save.reason}`
  }
  return `Cannot save: ${save.reason}`
}

@injectable()
export class GfxViewWidget extends ReactWidget {
  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(GfxFrontendClient) protected readonly pushClient!: GfxFrontendClient

  protected options: GfxViewOptions | undefined
  protected sheet: GfxSheetDto | undefined
  protected error: string | undefined
  /** User overrides; undefined defers to whatever the loader itself reports. */
  protected bppChoice: GfxBpp | undefined
  protected paletteRowChoice: number | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  /** Bumped on every reload; a response is applied only if it is still current,
   * so two rapid control changes cannot have the slower one overwrite the newer. */
  protected reloadToken = 0

  /** Which palette index the brush paints. 0 is the eraser: the sheet paints
   *  index 0 fully transparent, so "erase" and "paint 0" are one tool. */
  protected brush = 1
  protected dirty = false
  protected lastSave: GfxSaveDto | undefined
  protected refusal: string | undefined
  protected painting = false
  /** The last pixel sent, so a drag across one pixel is one request. */
  protected lastPainted = ''

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
    this.brush = 1
    this.lastSave = undefined
    this.refusal = undefined
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
    if (sheet && this.brush >= 1 << sheet.bpp) this.brush = 0
    await this.refreshEditState(token)
    this.update()
  }

  protected async refreshEditState(token: number): Promise<void> {
    if (!this.options) return
    try {
      const state = await this.gfx.gfxEditState(this.options.manifestPath)
      if (token !== this.reloadToken) return
      this.dirty = state.dirtyFiles.length > 0
      if (state.lastSave && !this.lastSave) this.lastSave = state.lastSave
    } catch {
      // The indicator is an aid, not a verdict: the save button reports the
      // real outcome, and a failed status fetch must not hide the sheet.
    }
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
    this.bppChoice = Number(e.target.value) as GfxBpp
    void this.reload()
  }

  protected handlePaletteRowChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.paletteRowChoice = Number(e.target.value)
    void this.reload()
  }

  /** Public so a test can pick a colour without synthesising a click. */
  selectBrush(index: number): void {
    this.brush = index
    this.update()
  }

  /** The sheet pixel under a client coordinate, or null when off-canvas. */
  protected sheetPixelAt(clientX: number, clientY: number): { px: number; py: number } | null {
    if (!this.canvasEl || !this.sheet) return null
    const rect = this.canvasEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const px = Math.floor(((clientX - rect.left) / rect.width) * this.sheet.width)
    const py = Math.floor(((clientY - rect.top) / rect.height) * this.sheet.height)
    if (px < 0 || py < 0 || px >= this.sheet.width || py >= this.sheet.height) return null
    return { px, py }
  }

  /**
   * Paint one sheet pixel.
   *
   * Public and coordinate-based so a test can assert the BEHAVIOUR (this
   * pixel became this colour) without depending on how a pointer event maps
   * to a canvas.
   */
  async paintAt(px: number, py: number): Promise<void> {
    if (!this.options || !this.sheet) return
    const key = `${px},${py}`
    if (key === this.lastPainted) return
    this.lastPainted = key

    this.drawLocally(px, py)
    const { tile, x, y } = pixelAddress(px, py)
    const r = await this.gfx.setGfxPixel(this.options.manifestPath, {
      file: this.options.index,
      tile,
      x,
      y,
      value: this.brush,
    })
    this.refusal = r.status === 'refused' ? r.reason : undefined
    if (r.status === 'ok') this.dirty = true
    this.update()
  }

  /** Immediate feedback, corrected by the reload on pointer up. */
  protected drawLocally(px: number, py: number): void {
    const ctx = this.canvasEl?.getContext('2d')
    const color = this.sheet?.paletteColors[this.brush]
    if (!ctx || !color) return
    ctx.clearRect(px, py, 1, 1)
    if (color.a === 0) return
    ctx.fillStyle = cssColor(color)
    ctx.fillRect(px, py, 1, 1)
  }

  protected handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const at = this.sheetPixelAt(e.clientX, e.clientY)
    if (!at) return
    this.painting = true
    this.lastPainted = ''
    e.currentTarget.setPointerCapture(e.pointerId)
    void this.paintAt(at.px, at.py)
  }

  protected handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!this.painting) return
    const at = this.sheetPixelAt(e.clientX, e.clientY)
    if (at) void this.paintAt(at.px, at.py)
  }

  protected handlePointerUp = (): void => {
    if (!this.painting) return
    this.painting = false
    this.lastPainted = ''
    void this.reload()
  }

  /** Public so the orchestrator's UI tests can drive a save directly. */
  async save(): Promise<GfxSaveDto | undefined> {
    if (!this.options) return undefined
    this.lastSave = await this.gfx.saveGfx(this.options.manifestPath)
    await this.reload()
    return this.lastSave
  }

  protected handleSave = (): void => {
    void this.save()
  }

  protected renderSwatches(sheet: GfxSheetDto): React.ReactNode {
    // 4, 8 or 16 entries for 2, 3 or 4bpp. A fixed 16 would offer colours
    // the sheet cannot express.
    const count = 1 << sheet.bpp
    return (
      <div className="hb-gfx-swatches" id="hb-gfx-swatches" data-count={count}>
        {sheet.paletteColors.slice(0, count).map((c, i) => (
          <button
            key={i}
            id={`hb-gfx-swatch-${i}`}
            className={`hb-gfx-swatch${i === this.brush ? ' hb-gfx-swatch-active' : ''}${
              i === 0 ? ' hb-gfx-swatch-eraser' : ''
            }`}
            title={i === 0 ? 'Index 0 (transparent, and the eraser)' : `Index ${i}`}
            aria-pressed={i === this.brush}
            style={{ background: i === 0 ? undefined : cssColor(c) }}
            onClick={() => this.selectBrush(i)}
          />
        ))}
      </div>
    )
  }

  protected render(): React.ReactNode {
    if (!this.options) {
      return <div className="hb-gfx-view-empty">Reading the cartridge...</div>
    }

    const s = this.sheet
    // While a sheet is loaded the controls reflect what actually produced
    // it; before the first one arrives (or after a refusal) they reflect
    // only the user's own pending choice, defaulting to the lowest option.
    const bppValue = this.bppChoice ?? s?.bpp ?? BPP_OPTIONS[0]
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
              {BPP_OPTIONS.map(b => (
                <option key={b} value={b}>{`${b}bpp`}</option>
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
          <button
            id="hb-gfx-save"
            className="theia-button"
            disabled={!this.dirty}
            onClick={this.handleSave}
          >
            Save to cartridge
          </button>
          <span id="hb-gfx-dirty" className="hb-gfx-view-dirty" data-dirty={this.dirty}>
            {this.dirty
              ? 'Unsaved edits. They reach the cartridge only when you save.'
              : 'No unsaved edits.'}
          </span>
        </div>
        {s && this.renderSwatches(s)}
        {/* The palette row is a preview lens, not a property of the file: a
            GFX file is not bound to a level, and the real CGRAM row comes
            from the Map16 or OAM attribute wherever the tile is used. */}
        <div className="hb-gfx-view-lens">
          Palette row is a preview lens. A GFX file is not bound to a level.
        </div>
        {this.error && <div className="hb-gfx-view-error">{this.error}</div>}
        {this.refusal && (
          <div id="hb-gfx-refusal" className="hb-gfx-view-error">
            {this.refusal}
          </div>
        )}
        {this.lastSave && (
          <div
            id="hb-gfx-save-message"
            className={this.lastSave.status === 'ok' ? 'hb-gfx-view-notice' : 'hb-gfx-view-error'}
            data-status={this.lastSave.status}
            data-overage={this.lastSave.status === 'overflow' ? this.lastSave.overage : undefined}
          >
            {saveMessage(this.lastSave)}
          </div>
        )}
        {s && s.height > 0 && (
          <div className="hb-gfx-view-canvas-wrap">
            <canvas
              id="hb-gfx-canvas"
              className="hb-gfx-view-canvas"
              onPointerDown={this.handlePointerDown}
              onPointerMove={this.handlePointerMove}
              onPointerUp={this.handlePointerUp}
              onPointerLeave={this.handlePointerUp}
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
