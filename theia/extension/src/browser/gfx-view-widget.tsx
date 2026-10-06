/**
 * One GFX file's tile sheet, opened from the Graphics explorer, and a pixel
 * painter over it.
 *
 * Strokes live HERE, in the widget, until Save: pointer down to up is one
 * stroke, and stroke undo/redo walk that list. Nothing reaches the project
 * before Save. Save flattens the strokes to the final value per pixel per 8x8
 * character and sends ONE gfx op layer (GfxService.saveGfx), so after Save the
 * project's own undo (#448) owns it; Save never writes the base ROM. Closing
 * with unsaved strokes asks, through Theia's Saveable idiom (`saveable`).
 *
 * The bit-depth and palette-row controls change what is DECODED
 * server-side and re-fetch, rather than re-decoding in the browser, so the
 * pure ROM-decode logic stays out of the frontend bundle (project-protocol.ts
 * states the same rule for its DTOs). Painting is offered only at the
 * file's own depth: a forced depth shows the bytes as another layout, and a
 * pixel painted there would not be the pixel the ROM holds.
 *
 * The controls stay on screen even when the fetch fails: gfxSheet refuses a
 * file GfxLoader cannot place at any depth on its own (a relocated GFX
 * arrangement), and forcing an explicit depth is the only way to look at one
 * anyway, so hiding the picker behind the error would make that unreachable.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import {
  ReactWidget,
  Message,
  Saveable,
  SaveableSource,
  ShouldSaveDialog,
} from '@theia/core/lib/browser'
import { Emitter } from '@theia/core'
import { ThemeService } from '@theia/core/lib/browser/theming'
import {
  GFX_FORMATS,
  GfxFormat,
  GfxService,
  GfxCharEditDto,
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
/** Characters per sheet row: GFX_TILES_PER_ROW in node/gfx-decode.ts. */
const TILES_PER_ROW = 16

/** One pointer-down to pointer-up: sheet pixel (y * width + x) to the palette index painted. */
type Stroke = Map<number, number>

/** The slice of the widget the Edit > Undo/Redo contribution defers to. */
export interface StrokeHistory {
  canUndoStroke(): boolean
  canRedoStroke(): boolean
  undoStroke(): void
  redoStroke(): void
}

export function isStrokeHistory(w: unknown): w is StrokeHistory {
  return w instanceof GfxViewWidget
}

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
export class GfxViewWidget extends ReactWidget implements SaveableSource, StrokeHistory {
  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(GfxFrontendClient) protected readonly pushClient!: GfxFrontendClient
  @inject(ThemeService) protected readonly themes!: ThemeService

  protected options: GfxViewOptions | undefined
  protected sheet: GfxSheetDto | undefined
  protected error: string | undefined
  /** User overrides; undefined defers to whatever the loader itself reports. */
  protected bppChoice: GfxFormat | undefined
  protected paletteRowChoice: number | undefined
  /** The depth the file decodes at with no override: what painting is offered at. */
  protected ownBpp: GfxFormat | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  protected wheelBinding: WheelBinding | undefined
  /** Bumped on every reload; a response is applied only if it is still current,
   * so two rapid control changes cannot have the slower one overwrite the newer. */
  protected reloadToken = 0

  /** Strokes since the last Save; Save flattens them into one layer. */
  protected strokes: Stroke[] = []
  protected redoStrokes: Stroke[] = []
  /** The stroke the pointer is drawing right now. */
  protected drawing: Stroke | undefined
  protected lastPoint: { x: number; y: number } | undefined
  protected colorIndex = 1
  /** The sheet's pixels as the ROM has them, with the strokes laid over `image`. */
  protected baseRgba: Uint8ClampedArray | undefined
  protected image: ImageData | undefined
  protected saving = false
  protected saveMessage: { status: string; text: string; overage?: number } | undefined

  protected readonly dirtyEmitter = new Emitter<void>()
  protected readonly contentEmitter = new Emitter<void>()
  /** Theia's Saveable contract: dirty marks the tab and prompts on close. Not
   *  autosaved, because Save records an undo step. */
  readonly saveable: Saveable & { dirty: boolean } = {
    dirty: false,
    autosaveable: false,
    onDirtyChanged: this.dirtyEmitter.event,
    onContentChanged: this.contentEmitter.event,
    save: async () => {
      await this.save()
    },
    revert: async () => this.discardStrokes(),
  }

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
    this.toDispose.push(this.dirtyEmitter)
    this.toDispose.push(this.contentEmitter)
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
    const same =
      options.manifestPath === this.options?.manifestPath && options.index === this.options?.index
    // The preview tab is one widget reused for every single click: moving it
    // to another file would drop the strokes without a word.
    if (!same && this.dirty && !(await this.resolveUnsaved())) return
    if (!same) this.discardStrokes()
    this.options = options
    this.id = `${GFX_VIEW_ID}:${options.index}`
    this.title.label = options.label
    this.title.caption = options.label
    this.title.iconClass = 'codicon codicon-file-media'

    this.sheet = undefined
    this.error = undefined
    this.saveMessage = undefined
    if (!same) {
      this.bppChoice = undefined
      this.ownBpp = undefined
      this.paletteRowChoice = undefined
    }
    this.update()

    await this.reload()
  }

  get dirty(): boolean {
    return this.strokes.length > 0
  }

  /** Save, Don't Save or Cancel, Theia's own close dialog; true to go on. */
  protected async resolveUnsaved(): Promise<boolean> {
    const choice = await new ShouldSaveDialog(this).open()
    if (choice === undefined) return false
    if (choice && !(await this.save())) return false
    return true
  }

  protected setStrokes(strokes: Stroke[], redo: Stroke[]): void {
    const was = this.dirty
    this.strokes = strokes
    this.redoStrokes = redo
    this.saveable.dirty = this.dirty
    if (was !== this.dirty) this.dirtyEmitter.fire()
    this.contentEmitter.fire()
  }

  /** Drops every unsaved stroke, and shows the ROM's own pixels again. */
  protected discardStrokes(): void {
    this.drawing = undefined
    this.restroke([], [])
  }

  /** Swap in a stroke list and repaint the canvas from the ROM's pixels. */
  protected restroke(strokes: Stroke[], redo: Stroke[]): void {
    this.setStrokes(strokes, redo)
    this.rebuildImage()
    this.update()
  }

  // Not while a Save is in flight: its success clears every stroke, so one
  // drawn or undone meanwhile would be lost or come back.
  canUndoStroke(): boolean {
    return this.strokes.length > 0 && !this.saving
  }

  canRedoStroke(): boolean {
    return this.redoStrokes.length > 0 && !this.saving
  }

  undoStroke(): void {
    const last = this.strokes[this.strokes.length - 1]
    if (!last || this.saving) return
    this.restroke(this.strokes.slice(0, -1), [...this.redoStrokes, last])
  }

  redoStroke(): void {
    const next = this.redoStrokes[this.redoStrokes.length - 1]
    if (!next || this.saving) return
    this.restroke([...this.strokes, next], this.redoStrokes.slice(0, -1))
  }

  /**
   * One Save: the strokes flattened to the final value per pixel per
   * character, sent as ONE layer. False when nothing was recorded.
   */
  async save(): Promise<boolean> {
    if (!this.options || !this.sheet || this.strokes.length === 0 || this.saving) return false
    const { manifestPath, index } = this.options
    const width = this.sheet.width
    const final = new Map<number, number>()
    for (const stroke of this.strokes) for (const [k, v] of stroke) final.set(k, v)
    const byTile = new Map<number, GfxCharEditDto>()
    for (const [k, value] of final) {
      const x = k % width
      const y = Math.floor(k / width)
      const tile = (y >> 3) * TILES_PER_ROW + (x >> 3)
      let char = byTile.get(tile)
      if (!char) byTile.set(tile, (char = { file: index, tile, pixels: [] }))
      char.pixels.push({ x: x & 7, y: y & 7, value })
    }
    this.saving = true
    this.update()
    try {
      const r = await this.gfx.saveGfx(manifestPath, [...byTile.values()])
      if (r.status === 'ok') {
        this.setStrokes([], [])
        this.saveMessage = {
          status: 'ok',
          text: `Saved as one undoable layer (${r.bytesChanged} ROM bytes re-encoded). The base ROM is not changed.`,
        }
        await this.reload()
        return true
      }
      const overage = r.status === 'refused' ? r.overage : undefined
      this.saveMessage = {
        status: r.status,
        text:
          overage !== undefined
            ? `Not saved: ${overage} bytes too big for the GFX arena. Your strokes are kept.`
            : `Not saved: ${r.reason}`,
        overage,
      }
      return false
    } catch (err) {
      this.saveMessage = { status: 'unavailable', text: `Not saved: ${(err as Error).message}` }
      return false
    } finally {
      this.saving = false
      this.update()
    }
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
    if (sheet && this.bppChoice === undefined) this.ownBpp = sheet.bpp
    this.baseRgba = sheet ? decodeRgba(sheet.rgbaBase64) : undefined
    this.rebuildImage()
    this.update()
  }

  /** The ROM's pixels with every unsaved stroke laid over them, in order. */
  protected rebuildImage(): void {
    const s = this.sheet
    if (!s || !this.baseRgba) {
      this.image = undefined
      return
    }
    this.image = new ImageData(new Uint8ClampedArray(this.baseRgba), s.width, s.height)
    // Strokes are pixel positions in the file's own layout; over another depth's
    // sheet they would land on different pixels, or past its end.
    if (!this.canPaint) return
    for (const stroke of [...this.strokes, ...(this.drawing ? [this.drawing] : [])]) {
      for (const [k, v] of stroke) this.colorPixel(k, v)
    }
  }

  protected colorPixel(key: number, value: number): void {
    const c = this.sheet?.paletteColors[value]
    if (!c || !this.image || key * 4 >= this.image.data.length) return
    this.image.data.set([c.r, c.g, c.b, c.a], key * 4)
  }

  /** Painting is offered at the file's own depth only, and never for Mode 7. */
  protected get canPaint(): boolean {
    return !!this.sheet && this.sheet.bpp !== 'mode7' && this.bppChoice === undefined
  }

  /** Paints sheet pixel (x, y) into the stroke being drawn. */
  protected paintPixel(x: number, y: number): void {
    const s = this.sheet
    if (!s || !this.drawing || !this.image) return
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) return
    if ((y >> 3) * TILES_PER_ROW + (x >> 3) >= s.tileCount) return // past the file's last character
    const key = y * s.width + x
    if (this.drawing.get(key) === this.colorIndex) return
    this.drawing.set(key, this.colorIndex)
    this.colorPixel(key, this.colorIndex)
    this.canvasEl?.getContext('2d')?.putImageData(this.image, 0, 0, x, y, 1, 1)
  }

  protected pointerPixel(e: React.PointerEvent): { x: number; y: number } | undefined {
    const s = this.sheet
    const r = this.canvasEl?.getBoundingClientRect()
    if (!s || !r || r.width === 0) return undefined
    return {
      x: Math.floor(((e.clientX - r.left) / r.width) * s.width),
      y: Math.floor(((e.clientY - r.top) / r.height) * s.height),
    }
  }

  /** Every pixel from the last point to this one, so a fast drag leaves no gaps. */
  protected paintLine(to: { x: number; y: number }): void {
    const from = this.lastPoint ?? to
    const n = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 0 : i / n
      this.paintPixel(
        Math.round(from.x + (to.x - from.x) * t),
        Math.round(from.y + (to.y - from.y) * t),
      )
    }
    this.lastPoint = to
  }

  protected handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const at = this.pointerPixel(e)
    if (e.button !== 0 || !at || !this.canPaint || this.saving) return
    if (this.colorIndex >= 1 << (this.sheet!.bpp as number)) this.colorIndex = 1 // a shallower file
    e.currentTarget.setPointerCapture?.(e.pointerId)
    this.drawing = new Map()
    this.lastPoint = undefined
    this.paintLine(at)
  }

  protected handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const at = this.pointerPixel(e)
    if (this.drawing && at) this.paintLine(at)
  }

  protected handlePointerUp = (): void => {
    const stroke = this.drawing
    this.drawing = undefined
    this.lastPoint = undefined
    if (!stroke || stroke.size === 0) return
    this.saveMessage = undefined
    this.setStrokes([...this.strokes, stroke], [])
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
    const { width, height } = this.sheet
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
    if (this.image) ctx.putImageData(this.image, 0, 0)
    perfEnd('open-gfx')
  }

  toggleGrid(): void {
    gridShown = !gridShown
    gridChanged.fire()
  }

  protected handleBppChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const chosen = GFX_FORMATS.find(f => String(f) === e.target.value)
    // The file's own depth is no override: it is the one painting is offered at.
    this.bppChoice = chosen === this.ownBpp ? undefined : chosen
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
          {this.canPaint && s && (
            <span
              id="hb-gfx-swatches"
              className="hb-gfx-swatches"
              role="group"
              aria-label="Paint color"
            >
              {s.paletteColors.slice(0, 1 << (s.bpp as number)).map((c, i) => (
                <button
                  key={i}
                  id={`hb-gfx-swatch-${i}`}
                  type="button"
                  className="hb-gfx-swatch"
                  aria-pressed={i === this.colorIndex}
                  title={i === 0 ? 'Color 0 (erases)' : `Color ${i}`}
                  style={{ background: i === 0 ? undefined : `rgb(${c.r},${c.g},${c.b})` }}
                  onClick={() => {
                    this.colorIndex = i
                    this.update()
                  }}
                />
              ))}
            </span>
          )}
          <button
            id="hb-gfx-stroke-undo"
            type="button"
            className="hb-icon-btn"
            title="Undo stroke"
            aria-label="Undo stroke"
            disabled={!this.canUndoStroke()}
            onClick={() => this.undoStroke()}
          >
            <span className="codicon codicon-discard" />
          </button>
          <button
            id="hb-gfx-stroke-redo"
            type="button"
            className="hb-icon-btn"
            title="Redo stroke"
            aria-label="Redo stroke"
            disabled={!this.canRedoStroke()}
            onClick={() => this.redoStroke()}
          >
            <span className="codicon codicon-redo" />
          </button>
          <button
            id="hb-gfx-save"
            type="button"
            className="theia-button"
            disabled={!this.dirty || this.saving}
            title="Record the strokes as one op layer. The base ROM is never written."
            onClick={() => void this.save()}
          >
            Save
          </button>
          <span className="hb-toolbar-spacer" />
          <button
            data-control="grid-toggle"
            type="button"
            className={'hb-icon-btn' + (gridShown ? ' hb-icon-btn-on' : ' hb-icon-btn-off')}
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
        <div id="hb-gfx-dirty" className="hb-gfx-view-notice" data-dirty={this.dirty}>
          {this.dirty &&
            'Unsaved strokes. Save records them as one op layer; the base ROM is never written.'}
        </div>
        {this.saveMessage && (
          <div
            id="hb-gfx-save-message"
            className="hb-gfx-view-notice"
            data-status={this.saveMessage.status}
            data-overage={this.saveMessage.overage}
          >
            {this.saveMessage.text}
          </div>
        )}
        {s && s.height > 0 && (
          <div className="hb-gfx-view-canvas-wrap hb-grid-host">
            <canvas
              id="hb-gfx-canvas"
              className={
                'hb-gfx-view-canvas hb-pixel-canvas' + (this.canPaint ? ' hb-gfx-paintable' : '')
              }
              ref={this.bindCanvas}
              onPointerDown={this.handlePointerDown}
              onPointerMove={this.handlePointerMove}
              onPointerUp={this.handlePointerUp}
              onPointerCancel={this.handlePointerUp}
            />
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
