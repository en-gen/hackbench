/**
 * The Map16 view: ONE layer's tile table, previewed large, edited on
 * request.
 *
 * One widget per layer, keyed `{ layer }` through WidgetManager, so
 * Foreground and Background tab, split, zoom and select independently from
 * the shell. The toolbar has no table selector: the tab IS the table, and a
 * selector alongside it is one more thing to get out of step with the tab.
 *
 * No control here carries a DOM `id`, and that is deliberate rather than an
 * omission. Any id would have to be unique across every widget of this view
 * that is attached at once, and the number of those is not something this
 * file can know: a double click opens a preview widget and a pinned one of
 * the SAME layer, so even a layer-suffixed id collides (measured on
 * ccb66b4). Deriving one from `this.id` does not help either, because
 * PreviewTabs rewrites `widget.id` after `open()` has already rendered.
 * Controls are addressed by `data-control` within a widget root instead,
 * which is unique by construction however many widgets exist.
 *
 * Four surfaces, each owning its own markup and painting: the tile PREVIEW
 * and the EDIT PANE (`map16-tile-editor.tsx`), the character palettes
 * (`map16-char-palettes.tsx`) and the tile browser strip below, which is
 * the only one still drawn here because it is the widget's own selection
 * control.
 *
 * `pendingEdits` (below) exists to fix a real bug, not a test artifact:
 * every field control here is CONTROLLED by the server-committed value. A
 * click mutates the control immediately, then fires its handler; if the
 * displayed value still comes from the last-committed sheet at that instant
 * (it does - `editField`'s round trip has not resolved yet), React's next
 * render reverts the control until the response arrives, then jumps to the
 * new value. That is a visible flicker, and a genuine repeated DOM mutation
 * right where the interaction lands, which is what made Playwright's
 * actionability wait time out. `pendingEdits` makes each field's displayed
 * value optimistic - set synchronously on the click, cleared once the
 * response confirms it - so the control changes state exactly once.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import {
  BG_VARIANT_COLOR_ROWS,
  FG_VARIANT_COLOR_ROWS,
  LoadMap16Result,
  Map16CharSheetDto,
  Map16CharSlot,
  Map16Field,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16QuadrantKey,
  Map16Service,
  Map16SheetDto,
  Map16SwitchKind,
  Map16TileDto,
  MAP16_PALETTE_VARIANT_COUNT,
  MAP16_TILESET_COUNT,
  SetMap16Result,
} from '../common/map16-protocol'
import { Map16FrontendClient } from './map16-push-client'
import {
  CHAR_PX,
  QUADRANT_ORIGIN,
  TILE_PX,
  cropRegion,
  decodeRgba,
  paintSpotlight,
} from './map16-pixels'
import { paintCharSheet, renderCharPalettes } from './map16-char-palettes'
import {
  QUADRANTS,
  SWITCH_BUTTON_PX,
  paintFrameQuadrant,
  paintTilePreview,
  renderTileEditor,
  renderTilePreview,
} from './map16-tile-editor'
import {
  BrowsedSheetCache,
  editAxisFor,
  map16WidgetId,
  previewAlternate,
  screenDoor,
  rowColorsFor,
  tileFrameCount,
  toggleKinds,
} from './map16-view-model'
import type { FrameImage } from './pixel-image-button'

export { MAP16_VIEW_ID, map16WidgetId } from './map16-view-model'

export interface Map16ViewOptions {
  manifestPath: string
  label: string
  /** Which table this widget shows. Fixed for the widget's life: a second
   * layer is a second widget, not a mode switch. */
  layer: Map16Layer
}

const ZOOM_OPTIONS = [1, 2, 3, 4]
const DEFAULT_ZOOM = 2

/** Tiles per page. Two pages of 16x16 is how the tile id's high byte reads. */
const TILES_PER_PAGE = 256
/** Blank rows drawn between pages, in natural pixels. */
const PAGE_GAP_PX = 6

/** Where a tile's top-left corner sits on the browser strip, gap included. */
function tileOrigin(tileId: number, tilesPerRow: number): { x: number; y: number } {
  const page = Math.floor(tileId / TILES_PER_PAGE)
  const within = tileId % TILES_PER_PAGE
  return {
    x: (within % tilesPerRow) * TILE_PX,
    y:
      Math.floor(within / tilesPerRow) * TILE_PX +
      page * (TILES_PER_PAGE / tilesPerRow) * TILE_PX +
      page * PAGE_GAP_PX,
  }
}

/** Inverse of tileOrigin: the tile at a canvas point, or undefined in the gap. */
function tileAtPoint(x: number, y: number, tilesPerRow: number, count: number): number | undefined {
  const pageHeight = (TILES_PER_PAGE / tilesPerRow) * TILE_PX
  const page = Math.floor(y / (pageHeight + PAGE_GAP_PX))
  const localY = y - page * (pageHeight + PAGE_GAP_PX)
  if (localY >= pageHeight) return undefined // the separator itself
  const col = Math.floor(x / TILE_PX)
  if (col < 0 || col >= tilesPerRow) return undefined
  const id = page * TILES_PER_PAGE + Math.floor(localY / TILE_PX) * tilesPerRow + col
  return id >= 0 && id < count ? id : undefined
}

interface Selection {
  tileId: number
  quadrant: Map16QuadrantKey
}

@injectable()
export class Map16ViewWidget extends ReactWidget {
  @inject(Map16Service) protected readonly map16!: Map16Service
  @inject(Map16FrontendClient) protected readonly pushClient!: Map16FrontendClient

  protected options: Map16ViewOptions | undefined
  protected result: LoadMap16Result | undefined
  protected error: string | undefined
  protected editError: string | undefined
  protected tileset = 0
  /**
   * BackgroundPalettes/ForegroundPalettes variant indices (0-7 each),
   * independent of a character's own 3-bit color-row field - see
   * map16-protocol.ts's `Map16PaletteVariantDto`.
   */
  protected bgPaletteVariant = 0
  protected fgPaletteVariant = 0
  protected selection: Selection | undefined
  /**
   * Which of the SELECTED tile's own switches (#574) are toggled ON, so the
   * preview shows their alternate art. Per-widget view state, never an edit
   * - see `handleCanvasClick`, which clears it on every new selection so a
   * toggle never leaks onto an unrelated tile.
   */
  protected activeSwitches = new Set<Map16SwitchKind>()
  /** Whether the edit pane is open. False on open: the view is for looking
   * at a tile until the user says otherwise. */
  protected editing = false
  /** Which palette sections are expanded. All four are always listed. */
  protected expandedSheets = new Set<Map16CharSlot>()
  protected canvasEl: HTMLCanvasElement | null = null
  protected zoom = DEFAULT_ZOOM
  protected browserOpen = true
  /**
   * One optimistic value per in-flight field edit, keyed by
   * `pendingKey(tileId, quadrant, field)` - see this class's own doc
   * comment. Cleared the moment that edit's response (success OR refusal)
   * arrives.
   */
  protected readonly pendingEdits = new Map<string, number | boolean>()
  /** Bumped on every reload; a stale response is dropped rather than
   * overwriting newer state. */
  protected reloadToken = 0

  /** Tile under the pointer on the browser strip. Drives the hover
   * spotlight only, never the edit selection. */
  protected hoverTileId: number | undefined

  protected showGrid = false
  protected playing = false
  /** Which native animation frame is showing. Its own field, not derived
   * from a shared tick - see Map16CharAnimationDto's doc comment on why a
   * second, independently-clocked source must never share this counter. */
  protected charAnimPhase = 0
  protected animTimerHandle: ReturnType<typeof setInterval> | undefined
  protected detailPaintQueued = false

  protected previewCanvasEl: HTMLCanvasElement | null = null
  /** Keyed `frame:quadrant` - one canvas per quadrant of every frame. */
  protected readonly frameQuadrantEls = new Map<string, HTMLCanvasElement | null>()
  protected readonly sheetCanvasEls = new Map<Map16CharSlot, HTMLCanvasElement | null>()
  /**
   * Decoded RGBA buffers, keyed by their SOURCE base64 string so
   * `charAnimation.phases[0]` (identical to `rgbaBase64`) decodes exactly
   * once and every surface shares it.
   */
  protected readonly decodedCache = new Map<string, Uint8ClampedArray>()
  /** The sheet pixels as browsed, hidden tiles drawn in; resets itself per sheet. */
  protected readonly browsedSheet = new BrowsedSheetCache()

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map16-view')
    this.title.closable = true
    this.node.tabIndex = 0

    this.toDispose.push(
      this.pushClient.onChanged(manifestPath => {
        if (manifestPath === this.options?.manifestPath) void this.refresh()
      }),
    )
    this.toDispose.push({ dispose: () => this.stopAnimation() })
  }

  protected layer(): Map16Layer {
    return this.options?.layer ?? 'fg'
  }

  protected handleGridToggle = (): void => {
    this.showGrid = !this.showGrid
    this.update()
  }

  protected handleBrowserToggle = (): void => {
    this.browserOpen = !this.browserOpen
    this.update()
  }

  protected handleEditToggle = (): void => {
    this.editing = !this.editing
    this.editError = undefined
    this.update()
  }

  protected toggleSheet = (slot: Map16CharSlot): void => {
    if (this.expandedSheets.has(slot)) this.expandedSheets.delete(slot)
    else this.expandedSheets.add(slot)
    this.update()
  }

  protected handlePlayToggle = (): void => {
    if (this.playing) this.stopAnimation()
    else this.startAnimation()
  }

  protected startAnimation(): void {
    if (this.playing) return
    const anim = this.sheet()?.charAnimation
    if (!anim) return // nothing to play - the button is disabled for this case too
    this.playing = true
    this.animTimerHandle = setInterval(() => this.advancePhase(), anim.intervalMs)
    this.update()
  }

  protected stopAnimation(): void {
    if (this.animTimerHandle !== undefined) {
      clearInterval(this.animTimerHandle)
      this.animTimerHandle = undefined
    }
    if (this.playing) {
      this.playing = false
      this.update()
    }
  }

  protected advancePhase(): void {
    const frameCount = this.sheet()?.charAnimation?.frameCount
    if (!frameCount) {
      this.stopAnimation() // the sheet changed under a running timer
      return
    }
    this.charAnimPhase = (this.charAnimPhase + 1) % frameCount
    this.update()
  }

  protected decoded(base64: string): Uint8ClampedArray {
    let buf = this.decodedCache.get(base64)
    if (!buf) {
      buf = decodeRgba(base64)
      this.decodedCache.set(base64, buf)
    }
    return buf
  }

  /** The switch toggle buttons' own pictures (owner addendum to #574),
   * decoded from Map16SheetDto.switchButtonArt through the same cache every
   * other surface uses - a fixed 16x16 frame per state, never a tile's
   * alternate art. */
  protected switchButtonImages(
    sheet: Map16SheetDto,
  ): Partial<Record<Map16SwitchKind, { off: FrameImage; on: FrameImage }>> {
    const out: Partial<Record<Map16SwitchKind, { off: FrameImage; on: FrameImage }>> = {}
    const art = sheet.switchButtonArt
    if (!art) return out
    for (const kind of Object.keys(art) as Map16SwitchKind[]) {
      const images = art[kind]!
      out[kind] = {
        off: { ...SWITCH_BUTTON_PX, rgba: this.decoded(images.offRgba) },
        on: { ...SWITCH_BUTTON_PX, rgba: this.decoded(images.onRgba) },
      }
    }
    return out
  }

  /** Which image is active for painting the TILES: the animation's current
   * phase while playing, otherwise the sheet's own still image. The palette
   * sections never read this - they stay at frame 0. */
  protected activeBase64(sheet: Map16SheetDto): string {
    return this.playing && sheet.charAnimation
      ? sheet.charAnimation.phases[this.charAnimPhase]!
      : sheet.rgbaBase64
  }

  async open(options: Map16ViewOptions): Promise<void> {
    this.options = options
    this.id = map16WidgetId(options.layer)
    this.title.label = options.label
    this.title.caption = options.label
    this.title.iconClass = 'codicon codicon-symbol-structure'

    this.result = undefined
    this.error = undefined
    this.editError = undefined
    this.selection = undefined
    this.activeSwitches.clear()
    this.editing = false
    this.expandedSheets.clear()
    this.pendingEdits.clear()
    this.update()

    await this.reload()
  }

  /** Which table this tab shows, so PreviewTabs can retire the preview of it. */
  shows(layer: Map16Layer): boolean {
    return this.options?.layer === layer
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg)
    this.paintCanvas()
    this.schedulePaintDetail()
  }

  protected paletteVariant(): Map16PaletteVariantDto {
    return { bg: this.bgPaletteVariant, fg: this.fgPaletteVariant }
  }

  /**
   * Whether any character in `sheet` cites a row in `rows` - the ONLY basis
   * for disabling a palette control. Never derived from the layer: a hack's
   * BG or FG table could cite rows a vanilla measurement never saw, and
   * `sheet.citedColorRows` (scanned server-side) is what stays correct.
   */
  protected citesRows(sheet: Map16SheetDto, rows: readonly number[]): boolean {
    return sheet.citedColorRows.some(r => rows.includes(r))
  }

  protected paletteControlTitle(sheet: Map16SheetDto, which: 'bg' | 'fg'): string | undefined {
    if (which === 'bg' && !this.citesRows(sheet, BG_VARIANT_COLOR_ROWS)) {
      return 'No character in this sheet uses a background palette'
    }
    if (which === 'fg' && !this.citesRows(sheet, FG_VARIANT_COLOR_ROWS)) {
      return 'No character in this sheet uses a foreground palette'
    }
    return undefined
  }

  protected tilesetControlTitle(): string {
    return this.layer() === 'fg'
      ? 'Selects the tile table and the graphics'
      : 'Selects the graphics only - the Layer 2 tile table is global'
  }

  protected setResult(result: LoadMap16Result | undefined): void {
    this.result = result
    this.decodedCache.clear()
    this.syncAnimationToSheet()
    this.syncSelectionToSheet()
    // A reload can change which switches the selected tile follows; drop any it no longer has.
    const kinds = toggleKinds(this.selectedTile()?.alternates)
    for (const k of [...this.activeSwitches]) if (!kinds.includes(k)) this.activeSwitches.delete(k)
  }

  protected syncAnimationToSheet(): void {
    const anim = this.sheet()?.charAnimation
    if (!anim) {
      this.stopAnimation()
      this.charAnimPhase = 0
      return
    }
    if (this.charAnimPhase >= anim.frameCount) this.charAnimPhase = 0
  }

  /**
   * Keeps the selection and the expanded palette sections inside what the
   * loaded sheet actually has. The preview is the dominant surface, so it
   * opens on a real tile rather than on an empty panel; a tileset switch
   * that moves neither leaves both exactly where the user put them.
   */
  protected syncSelectionToSheet(): void {
    const sheet = this.sheet()
    if (!sheet) return
    if (!this.selection || this.selection.tileId >= sheet.tiles.length) {
      this.selection = { tileId: 0, quadrant: this.selection?.quadrant ?? 'tl' }
    }
    const slots = sheet.charSheets.map(s => s.slot)
    for (const open of [...this.expandedSheets]) {
      if (!slots.includes(open)) this.expandedSheets.delete(open)
    }
    if (this.expandedSheets.size === 0 && slots[0]) this.expandedSheets.add(slots[0])
  }

  protected async reload(): Promise<void> {
    if (!this.options) return
    const token = ++this.reloadToken
    let result: LoadMap16Result | undefined
    let error: string | undefined
    try {
      result = await this.map16.loadMap16(
        this.options.manifestPath,
        this.tileset,
        this.layer(),
        this.paletteVariant(),
      )
    } catch (err) {
      error = (err as Error).message
    }
    if (token !== this.reloadToken) return
    this.setResult(result)
    this.error = error
    this.update()
  }

  /** Re-fetches with the SAME axis choices without touching `selection` -
   * the re-render a working-copy change elsewhere pushes. */
  protected async refresh(): Promise<void> {
    if (!this.options) return
    const token = ++this.reloadToken
    try {
      const result = await this.map16.loadMap16(
        this.options.manifestPath,
        this.tileset,
        this.layer(),
        this.paletteVariant(),
      )
      if (token !== this.reloadToken) return
      this.setResult(result)
      this.error = undefined
    } catch (err) {
      if (token !== this.reloadToken) return
      this.error = (err as Error).message
    }
    this.update()
  }

  // Every handler below touches ONLY its own field, then reloads - never
  // `this.selection`, `expandedSheets` or `pendingEdits`, and never each
  // other's.

  protected handleTilesetChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.tileset = Number(e.target.value)
    void this.reload()
  }

  protected handleBgVariantChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.bgPaletteVariant = Number(e.target.value)
    void this.reload()
  }

  protected handleFgVariantChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.fgPaletteVariant = Number(e.target.value)
    void this.reload()
  }

  protected stepZoom(delta: number): void {
    const i = ZOOM_OPTIONS.indexOf(this.zoom)
    const next = ZOOM_OPTIONS[Math.min(ZOOM_OPTIONS.length - 1, Math.max(0, i + delta))]
    if (next === undefined || next === this.zoom) return
    this.zoom = next
    this.update()
  }

  protected handleZoomIn = (): void => this.stepZoom(1)
  protected handleZoomOut = (): void => this.stepZoom(-1)

  protected sheet(): Map16SheetDto | undefined {
    return this.result?.status === 'ok' ? this.result.sheet : undefined
  }

  protected selectedTile(): Map16TileDto | undefined {
    const sel = this.selection
    const sheet = this.sheet()
    if (!sel || !sheet) return undefined
    return sheet.tiles[sel.tileId]
  }

  protected handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const tileId = this.tileIdAt(e)
    if (tileId === undefined) return
    // Keep whichever quadrant was already being edited, so walking the
    // browser strip compares the same corner tile after tile.
    this.selection = { tileId, quadrant: this.selection?.quadrant ?? 'tl' }
    this.editError = undefined
    // A toggle is a fact about the PREVIOUS tile's own switches; carrying it
    // onto a new selection could turn on a switch that tile does not have.
    this.activeSwitches.clear()
    this.update()
  }

  protected toggleSwitch = (kind: Map16SwitchKind): void => {
    if (this.activeSwitches.has(kind)) this.activeSwitches.delete(kind)
    else this.activeSwitches.add(kind)
    this.update()
  }

  protected tileIdAt(e: React.MouseEvent<HTMLCanvasElement>): number | undefined {
    const sheet = this.sheet()
    if (!sheet) return undefined
    return tileAtPoint(
      e.nativeEvent.offsetX / this.zoom,
      e.nativeEvent.offsetY / this.zoom,
      sheet.tilesPerRow,
      sheet.tiles.length,
    )
  }

  protected handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const id = this.tileIdAt(e)
    if (id === this.hoverTileId) return
    this.hoverTileId = id
    // Repaint directly rather than update(): hover changes no markup.
    this.paintCanvas()
  }

  protected handleCanvasMouseLeave = (): void => {
    if (this.hoverTileId === undefined) return
    this.hoverTileId = undefined
    this.paintCanvas()
  }

  protected selectQuadrant = (quadrant: Map16QuadrantKey): void => {
    if (!this.selection) return
    this.selection = { ...this.selection, quadrant }
    this.editError = undefined
    this.update()
  }

  /**
   * Picking a character out of a palette section.
   *
   * Sets the character and NOTHING else: the color row, the flips and the
   * priority bit keep whatever the cartridge had, because
   * `setQuadrantField` moves exactly one field per call. The number can
   * only come from a rendered character in a loaded sheet, so there is no
   * out-of-range case to validate here - that is the point of the gesture.
   */
  protected pickChar = (charNum: number): void => {
    if (!this.selection) return
    this.editError = undefined
    void this.editField('charNum', charNum)
  }

  protected toggleField = (field: Map16Field, value: boolean): void => {
    void this.editField(field, value)
  }

  protected setColorRow = (row: number): void => {
    void this.editField('colorRow', row)
  }

  /** Folds a SetMap16Result into widget state: stale, refused and io-error
   * are edit refusals shown inline, never replacing the rest of the view. */
  protected applyResult(result: SetMap16Result): void {
    if (result.status === 'stale' || result.status === 'io-error' || result.status === 'refused') {
      this.editError = result.reason
    } else {
      this.setResult(result)
      this.editError = undefined
    }
    this.update()
  }

  protected pendingKey(tileId: number, quadrant: Map16QuadrantKey, field: Map16Field): string {
    return `${tileId}:${quadrant}:${field}`
  }

  /** `committed` unless an edit for this exact field is in flight. */
  protected displayValue = <T extends number | boolean>(
    quadrant: Map16QuadrantKey,
    field: Map16Field,
    committed: T,
  ): T => {
    const tileId = this.selection?.tileId
    if (tileId === undefined) return committed
    const pending = this.pendingEdits.get(this.pendingKey(tileId, quadrant, field))
    return pending === undefined ? committed : (pending as T)
  }

  protected async editField(field: Map16Field, value: number | boolean): Promise<void> {
    const sel = this.selection
    const manifestPath = this.options?.manifestPath
    const sheet = this.sheet()
    if (!sel || !manifestPath || !sheet) return
    const key = this.pendingKey(sel.tileId, sel.quadrant, field)
    // Optimistic: render the gesture's effect NOW, not once the round trip
    // resolves - see this class's doc comment on `pendingEdits`.
    this.pendingEdits.set(key, value)
    this.update()
    // An edit RETURNS a full sheet, so it is a load like any other and has
    // to honour reloadToken: without this, a response carrying the axis read
    // synchronously below could land after the user switched axis and
    // repaint with the OLD sheet while the selects read the new one.
    const token = ++this.reloadToken
    // The axis of the SHEET ON SCREEN, never the picker values - see
    // editAxisFor, which is where that decision is made and tested.
    const axis = editAxisFor(sheet, {
      tileset: this.tileset,
      layer: this.layer(),
      paletteVariant: this.paletteVariant(),
    })
    try {
      const result = await this.map16.setQuadrantField(
        manifestPath,
        axis.tileset,
        axis.layer,
        axis.paletteVariant,
        sel.tileId,
        sel.quadrant,
        field,
        value,
      )
      if (this.options?.manifestPath !== manifestPath) return // project switched mid-flight
      this.pendingEdits.delete(key)
      if (token !== this.reloadToken) {
        // Superseded: the write still happened and is on disk, but a newer
        // load owns the screen. Drop the sheet, keep any refusal visible.
        if (result.status !== 'ok') this.applyResult(result)
        else this.update()
        return
      }
      this.applyResult(result)
    } catch (err) {
      if (this.options?.manifestPath !== manifestPath) return
      this.pendingEdits.delete(key)
      this.editError = (err as Error).message
      this.update()
    }
  }

  /** The tile browser strip: every tile the cartridge holds, paged. */
  protected paintCanvas(): void {
    const sheet = this.sheet()
    if (!this.canvasEl || !sheet) return
    const pageHeight = (TILES_PER_PAGE / sheet.tilesPerRow) * TILE_PX
    const pages = Math.ceil(sheet.tiles.length / TILES_PER_PAGE)
    const gapTotal = (pages - 1) * PAGE_GAP_PX
    this.canvasEl.width = sheet.width
    this.canvasEl.height = sheet.height + gapTotal
    this.canvasEl.style.width = `${sheet.width * this.zoom}px`
    this.canvasEl.style.height = `${(sheet.height + gapTotal) * this.zoom}px`
    const ctx = this.canvasEl.getContext('2d')
    if (!ctx) return
    const pixels = this.browsedSheet.pixels(sheet, this.activeBase64(sheet), b => this.decoded(b))

    // Each page is blitted separately so a blank band sits between them.
    // An offscreen canvas holds the decoded sheet because putImageData
    // ignores clipping and cannot take a source rectangle.
    const off = document.createElement('canvas')
    off.width = sheet.width
    off.height = sheet.height
    off.getContext('2d')?.putImageData(new ImageData(pixels, sheet.width, sheet.height), 0, 0)
    for (let page = 0; page < pages; page++) {
      const srcY = page * pageHeight
      const sliceH = Math.min(pageHeight, sheet.height - srcY)
      ctx.drawImage(
        off,
        0,
        srcY,
        sheet.width,
        sliceH,
        0,
        srcY + page * PAGE_GAP_PX,
        sheet.width,
        sliceH,
      )
    }

    if (this.hoverTileId !== undefined) {
      const { x, y } = tileOrigin(this.hoverTileId, sheet.tilesPerRow)
      paintSpotlight(ctx, sheet.width, this.canvasEl.height, x, y, TILE_PX, TILE_PX)
    }

    const sel = this.selection
    if (sel) {
      const { x: selX, y: selY } = tileOrigin(sel.tileId, sheet.tilesPerRow)
      const accent =
        getComputedStyle(this.node).getPropertyValue('--theia-focusBorder').trim() || '#3399ff'
      ctx.lineWidth = 1
      ctx.strokeStyle = accent
      ctx.strokeRect(selX + 0.5, selY + 0.5, TILE_PX - 1, TILE_PX - 1)
    }

    // Overlay, never baked into the atlas: toggling it is a local repaint
    // and the bytes an export would use stay exactly what the cart says.
    if (this.showGrid) {
      const gridColor =
        getComputedStyle(this.node).getPropertyValue('--theia-editorWidget-border').trim() ||
        'rgba(128,128,128,0.6)'
      ctx.lineWidth = 1
      ctx.strokeStyle = gridColor
      for (let page = 0; page < pages; page++) {
        const top = page * (pageHeight + PAGE_GAP_PX)
        const bottom = top + pageHeight
        for (let x = 0; x <= sheet.width; x += TILE_PX) {
          ctx.beginPath()
          ctx.moveTo(x + 0.5, top)
          ctx.lineTo(x + 0.5, bottom)
          ctx.stroke()
        }
        for (let y = top; y <= bottom; y += TILE_PX) {
          ctx.beginPath()
          ctx.moveTo(0, y + 0.5)
          ctx.lineTo(sheet.width, y + 0.5)
          ctx.stroke()
        }
      }
    }
  }

  /**
   * Repaint the preview, frame and palette canvases once the DOM has them.
   *
   * React sets a `ref` during COMMIT, which happens AFTER
   * `onUpdateRequest` returns, so painting straight from there finds the
   * refs still null the first time a surface renders. The ref callbacks
   * call this too, so the paint happens whenever the canvases arrive.
   */
  protected schedulePaintDetail(): void {
    if (this.detailPaintQueued) return
    this.detailPaintQueued = true
    queueMicrotask(() => {
      this.detailPaintQueued = false
      this.paintDetail()
    })
  }

  /** The colors one palette section previews with: the SELECTED QUADRANT's
   * row, trimmed to the indices THAT sheet's characters can produce. */
  protected paletteColors(sheet: Map16SheetDto, charSheet: Map16CharSheetDto): string[] {
    const tile = this.selectedTile()
    const quadrant = this.selection?.quadrant
    const row =
      tile && quadrant
        ? this.displayValue(quadrant, 'colorRow', tile[quadrant].colorRow)
        : sheet.cgramRows[0]?.row
    return rowColorsFor(sheet, row).slice(0, charSheet.maxColorIndex + 1)
  }

  protected frameKey(frame: number, quadrant: Map16QuadrantKey): string {
    return `${frame}:${quadrant}`
  }

  /**
   * The preview canvas (#574): the alternate matching the active switch set
   * wins; else a hidden tile's first single alternate in the screen door, rather
   * than a blank preview; else the tile's own picture.
   */
  protected paintTilePreviewCanvas(
    tile: Map16TileDto,
    pixels: Uint8ClampedArray,
    atlasWidth: number,
    tileX: number,
    tileY: number,
  ): void {
    if (!this.previewCanvasEl) return
    const shown = previewAlternate(tile.alternates, this.activeSwitches)
    if (shown) {
      const art = this.decoded(shown.alt.altRgbaBase64)
      paintTilePreview(this.previewCanvasEl, shown.hidden ? screenDoor(art) : art)
    } else
      paintTilePreview(
        this.previewCanvasEl,
        cropRegion(pixels, atlasWidth, tileX, tileY, TILE_PX, TILE_PX),
      )
  }

  protected paintDetail(): void {
    const sheet = this.sheet()
    const tile = this.selectedTile()
    if (!sheet || !tile) return

    const pixels = this.decoded(this.activeBase64(sheet))
    const tileX = (tile.id % sheet.tilesPerRow) * TILE_PX
    const tileY = Math.floor(tile.id / sheet.tilesPerRow) * TILE_PX

    if (this.previewCanvasEl) this.paintTilePreviewCanvas(tile, pixels, sheet.width, tileX, tileY)
    if (!this.editing) return

    // One strip of frames: frame 0 of a still tile is whatever is on screen
    // now, and an animating tile's frames are its own phases, so the strip
    // never shows four identical thumbnails standing in for "we don't know".
    const frames = tileFrameCount(sheet, tile.id)
    for (let f = 0; f < frames; f++) {
      const source = frames > 1 ? this.decoded(sheet.charAnimation!.phases[f]!) : pixels
      for (const q of QUADRANTS) {
        const el = this.frameQuadrantEls.get(this.frameKey(f, q.key))
        if (!el) continue
        const origin = QUADRANT_ORIGIN[q.key]!
        paintFrameQuadrant(
          el,
          cropRegion(source, sheet.width, tileX + origin.x, tileY + origin.y, CHAR_PX, CHAR_PX),
        )
      }
    }

    for (const charSheet of sheet.charSheets) {
      const el = this.sheetCanvasEls.get(charSheet.slot)
      if (el) paintCharSheet(el, charSheet, this.paletteColors(sheet, charSheet))
    }
  }

  protected render(): React.ReactNode {
    if (!this.options) {
      return <div className="hb-map16-empty">Reading the ROM...</div>
    }
    if (this.error) {
      return <div className="hb-map16-error">{this.error}</div>
    }
    if (!this.result) {
      return <div className="hb-map16-empty">Reading the ROM...</div>
    }
    if (this.result.status === 'rom-not-located') {
      const title = this.result.baseRom.title || 'the base ROM'
      return <div className="hb-map16-empty">{`Locate ${title} to view its Map16 tiles`}</div>
    }
    if (this.result.status === 'unavailable') {
      // Say the limit in place rather than rendering a plausible substitute:
      // two pages of an expanded table would look exactly right and be wrong.
      return <div className="hb-map16-error hb-map16-unavailable">{this.result.reason}</div>
    }

    const sheet = this.result.sheet
    const tile = this.selectedTile()

    return (
      <div className="hb-map16-body">
        {/* Header: what this sheet IS. Every value echoes what actually
            produced it, never an in-progress picker value. */}
        <div className="hb-map16-toolbar hb-map16-toolbar-head">
          <span className="hb-map16-title">{this.options.label}</span>
          <span className="hb-map16-summary hb-map16-summary-dims">{`${sheet.tiles.length} tiles · ${sheet.width}×${sheet.height}px`}</span>
          <span className="hb-map16-summary hb-map16-summary-palette">
            {`Colors: BG ${sheet.paletteVariant.bg} / FG ${sheet.paletteVariant.fg}`}
          </span>
        </div>

        <div className="hb-map16-toolbar hb-map16-toolbar-controls">
          <label className="hb-map16-control" title={this.tilesetControlTitle()}>
            {/* Enabled on BOTH layers: tileset always resolves VRAM/GFX
                assignment, and on `bg` that alone changes 64.0% of the
                sheet's pixels (fg3/an1 slots, measured on the real
                cartridge) even though the TILE TABLE does not move. */}
            {sheet.layer === 'fg' ? 'Tileset' : 'Tileset (graphics only)'}
            <select
              data-control="tileset-select"
              className="theia-select"
              value={this.tileset}
              onChange={this.handleTilesetChange}
            >
              {Array.from({ length: MAP16_TILESET_COUNT }, (_, t) => (
                <option key={t} value={t}>{`Tileset ${t}`}</option>
              ))}
            </select>
          </label>
          <label className="hb-map16-control" title={this.paletteControlTitle(sheet, 'bg')}>
            Layer 2 Background
            <select
              data-control="bg-variant-select"
              className="theia-select"
              value={this.bgPaletteVariant}
              disabled={!this.citesRows(sheet, BG_VARIANT_COLOR_ROWS)}
              onChange={this.handleBgVariantChange}
            >
              {Array.from({ length: MAP16_PALETTE_VARIANT_COUNT }, (_, v) => (
                <option key={v} value={v}>{`Palette ${v}`}</option>
              ))}
            </select>
          </label>
          <label className="hb-map16-control" title={this.paletteControlTitle(sheet, 'fg')}>
            Layer 1 Foreground
            <select
              data-control="fg-variant-select"
              className="theia-select"
              value={this.fgPaletteVariant}
              disabled={!this.citesRows(sheet, FG_VARIANT_COLOR_ROWS)}
              onChange={this.handleFgVariantChange}
            >
              {Array.from({ length: MAP16_PALETTE_VARIANT_COUNT }, (_, v) => (
                <option key={v} value={v}>{`Palette ${v}`}</option>
              ))}
            </select>
          </label>
          <span className="hb-map16-toolbar-spacer" />
          <div className="hb-map16-toolbar-actions">
            <button
              data-control="zoom-out"
              type="button"
              className="hb-map16-icon-btn"
              disabled={this.zoom === ZOOM_OPTIONS[0]}
              title="Zoom out"
              aria-label="Zoom out"
              onClick={this.handleZoomOut}
            >
              <span className="codicon codicon-zoom-out" />
            </button>
            <span
              data-control="zoom-indicator"
              className="hb-map16-zoom-indicator"
            >{`${this.zoom}x`}</span>
            <button
              data-control="zoom-in"
              type="button"
              className="hb-map16-icon-btn"
              disabled={this.zoom === ZOOM_OPTIONS[ZOOM_OPTIONS.length - 1]}
              title="Zoom in"
              aria-label="Zoom in"
              onClick={this.handleZoomIn}
            >
              <span className="codicon codicon-zoom-in" />
            </button>
            <span className="hb-map16-toolbar-sep" />
            <button
              data-control="grid-toggle"
              type="button"
              className={'hb-map16-icon-btn' + (this.showGrid ? ' hb-map16-icon-btn-on' : '')}
              aria-pressed={this.showGrid}
              title={this.showGrid ? 'Hide grid' : 'Show grid'}
              aria-label={this.showGrid ? 'Hide grid' : 'Show grid'}
              onClick={this.handleGridToggle}
            >
              <span className="codicon codicon-table" />
            </button>
            <button
              data-control="play-toggle"
              type="button"
              className={'hb-map16-icon-btn' + (this.playing ? ' hb-map16-icon-btn-on' : '')}
              disabled={!sheet.charAnimation}
              aria-pressed={this.playing}
              title={
                !sheet.charAnimation
                  ? 'No animated characters in this sheet'
                  : this.playing
                    ? 'Stop animation'
                    : 'Play animation'
              }
              aria-label={this.playing ? 'Stop animation' : 'Play animation'}
              onClick={this.handlePlayToggle}
            >
              {/* debug-stop, not a pause glyph: playback is stopped and reset,
                  not paused mid-phase, so the icon matches the behaviour. */}
              <span className={`codicon ${this.playing ? 'codicon-debug-stop' : 'codicon-play'}`} />
            </button>
          </div>
          {sheet.animationNote && (
            <span className="hb-map16-note hb-map16-error" data-note="animation">
              {sheet.animationNote}
            </span>
          )}
          {sheet.gfxAssignmentNote && (
            <span className="hb-map16-note hb-map16-error" data-note="gfx-assignment">
              {sheet.gfxAssignmentNote}
            </span>
          )}
          {sheet.layer === 'bg' && (
            <span className="hb-map16-note">
              This is the ONE global Layer 2 preset table - it does not vary by tileset. The tileset
              control above still selects which GFX files color its characters.
            </span>
          )}
        </div>

        {/* Grid on the left, the selected tile to its right (#623). */}
        <div className="hb-map16-panes">
          {this.renderBrowser(sheet)}
          <div className="hb-map16-main">
            {tile ? this.renderTile(sheet, tile) : this.renderNoTile()}
          </div>
        </div>
      </div>
    )
  }

  protected renderNoTile(): React.ReactNode {
    return <div className="hb-map16-editor hb-map16-editor-empty">This table holds no tiles.</div>
  }

  /** Preview first, always. The edit pane and the character palettes are
   * rendered only once the user asks for them. */
  protected renderTile(sheet: Map16SheetDto, tile: Map16TileDto): React.ReactNode {
    return (
      <>
        {renderTilePreview({
          tile,
          editing: this.editing,
          onToggleEdit: this.handleEditToggle,
          previewCanvasRef: el => {
            const attached = el !== null && this.previewCanvasEl === null
            this.previewCanvasEl = el
            if (attached) this.schedulePaintDetail()
          },
          activeSwitches: this.activeSwitches,
          onToggleSwitch: this.toggleSwitch,
          switchUnavailable: sheet.switchUnavailable,
          buttonImages: this.switchButtonImages(sheet),
          buttonUnavailable: sheet.switchButtonUnavailable,
        })}
        {this.editing && (
          <div className="hb-map16-edit-pane">
            {renderTileEditor({
              sheet,
              tile,
              quadrant: this.selection!.quadrant,
              frameCount: tileFrameCount(sheet, tile.id),
              display: this.displayValue,
              onSelectQuadrant: this.selectQuadrant,
              onToggle: this.toggleField,
              onColorRow: this.setColorRow,
              quadrantCanvasRef: (frame, q, el) => {
                const key = this.frameKey(frame, q)
                const attached = el !== null && !this.frameQuadrantEls.get(key)
                this.frameQuadrantEls.set(key, el)
                if (attached) this.schedulePaintDetail()
              },
              playingFrame: this.playing ? this.charAnimPhase : undefined,
              editError: this.editError,
            })}
            {renderCharPalettes({
              sheets: sheet.charSheets,
              expanded: this.expandedSheets,
              currentChar: this.displayValue(
                this.selection!.quadrant,
                'charNum',
                tile[this.selection!.quadrant].charNum,
              ),
              onToggleSheet: this.toggleSheet,
              onPickChar: this.pickChar,
              canvasRef: (slot, el) => {
                const attached = el !== null && !this.sheetCanvasEls.get(slot)
                this.sheetCanvasEls.set(slot, el)
                if (attached) this.schedulePaintDetail()
              },
            })}
          </div>
        )}
      </>
    )
  }

  /** The tile browser strip: which tile the preview is showing. */
  protected renderBrowser(sheet: Map16SheetDto): React.ReactNode {
    const pages = Math.ceil(sheet.tiles.length / TILES_PER_PAGE)
    return (
      <div className={'hb-map16-browser' + (this.browserOpen ? '' : ' hb-map16-browser-closed')}>
        <div className="hb-map16-browser-head">
          <button
            data-control="browser-toggle"
            type="button"
            className="hb-map16-browser-toggle"
            aria-expanded={this.browserOpen}
            title={this.browserOpen ? 'Collapse the tile browser' : 'Expand the tile browser'}
            onClick={this.handleBrowserToggle}
          >
            <span
              className={`codicon ${this.browserOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}
            />
            Tiles
          </button>
          <span className="hb-map16-browser-note">
            {`${sheet.tiles.length} tiles, ${pages} ${pages === 1 ? 'page' : 'pages'}: read from this ROM. More pages need an expanded Map16 table (en-gen/hackbench#102).`}
          </span>
        </div>
        {this.browserOpen && (
          <div className="hb-map16-canvas-wrap">
            <canvas
              className="hb-map16-canvas"
              onClick={this.handleCanvasClick}
              onMouseMove={this.handleCanvasMouseMove}
              onMouseLeave={this.handleCanvasMouseLeave}
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
