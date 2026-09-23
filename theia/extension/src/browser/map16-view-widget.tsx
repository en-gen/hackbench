/**
 * The Map16 view: one tileset's 512 blocks, rendered as 16x16 composites,
 * with an inspector for the selected block's four subtiles.
 *
 * Same shape as GfxViewWidget for the canvas half (a decoded sheet painted
 * once per load/change, CSS-only zoom, no resampling) and as
 * PaletteViewWidget for the inspector half (a selection, a per-field edit,
 * `refresh()` rather than `load()` on a push so the selection survives a
 * repaint caused by someone else's edit).
 *
 * Read-only for char number's DISPLAY only in the sense that a charNum
 * pointing at nothing loaded renders as TileRenderer's magenta placeholder,
 * not blank - this view does not special-case that, since it is exactly the
 * same "nothing there" signal GfxLoader.getCharPixels already produces.
 *
 * `pendingEdits` (below) exists to fix a real bug, not a test artifact: every
 * field control here is CONTROLLED by the server-committed value
 * (`sub.priority`, `sub.palette`, ...). A native checkbox click toggles the
 * DOM element immediately, then fires `onChange`; if the field's displayed
 * value still comes from the last-committed sheet at that instant (it does -
 * `editField`'s round trip has not resolved yet), React's next render
 * reverts the control back to the pre-click value until the response
 * arrives, then jumps to the new value once it does. That is a visible
 * flicker for a real user (a checkbox that un-checks itself for a moment)
 * and, worse, a genuine repeated DOM mutation for an automated click: the
 * element is never destroyed, but it IS mutated twice in quick succession
 * right where the interaction lands, which is exactly what made Playwright's
 * actionability wait time out (`.check()` re-verifies the checked state
 * after clicking and cannot get a stable read). `pendingEdits` makes each
 * field's displayed value optimistic - set synchronously on the click,
 * cleared once the response confirms it - so the control changes state
 * exactly once, matching what the click actually did.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import {
  BG_PALETTE_ROWS,
  FG_PALETTE_ROWS,
  LoadMap16Result,
  Map16BlockDto,
  Map16Field,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16Service,
  Map16SheetDto,
  Map16SubtileKey,
  MAP16_PALETTE_VARIANT_COUNT,
  MAP16_TILESET_COUNT,
  SetMap16Result,
} from '../common/map16-protocol'
import { Map16FrontendClient } from './map16-push-client'
import { formatRomAddr } from './palette-color-format'

export const MAP16_VIEW_ID = 'hackbench.map16-view'

export interface Map16ViewOptions {
  manifestPath: string
  label: string
}

const ZOOM_OPTIONS = [1, 2, 3, 4]

/** Dim applied to every block except the hovered one. 0.55 black is the
 *  value the VS Code extension's Map16 panel used. */
const HOVER_DIM = 'rgba(0, 0, 0, 0.55)'

/** Tiles per page. The sheet is 512 tiles: two pages of 16x16, which is how
 *  the tile id's high byte reads and how Lunar Magic pages them. */
const TILES_PER_PAGE = 256
/** Blank rows drawn between the two pages, in natural pixels. */
const PAGE_GAP_PX = 6

/** Where a tile's top-left corner sits on the canvas, gap included. */
function tileOrigin(tileId: number, tilesPerRow: number): { x: number; y: number } {
  const page = Math.floor(tileId / TILES_PER_PAGE)
  const within = tileId % TILES_PER_PAGE
  return {
    x: (within % tilesPerRow) * BLOCK_PX,
    y:
      Math.floor(within / tilesPerRow) * BLOCK_PX +
      page * (TILES_PER_PAGE / tilesPerRow) * BLOCK_PX +
      page * PAGE_GAP_PX,
  }
}

/** Inverse of tileOrigin: the tile at a canvas point, or undefined in the gap. */
function tileAtPoint(x: number, y: number, tilesPerRow: number, count: number): number | undefined {
  const pageHeight = (TILES_PER_PAGE / tilesPerRow) * BLOCK_PX
  const page = Math.floor(y / (pageHeight + PAGE_GAP_PX))
  const localY = y - page * (pageHeight + PAGE_GAP_PX)
  if (localY >= pageHeight) return undefined // the separator itself
  const col = Math.floor(x / BLOCK_PX)
  if (col < 0 || col >= tilesPerRow) return undefined
  const id = page * TILES_PER_PAGE + Math.floor(localY / BLOCK_PX) * tilesPerRow + col
  return id >= 0 && id < count ? id : undefined
}
const DEFAULT_ZOOM = 2
const BLOCK_PX = 16
/** Large inspector preview: an integer multiple of BLOCK_PX so nearest-
 * neighbour scaling has no fractional-pixel seams. 4x keeps it well inside
 * a sidebar-width inspector panel without widening it. */
const PREVIEW_SCALE = 4
/** Frame-strip thumbnails: smaller than the main preview since there are
 * up to 4 of them side by side in the same panel width. */
const STRIP_SCALE = 2

/** Which corner is selected, alongside the block - the inspector edits one
 * subtile's fields at a time, chosen by clicking its label. */
interface Selection {
  tileId: number
  corner: Map16SubtileKey
}

const CORNERS: readonly { key: Map16SubtileKey; label: string }[] = [
  { key: 'tl', label: 'Top-left' },
  { key: 'tr', label: 'Top-right' },
  { key: 'bl', label: 'Bottom-left' },
  { key: 'br', label: 'Bottom-right' },
]

function decodeRgba(base64: string): Uint8ClampedArray {
  const binary = atob(base64)
  const bytes = new Uint8ClampedArray(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Crops one 16x16 block's pixels out of a full sheet-shaped RGBA buffer -
 * the shared source both the large preview and the frame strip read, per
 * the owner's requirement that neither decodes the block twice. */
function cropBlock(
  buf: Uint8ClampedArray,
  atlasWidth: number,
  tilesPerRow: number,
  tileId: number,
): Uint8ClampedArray {
  const col = tileId % tilesPerRow
  const row = Math.floor(tileId / tilesPerRow)
  const rowBytes = BLOCK_PX * 4
  const out = new Uint8ClampedArray(BLOCK_PX * rowBytes)
  for (let y = 0; y < BLOCK_PX; y++) {
    const srcOffset = ((row * BLOCK_PX + y) * atlasWidth + col * BLOCK_PX) * 4
    out.set(buf.subarray(srcOffset, srcOffset + rowBytes), y * rowBytes)
  }
  return out
}

/**
 * Paints a native BLOCK_PX x BLOCK_PX RGBA buffer into `canvas`, scaled up
 * by `scale` with NO smoothing - this is pixel art, and interpolation would
 * make an edit impossible to judge. `putImageData` cannot itself scale, so
 * the native pixels are blitted to an offscreen canvas first and the
 * visible canvas draws THAT, scaled, with smoothing off.
 */
function paintScaledBlock(
  canvas: HTMLCanvasElement,
  pixels: Uint8ClampedArray,
  scale: number,
): void {
  const size = BLOCK_PX * scale
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const native = document.createElement('canvas')
  native.width = BLOCK_PX
  native.height = BLOCK_PX
  const nativeCtx = native.getContext('2d')
  if (!nativeCtx) return
  nativeCtx.putImageData(new ImageData(pixels, BLOCK_PX, BLOCK_PX), 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(native, 0, 0, BLOCK_PX, BLOCK_PX, 0, 0, size, size)
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
   * Which of the two 512-block tables is shown: `fg` (per-tileset object
   * table, the original behaviour) or `bg` (the global Layer 2 preset
   * table - MapEditorProvider.ts loads both for a level, and they share no
   * data). `tileset` keeps meaning VRAM/GFX assignment either way; only its
   * role as a POINTER-TABLE selector goes away for `bg` - see
   * map16-protocol.ts's `Map16Layer`.
   */
  protected tableLayer: Map16Layer = 'fg'
  /**
   * BackgroundPalettes/ForegroundPalettes variant indices (0-7 each),
   * independent of a subtile's own 3-bit `palette` field - see
   * map16-protocol.ts's `Map16PaletteVariantDto`. Default 0/0 matches the
   * fixed choice this view made before these existed, so a project that
   * never touches them sees no change.
   */
  protected bgPaletteVariant = 0
  protected fgPaletteVariant = 0
  protected selection: Selection | undefined
  protected canvasEl: HTMLCanvasElement | null = null
  protected zoom = DEFAULT_ZOOM
  /**
   * The char-number field's in-progress text. A `<select>` or a checkbox
   * commits on the one discrete action that changes it, but a free-text
   * number field fires `onChange` per keystroke - without a draft, typing
   * "500" would commit charNum 5, then 50, then 500 as three separate
   * layers. Committed on blur or Enter instead, same reasoning as
   * palette-view-widget.tsx's `hexFieldDraft`.
   */
  protected charNumDraft: string | undefined
  /**
   * One optimistic value per in-flight field edit, keyed by
   * `pendingKey(tileId, corner, field)`. Read by every control's display
   * value so a click/selection change is reflected immediately rather than
   * waiting on the round trip - see this class's own doc comment for the
   * bug this fixes. Cleared the moment that edit's response (success OR
   * refusal) arrives.
   */
  protected readonly pendingEdits = new Map<string, number | boolean>()
  /** Bumped on every reload; a stale response (a slower request superseded
   * by a faster later one) is dropped rather than overwriting newer state. */
  protected reloadToken = 0

  /** Overlay only - never baked into the atlas, so toggling repaints the
   * existing canvas with no reload and the exported pixels stay clean. */
  /** Block under the pointer, or undefined when the pointer is off the
   *  sheet. Drives the hover spotlight only - never part of the edit
   *  selection, so moving the mouse can never change what is being edited. */
  protected hoverTileId: number | undefined

  protected showGrid = false
  /** Whether character-animation playback is running. Disabled/no-op when
   * the current sheet has no `charAnimation` model at all. */
  protected playing = false
  /** Which native animation frame is showing. Its own field, not derived
   * from a shared/global tick - see Map16CharAnimationDto's doc comment on
   * why a second, independently-clocked source (palette animation) must
   * never share this counter. */
  protected charAnimPhase = 0
  protected animTimerHandle: ReturnType<typeof setInterval> | undefined
  /** Guards `schedulePaintDetail` so one update paints the detail once,
   *  not once per canvas ref that attaches during the same commit. */
  protected detailPaintQueued = false

  protected previewCanvasEl: HTMLCanvasElement | null = null
  /** One per animation frame (4 today); unused slots stay null. */
  protected stripCanvasEls: (HTMLCanvasElement | null)[] = []
  /**
   * Decoded RGBA buffers, keyed by their SOURCE base64 string so
   * `charAnimation.phases[0]` (identical to `rgbaBase64` - see
   * decodeMap16Sheet) decodes exactly once and both the main canvas and
   * the inspector preview/strip share it. Cleared whenever `this.result`
   * is replaced with a freshly-fetched sheet.
   */
  protected readonly decodedCache = new Map<string, Uint8ClampedArray>()

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map16-view')
    this.title.closable = true
    this.node.tabIndex = 0

    // A Map16 edit made HERE already returns the fresh sheet directly
    // (applyResult below), so this only matters for a change made through
    // another view (a palette edit recoloring these blocks) - `refresh`,
    // not a full `open`, so the selected block/corner survives the repaint.
    this.toDispose.push(
      this.pushClient.onChanged(manifestPath => {
        if (manifestPath === this.options?.manifestPath) void this.refresh()
      }),
    )
    this.toDispose.push({ dispose: () => this.stopAnimation() })
  }

  protected handleGridToggle = (): void => {
    this.showGrid = !this.showGrid
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
      this.stopAnimation() // the sheet changed under a running timer; nothing left to advance
      return
    }
    this.charAnimPhase = (this.charAnimPhase + 1) % frameCount
    this.update()
  }

  /** Decodes `base64` once and caches by the string itself, so the SAME
   * source (e.g. `charAnimation.phases[0] === rgbaBase64`) is never decoded
   * twice - see `decodedCache`'s own doc comment. */
  protected decoded(base64: string): Uint8ClampedArray {
    let buf = this.decodedCache.get(base64)
    if (!buf) {
      buf = decodeRgba(base64)
      this.decodedCache.set(base64, buf)
    }
    return buf
  }

  /** Which base64 image is currently active for painting: the animation's
   * current phase while playing, otherwise the sheet's own still image. */
  protected activeBase64(sheet: Map16SheetDto): string {
    return this.playing && sheet.charAnimation
      ? sheet.charAnimation.phases[this.charAnimPhase]!
      : sheet.rgbaBase64
  }

  async open(options: Map16ViewOptions): Promise<void> {
    this.options = options
    this.id = MAP16_VIEW_ID
    this.title.label = options.label
    this.title.caption = options.label
    this.title.iconClass = 'codicon codicon-extensions'

    this.result = undefined
    this.error = undefined
    this.editError = undefined
    this.selection = undefined
    this.charNumDraft = undefined
    this.pendingEdits.clear()
    this.update()

    await this.reload()
  }

  /** Which project this tab shows, so PreviewTabs can retire the preview of it. */
  shows(): boolean {
    return this.options !== undefined
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
   * Whether any subtile in `sheet` cites a row in `rows` - the ONLY basis
   * for disabling a palette control. Never derived from `this.tableLayer`:
   * a hack's BG or FG table could cite rows a vanilla measurement never
   * saw, and `sheet.citedPaletteRows` (scanned server-side from the loaded
   * table) is what stays correct for it. See Map16SheetDto's own doc
   * comment for the vanilla figures that motivated this.
   */
  protected citesRows(sheet: Map16SheetDto, rows: readonly number[]): boolean {
    return sheet.citedPaletteRows.some(r => rows.includes(r))
  }

  protected paletteControlTitle(sheet: Map16SheetDto, which: 'bg' | 'fg'): string | undefined {
    if (which === 'bg' && !this.citesRows(sheet, BG_PALETTE_ROWS)) {
      return 'No subtile in this sheet uses a background palette'
    }
    if (which === 'fg' && !this.citesRows(sheet, FG_PALETTE_ROWS)) {
      return 'No subtile in this sheet uses a foreground palette'
    }
    return undefined
  }

  protected tilesetControlTitle(): string {
    return this.tableLayer === 'fg'
      ? 'Selects the tile table and the graphics'
      : 'Selects the graphics only - the Layer 2 tile table is global'
  }

  /**
   * Replaces `this.result` with a freshly-fetched sheet: clears the decoded-
   * pixel cache (new base64 strings, old ones no longer relevant) and
   * re-syncs the animation model to it - see `syncAnimationToSheet`. The
   * ONE place `this.result` is assigned from a load/refresh response, so
   * this bookkeeping cannot be forgotten at a second call site.
   */
  protected setResult(result: LoadMap16Result | undefined): void {
    this.result = result
    this.decodedCache.clear()
    this.syncAnimationToSheet()
  }

  /**
   * Stops playback and resets the phase when the current sheet has no
   * animation model at all (nothing to play); clamps an out-of-range phase
   * otherwise. Called after every `this.result` replacement - a table/
   * tileset/variant switch must not leave a dead timer running against a
   * sheet that no longer has the frames it is indexing into.
   */
  protected syncAnimationToSheet(): void {
    const anim = this.sheet()?.charAnimation
    if (!anim) {
      this.stopAnimation()
      this.charAnimPhase = 0
      return
    }
    if (this.charAnimPhase >= anim.frameCount) this.charAnimPhase = 0
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
        this.tableLayer,
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

  /** Re-fetches with the SAME tileset/layer/palette choice without touching
   * `selection` - the one-directional re-render a working-copy change
   * elsewhere pushes. */
  protected async refresh(): Promise<void> {
    if (!this.options) return
    const token = ++this.reloadToken
    try {
      const result = await this.map16.loadMap16(
        this.options.manifestPath,
        this.tileset,
        this.tableLayer,
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
  // `this.selection`, `charNumDraft` or `pendingEdits`, and never each
  // other's field. Tileset/layer/BG-variant/FG-variant are four independent
  // axes; the one time they interact is display-only (the tileset control's
  // `disabled` prop when `tableLayer === 'bg'`, in render()), never by one
  // handler resetting another's state.

  protected handleTilesetChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.tileset = Number(e.target.value)
    void this.reload() // a different tileset is a different pointer table, not a same-project push
  }

  protected handleTableLayerChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.tableLayer = e.target.value as Map16Layer
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

  /** Step zoom one stop along ZOOM_OPTIONS. Clamped, and the buttons
   *  disable at the ends, so zoom can never leave the supported set. */
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

  protected selectedBlock(): Map16BlockDto | undefined {
    const sel = this.selection
    const sheet = this.sheet()
    if (!sel || !sheet) return undefined
    return sheet.blocks[sel.tileId]
  }

  protected handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const sheet = this.sheet()
    if (!sheet) return
    const tileId = tileAtPoint(
      e.nativeEvent.offsetX / this.zoom,
      e.nativeEvent.offsetY / this.zoom,
      sheet.tilesPerRow,
      sheet.blocks.length,
    )
    if (tileId === undefined) return
    // Keep whichever corner was already being inspected; default to TL for
    // a fresh block so the inspector never shows "nothing" after a click.
    this.selection = { tileId, corner: this.selection?.corner ?? 'tl' }
    this.charNumDraft = undefined // belonged to whichever corner was selected before
    this.editError = undefined
    this.update()
  }

  /** Map a pointer event to a block id, or undefined if it is off-sheet.
   *  The canvas is drawn at NATURAL size and CSS-scaled by `zoom`, so an
   *  offset must be divided by the scaled cell, exactly as the click
   *  handler does. */
  protected tileIdAt(e: React.MouseEvent<HTMLCanvasElement>): number | undefined {
    const sheet = this.sheet()
    if (!sheet) return undefined
    return tileAtPoint(
      e.nativeEvent.offsetX / this.zoom,
      e.nativeEvent.offsetY / this.zoom,
      sheet.tilesPerRow,
      sheet.blocks.length,
    )
  }

  protected handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const id = this.tileIdAt(e)
    if (id === this.hoverTileId) return
    this.hoverTileId = id
    // Repaint the canvas directly rather than update(): hover changes no
    // markup, and a React pass per pointer move across a 16-wide grid is
    // pure waste.
    this.paintCanvas()
  }

  protected handleCanvasMouseLeave = (): void => {
    if (this.hoverTileId === undefined) return
    this.hoverTileId = undefined
    this.paintCanvas()
  }

  protected selectCorner(corner: Map16SubtileKey): void {
    if (!this.selection) return
    this.selection = { ...this.selection, corner }
    this.charNumDraft = undefined
    this.editError = undefined
    this.update()
  }

  protected onCharNumDraftChange(value: string): void {
    this.charNumDraft = value
    this.update()
  }

  /**
   * Commits the draft if it is a valid 10-bit char number and differs from
   * what is committed; otherwise drops the draft text. Enter and blur share
   * this.
   *
   * The shape of the accepted input is checked BEFORE `Number`, because
   * `Number` is far too permissive to gate a cartridge write on:
   * `Number('')` and `Number('   ')` are both 0, so clearing the field and
   * clicking away silently committed charNum 0 over whatever was there,
   * with no error and a real op layer on disk. `Number('0x40')` is 64 and
   * `Number('1e2')` is 100, neither of which is what the typist meant.
   * palette-view-widget.tsx's hex field does not have this hole because it
   * goes through normalizeBgr555Hex's strict pattern; this is the
   * equivalent gate, decimal rather than hex.
   */
  protected commitCharNumDraft(committed: number): void {
    const draft = this.charNumDraft
    this.charNumDraft = undefined
    if (draft === undefined) return
    if (!/^[0-9]{1,4}$/.test(draft.trim())) {
      this.update()
      return
    }
    const parsed = Number(draft.trim())
    if (parsed > 1023 || parsed === committed) {
      this.update()
      return
    }
    void this.editField('charNum', parsed)
  }

  /** Folds a SetMap16Result into widget state, same split as
   * PaletteViewWidget.applyResult: stale/io-error are edit refusals shown
   * inline, never replacing the rest of the view. */
  protected applyResult(result: SetMap16Result): void {
    if (result.status === 'stale' || result.status === 'io-error') {
      this.editError = result.reason
    } else {
      this.setResult(result)
      this.editError = undefined
    }
    this.update()
  }

  protected pendingKey(tileId: number, corner: Map16SubtileKey, field: Map16Field): string {
    return `${tileId}:${corner}:${field}`
  }

  /** `committed` unless an edit for this exact field is in flight, in which
   * case the value that edit is trying to reach - see this class's own doc
   * comment on `pendingEdits`. */
  protected displayValue<T extends number | boolean>(
    tileId: number,
    corner: Map16SubtileKey,
    field: Map16Field,
    committed: T,
  ): T {
    const pending = this.pendingEdits.get(this.pendingKey(tileId, corner, field))
    return pending === undefined ? committed : (pending as T)
  }

  protected async editField(field: Map16Field, value: number | boolean): Promise<void> {
    const sel = this.selection
    const manifestPath = this.options?.manifestPath
    if (!sel || !manifestPath) return
    const key = this.pendingKey(sel.tileId, sel.corner, field)
    // Optimistic: render the click's effect NOW, not once the round trip
    // resolves - otherwise the control (a checkbox especially) visibly
    // reverts to the old value for the RPC's duration, then jumps to the
    // new one, which is both a real UI flicker and what broke Playwright's
    // actionability check on a second interaction.
    this.pendingEdits.set(key, value)
    this.update()
    // An edit RETURNS a full sheet, so it is a load like any other and has
    // to honour reloadToken. Without this the response - which carries the
    // tileset/layer/variant read synchronously below - could land after the
    // user had already switched axis, repainting the canvas with the OLD
    // sheet while the selects, and this.tileset, read the new one. The next
    // edit then resolves its address against an axis the user cannot see.
    const token = ++this.reloadToken
    const axis = {
      tileset: this.tileset,
      layer: this.tableLayer,
      variant: this.paletteVariant(),
    }
    try {
      const result = await this.map16.setSubtileField(
        manifestPath,
        axis.tileset,
        axis.layer,
        axis.variant,
        sel.tileId,
        sel.corner,
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

  protected paintCanvas(): void {
    const sheet = this.sheet()
    if (!this.canvasEl || !sheet) return
    const pageHeight = (TILES_PER_PAGE / sheet.tilesPerRow) * BLOCK_PX
    const pages = Math.ceil(sheet.blocks.length / TILES_PER_PAGE)
    const gapTotal = (pages - 1) * PAGE_GAP_PX
    this.canvasEl.width = sheet.width
    this.canvasEl.height = sheet.height + gapTotal
    this.canvasEl.style.width = `${sheet.width * this.zoom}px`
    this.canvasEl.style.height = `${(sheet.height + gapTotal) * this.zoom}px`
    const ctx = this.canvasEl.getContext('2d')
    if (!ctx) return
    const pixels = this.decoded(this.activeBase64(sheet))

    // Each page is blitted separately so a blank band sits between them.
    // An offscreen canvas holds the decoded sheet because putImageData
    // ignores clipping and cannot take a source rectangle.
    const off = document.createElement('canvas')
    off.width = sheet.width
    off.height = sheet.height
    off.getContext('2d')?.putImageData(new ImageData(pixels, sheet.width, sheet.height), 0, 0)
    for (let page = 0; page < pages; page++) {
      const srcY = page * pageHeight
      ctx.drawImage(
        off,
        0,
        srcY,
        sheet.width,
        Math.min(pageHeight, sheet.height - srcY),
        0,
        srcY + page * PAGE_GAP_PX,
        sheet.width,
        Math.min(pageHeight, sheet.height - srcY),
      )
    }

    // Hover spotlight, matching the VS Code extension's Map16 panel
    // (webview/mapEditor/main.ts:2372): dim everything EXCEPT the block
    // under the pointer. That one is left exactly as decoded - no tint,
    // no outline, no scaling - so hovering never changes how a block
    // looks while you are judging it. The extension snapshotted the
    // canvas, dimmed all of it and restored the hovered slice; painting
    // four bands AROUND the block reaches the same result without ever
    // drawing over those pixels.
    if (this.hoverTileId !== undefined) {
      const { x: hx, y: hy } = tileOrigin(this.hoverTileId, sheet.tilesPerRow)
      ctx.fillStyle = HOVER_DIM
      ctx.fillRect(0, 0, sheet.width, hy)
      ctx.fillRect(0, hy + BLOCK_PX, sheet.width, this.canvasEl.height - (hy + BLOCK_PX))
      ctx.fillRect(0, hy, hx, BLOCK_PX)
      ctx.fillRect(hx + BLOCK_PX, hy, sheet.width - (hx + BLOCK_PX), BLOCK_PX)
    }

    const sel = this.selection
    if (sel) {
      const { x: selX, y: selY } = tileOrigin(sel.tileId, sheet.tilesPerRow)
      const accent =
        getComputedStyle(this.node).getPropertyValue('--theia-focusBorder').trim() || '#3399ff'
      ctx.lineWidth = 1
      ctx.strokeStyle = accent
      ctx.strokeRect(selX + 0.5, selY + 0.5, BLOCK_PX - 1, BLOCK_PX - 1)
    }

    // Grid overlay: drawn on top every repaint, never baked into the
    // decoded pixels - toggling it is a local repaint, no reload, and the
    // atlas bytes an export would use stay exactly what the cart says.
    if (this.showGrid) {
      const gridColor =
        getComputedStyle(this.node).getPropertyValue('--theia-editorWidget-border').trim() ||
        'rgba(128,128,128,0.6)'
      ctx.lineWidth = 1
      ctx.strokeStyle = gridColor
      // Per page, so the lines stop at each page's own edge rather than
      // running through the separator band between them.
      for (let page = 0; page < pages; page++) {
        const top = page * (pageHeight + PAGE_GAP_PX)
        const bottom = top + pageHeight
        for (let x = 0; x <= sheet.width; x += BLOCK_PX) {
          ctx.beginPath()
          ctx.moveTo(x + 0.5, top)
          ctx.lineTo(x + 0.5, bottom)
          ctx.stroke()
        }
        for (let y = top; y <= bottom; y += BLOCK_PX) {
          ctx.beginPath()
          ctx.moveTo(0, y + 0.5)
          ctx.lineTo(sheet.width, y + 0.5)
          ctx.stroke()
        }
      }
    }
  }

  /**
   * Paints the inspector's large preview and (when the selected block
   * animates) its frame strip - both read the SAME decoded phase buffers
   * `paintCanvas` does (via `this.decoded`), cropped to the block's own
   * 16x16 region, per the owner's requirement that the block is not
   * decoded twice.
   */
  /**
   * Repaint the detail canvases once the DOM has them.
   *
   * React sets a `ref` during COMMIT, which happens AFTER
   * `onUpdateRequest` returns. Painting straight from `onUpdateRequest`
   * therefore found `previewCanvasEl` still null the first time a block
   * was selected - the inspector had never rendered before, so its
   * canvas did not exist yet - and the first selected block showed an
   * empty preview while every later selection worked, because by then
   * the ref was populated. The ref callbacks call this too, so the paint
   * happens whenever the canvases actually arrive, whichever order that
   * is relative to the update.
   */
  protected schedulePaintDetail(): void {
    if (this.detailPaintQueued) return
    this.detailPaintQueued = true
    queueMicrotask(() => {
      this.detailPaintQueued = false
      this.paintDetail()
    })
  }

  protected paintDetail(): void {
    const sheet = this.sheet()
    const block = this.selectedBlock()
    if (!sheet || !block) return

    if (this.previewCanvasEl) {
      const pixels = cropBlock(
        this.decoded(this.activeBase64(sheet)),
        sheet.width,
        sheet.tilesPerRow,
        block.id,
      )
      paintScaledBlock(this.previewCanvasEl, pixels, PREVIEW_SCALE)
    }

    const anim = sheet.charAnimation
    if (!anim || !anim.animatedBlockIds.includes(block.id)) return
    for (let i = 0; i < anim.frameCount; i++) {
      const el = this.stripCanvasEls[i]
      if (!el) continue
      const pixels = cropBlock(
        this.decoded(anim.phases[i]!),
        sheet.width,
        sheet.tilesPerRow,
        block.id,
      )
      paintScaledBlock(el, pixels, STRIP_SCALE)
    }
  }

  protected render(): React.ReactNode {
    if (!this.options) {
      return <div className="hb-map16-empty">Reading the cartridge...</div>
    }
    if (this.error) {
      return <div className="hb-map16-error">{this.error}</div>
    }
    if (!this.result) {
      return <div className="hb-map16-empty">Reading the cartridge...</div>
    }
    if (this.result.status === 'rom-not-located') {
      const title = this.result.baseRom.title || 'the base cartridge'
      return <div className="hb-map16-empty">{`Locate ${title} to view its Map16 tiles`}</div>
    }

    const sheet = this.result.sheet

    return (
      <div className="hb-map16-body">
        {/* Header: what this sheet IS. Every value here echoes what actually
            produced the sheet, never an in-progress picker value. */}
        <div className="hb-map16-toolbar hb-map16-toolbar-head">
          <span className="hb-map16-title">{this.options.label}</span>
          <span className="hb-map16-summary hb-map16-summary-dims">{`${sheet.blocks.length} tiles · ${sheet.width}×${sheet.height}px`}</span>
          <span className="hb-map16-summary hb-map16-summary-palette">
            {`Color: BG ${sheet.paletteVariant.bg} / FG ${sheet.paletteVariant.fg}`}
          </span>
        </div>

        {/* Controls: the data selectors and the icon actions on one row.
            Codicons for the actions, since that is what the rest of the
            shell uses, and labelled selects for the data axes. */}
        <div className="hb-map16-toolbar hb-map16-toolbar-controls">
          <label className="hb-map16-control">
            Table
            <select
              id="hb-map16-layer-select"
              className="theia-select"
              value={this.tableLayer}
              onChange={this.handleTableLayerChange}
            >
              <option value="fg">FG (per tileset)</option>
              <option value="bg">BG (global, Layer 2)</option>
            </select>
          </label>
          <label className="hb-map16-control" title={this.tilesetControlTitle()}>
            {/* Enabled for BOTH layers: tileset always resolves VRAM/GFX
                assignment, and on `bg` that alone still changes 64.0% of
                the sheet's pixels (fg3/an1 slots, measured on the real
                cartridge) even though the BLOCK TABLE does not move - see
                map16-protocol.ts's Map16Layer. Only the label changes. */}
            {this.tableLayer === 'fg' ? 'Tileset' : 'Tileset (graphics only)'}
            <select
              id="hb-map16-tileset-select"
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
              id="hb-map16-bg-variant-select"
              className="theia-select"
              value={this.bgPaletteVariant}
              disabled={!this.citesRows(sheet, BG_PALETTE_ROWS)}
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
              id="hb-map16-fg-variant-select"
              className="theia-select"
              value={this.fgPaletteVariant}
              disabled={!this.citesRows(sheet, FG_PALETTE_ROWS)}
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
              id="hb-map16-zoom-out"
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
              id="hb-map16-zoom-indicator"
              className="hb-map16-zoom-indicator"
            >{`${this.zoom}x`}</span>
            <button
              id="hb-map16-zoom-in"
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
              id="hb-map16-grid-toggle"
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
              id="hb-map16-play-toggle"
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
          {/* Echoes what actually produced this sheet (sheet.paletteVariant),
              never the raw in-progress selection, same rule GfxViewWidget
              follows for bpp/paletteRow - see Map16SheetDto's own comment. */}
          {sheet.layer === 'bg' && (
            <span className="hb-map16-note">
              This is the ONE global Layer 2 preset table - it does not vary by tileset. The tileset
              control above still selects which GFX files color its characters.
            </span>
          )}
        </div>

        <div className="hb-map16-layout">
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
          {this.renderInspector(sheet)}
        </div>
      </div>
    )
  }

  protected renderInspector(sheet: Map16SheetDto): React.ReactNode {
    const block = this.selectedBlock()
    const sel = this.selection

    if (!block || !sel) {
      return (
        <div className="hb-map16-inspector hb-map16-inspector-empty">
          Click a block to inspect and edit it
        </div>
      )
    }

    return (
      <div className="hb-map16-inspector">
        <div className="hb-map16-inspector-header">
          <span className="hb-map16-inspector-block-id">
            {`Tile $${block.id.toString(16).toUpperCase().padStart(3, '0')}`}
          </span>
          <span className="hb-map16-addr">{formatRomAddr(block.romAddr)}</span>
        </div>

        {/* A picture of the block being edited, at a size actually big
            enough to judge an edit against - see this class's own doc
            comment on paintDetail. Tracks the current animation phase
            while playing, via the same paintDetail() call. */}
        <div className="hb-map16-preview-wrap">
          <canvas
            className="hb-map16-preview-canvas"
            ref={el => {
              const attached = el !== null && this.previewCanvasEl === null
              this.previewCanvasEl = el
              if (attached) this.schedulePaintDetail()
            }}
          />
        </div>

        <div className="hb-map16-corners">
          {CORNERS.map(c => (
            <button
              key={c.key}
              type="button"
              className={
                'hb-map16-corner' + (sel.corner === c.key ? ' hb-map16-corner-selected' : '')
              }
              onClick={() => this.selectCorner(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {this.renderSubtileFields(block, sel.corner)}

        {this.renderFrameStrip(sheet, block)}

        {this.editError && <div className="hb-map16-inspector-error">{this.editError}</div>}

        <div className="hb-map16-inspector-note">
          {/* Per BLOCK, not per layer: 326 of 512 FG ids sit in the shared
              Map16Common run and are byte-identical across all 15 tilesets.
              Saying "other tilesets keep their own bytes" for those was
              confidently wrong about a destructive edit. See
              Map16BlockDto.shared. */}
          {sheet.layer === 'bg'
            ? 'Editing the global Layer 2 table; every level that reads this tile sees the change.'
            : block.shared
              ? 'This tile is shared by all 15 tilesets; the edit changes it for every one of them.'
              : `This tile is tileset ${sheet.tileset}'s own copy; other tilesets keep their own bytes.`}
        </div>
      </div>
    )
  }

  /**
   * The selected block's four animation frames, labelled 0-3, or an
   * explicit "does not animate" line - never four identical thumbnails
   * standing in for "we don't know". `animatedBlockIds` (scanned
   * server-side from the loaded animation data, not a hardcoded char
   * range) is the only source of truth for which blocks animate.
   */
  protected renderFrameStrip(sheet: Map16SheetDto, block: Map16BlockDto): React.ReactNode {
    const anim = sheet.charAnimation
    if (!anim || !anim.animatedBlockIds.includes(block.id)) {
      return <div className="hb-map16-frame-strip-empty">This block does not animate.</div>
    }
    return (
      <div className="hb-map16-frame-strip">
        {Array.from({ length: anim.frameCount }, (_, i) => (
          <div
            key={i}
            className={
              'hb-map16-frame' +
              (this.playing && this.charAnimPhase === i ? ' hb-map16-frame-current' : '')
            }
          >
            <canvas
              className="hb-map16-frame-canvas"
              ref={el => {
                const attached = el !== null && !this.stripCanvasEls[i]
                this.stripCanvasEls[i] = el
                if (attached) this.schedulePaintDetail()
              }}
            />
            <span className="hb-map16-frame-label">{i}</span>
          </div>
        ))}
      </div>
    )
  }

  protected renderSubtileFields(block: Map16BlockDto, corner: Map16SubtileKey): React.ReactNode {
    const sub = block[corner]
    // Every value below is optimistic-aware (this.displayValue): a control
    // reflects an in-flight edit of ITS OWN field immediately, rather than
    // whatever was last committed, so it never has to revert-then-jump
    // across the round trip - see this class's doc comment on `pendingEdits`.
    const charNum = this.displayValue(block.id, corner, 'charNum', sub.charNum)
    const palette = this.displayValue(block.id, corner, 'palette', sub.palette)
    const priority = this.displayValue(block.id, corner, 'priority', sub.priority)
    const flipX = this.displayValue(block.id, corner, 'flipX', sub.flipX)
    const flipY = this.displayValue(block.id, corner, 'flipY', sub.flipY)

    return (
      <div className="hb-map16-fields">
        <div className="hb-map16-addr-line">{formatRomAddr(sub.romAddr)}</div>

        <label className="hb-map16-field">
          Char number
          <input
            type="number"
            className="hb-map16-field-input"
            min={0}
            max={1023}
            value={this.charNumDraft ?? String(charNum)}
            onChange={e => this.onCharNumDraftChange(e.currentTarget.value)}
            onBlur={() => this.commitCharNumDraft(charNum)}
            onKeyDown={e => {
              if (e.key === 'Enter') this.commitCharNumDraft(charNum)
            }}
          />
        </label>

        <label className="hb-map16-field">
          Palette row
          <select
            className="theia-select"
            value={palette}
            onChange={e => void this.editField('palette', Number(e.currentTarget.value))}
          >
            {Array.from({ length: 8 }, (_, p) => (
              <option key={p} value={p}>{`Row ${p}`}</option>
            ))}
          </select>
        </label>

        <label className="hb-map16-field hb-map16-field-checkbox">
          <input
            type="checkbox"
            checked={priority}
            onChange={e => void this.editField('priority', e.currentTarget.checked)}
          />
          Priority (draws over sprites)
        </label>

        <label className="hb-map16-field hb-map16-field-checkbox">
          <input
            type="checkbox"
            checked={flipX}
            onChange={e => void this.editField('flipX', e.currentTarget.checked)}
          />
          Flip X
        </label>

        <label className="hb-map16-field hb-map16-field-checkbox">
          <input
            type="checkbox"
            checked={flipY}
            onChange={e => void this.editField('flipY', e.currentTarget.checked)}
          />
          Flip Y
        </label>
      </div>
    )
  }
}
