import { isPriorityDecorative, type GetL1Tile, type OverlayContext } from './OverlayContext'
import { cellBoxOf } from './RenderTarget'
import type { Phase, RenderContext, RenderTarget } from './RenderTarget'
import type { L2Layer } from './L2Layer'
import type { L3Layer } from './L3Layer'
import type { Palette } from './palette/Palette'
import type { Sprite } from './sprites/Sprite'
import type { Tile } from './tiles/Tile'

export type LevelOrientation = 'horizontal' | 'vertical'

export interface LevelHeader {
  mode: number
  music: number
  tileset: number
  orientation: LevelOrientation
  /**
   * Layer-2 scroll settings 0..3 (from $05D710 / $05D720 via the
   * per-level $05F000 byte). Drive the parallax ratio used by the
   * camera-viewport preview.
   */
  vertLayer2Setting?: number
  horizLayer2Setting?: number
  /** True when BG3 priority is set — L3 draws in front of L1 non-priority tiles. */
  layer3Priority?: boolean
  /**
   * Initial Layer1YPos (camera Y) in pixels, from DATA_05D708 via
   * DATA_05F200[level] bits 3:2 (bank_05.asm:7329-7335). Seeds the camera
   * viewport at load and positions L3 tide overlays within the level.
   */
  initialCameraYPx: number
  /**
   * Time-limit index from header byte 3 bits 7:6 (0..3). Indexes TimerTable
   * at $0584D7 (`db $00, $02, $03, $04`) to give the starting timer digit
   * (0 = no timer, 2/3/4 = 200/300/400 seconds). Drives the HUD timer
   * display and any "show level time limit" panel.
   */
  timeLimit: number
  /**
   * Mario's starting pixel position at level load. Primary levels pick from
   * DATA_05F000/DATA_05F200 via DATA_05D730/740/750/758; sublevels pick from
   * the secondary entrance that targets them. See `readMarioStartPos` in
   * L3Loader.ts. Used by sprite handlers that depend on Mario's spawn side
   * (e.g. FaceMario → Dry Bones flip direction) and as an editor anchor.
   */
  marioStartPx: { x: number; y: number }
}

export class SmwMap {
  constructor(
    readonly id: number,
    readonly header: LevelHeader,
    /**
     * L1 tilemap as a 2D (row, col) table of Map16 ids (or null for
     * empty). The actual Tile instances live in `l1Tiles`; callers that
     * need them resolve `l1Tiles.get(id)`. Storing ids keeps the map a
     * data table and makes the editing model straightforward — replacing
     * a tile is a number write, not a reference swap.
     */
    readonly l1: (number | null)[][],
    readonly l2: L2Layer | null,
    readonly l3: L3Layer | null,
    readonly sprites: Sprite[],
    readonly palette: Palette,
    readonly tileset: number,
    readonly screenCount: number,
    readonly screenPipeVariantIdx: number[],
    /** L1 Map16 tile lookup (the 512-entry table this level's tileset
     *  produces). Shared with any L2ObjectStream that points at L1. */
    readonly l1Tiles: Map<number, Tile>,
    /**
     * Full 512-entry BG Map16 tile palette for this level's tileset —
     * always loaded, independent of whether this level's L2 layout
     * references every entry. The Map16 viewer surface (pages 0x80 /
     * 0x81) renders from this, so an editor always shows the whole
     * palette.
     */
    readonly bgTiles: Map<number, Tile>,
  ) {}

  render(ctx: RenderContext, target: RenderTarget): void {
    // Stamp level-wide state onto the ctx once per render pass so tile
    // behaviors can self-select per-cell concerns (e.g. PipeVariantsBehavior
    // derives its own screen idx from the cell it's drawing onto).
    const levelCtx: RenderContext = {
      ...ctx,
      levelOrientation: this.header.orientation,
      screenPipeVariantIdx: this.screenPipeVariantIdx,
      initialCameraYPx: this.header.initialCameraYPx,
    }
    const toggles = levelCtx.layerToggles.value
    const l3Priority = this.header.layer3Priority ?? false
    // layer3Priority=false → L3 behind everything (before L2)
    if (toggles.l3 && !l3Priority) this.l3?.render(levelCtx, target)
    if (toggles.l2) this.l2?.render(levelCtx, target)
    if (toggles.l1) this.renderL1Overlays(levelCtx, target)
    if (toggles.l1) this.renderL1(levelCtx, target, 'nonPriority')
    if (toggles.sprites) {
      for (const sprite of this.spritesInRenderOrder()) sprite.render(levelCtx, target)
    }
    if (toggles.l1) this.renderL1(levelCtx, target, 'priority')
    // layer3Priority=true → L3 in front of sprites, behind L1 priority
    if (toggles.l3 && l3Priority) this.l3?.render(levelCtx, target)
  }

  private renderL1Overlays(ctx: RenderContext, target: RenderTarget): void {
    for (let y = 0; y < this.l1.length; y++) {
      const row = this.l1[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile?.behavior.renderOverlay) continue
        tile.renderOverlay(ctx, target, cellBoxOf(x, y))
      }
    }
  }

  private renderL1(ctx: RenderContext, target: RenderTarget, phase: Phase): void {
    for (let y = 0; y < this.l1.length; y++) {
      const row = this.l1[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile) continue
        tile.render(ctx, target, cellBoxOf(x, y), phase)
      }
    }
  }

  /**
   * Draw geometric overlays (corridors, zones, arc paths) for every sprite
   * whose appearance implements `renderOverlay`. Called as a Canvas2D pre-pass
   * before the model pixel-render so sprite artwork sits on top of tinted
   * regions automatically.
   *
   * @param ctx        CanvasRenderingContext2D cast as OverlayContext.
   * @param activeKeys Set of `"id:x,y"` keys for sprites whose overlay is
   *                   currently toggled on by the user.
   */
  renderSpriteOverlays(ctx: OverlayContext, activeKeys: ReadonlySet<string>): void {
    const rows     = this.l1.length
    const cols     = this.l1[0]?.length ?? 0
    // Priority-1 decorative tiles (foreground grass, backdrop tubes, etc.)
    // render in front of sprites but pass through sprite collision per
    // SMW's bank_01 interaction routines. Filter them out once here so every
    // sprite overlay sees a collision-correct L1 grid without open-coding
    // the check — matches CODE_01928E's "actsLike is gospel except when the
    // quad is all-priority decoration" semantics.
    // Emit the priority-decorative status as a cell field rather than
    // filtering the cell to null. Per-predicate consumers decide the
    // semantics: `solidH`/`solidV` treat priority cells as passable
    // (matches SMW collision rules) while `hasGround` treats them as
    // ground (matches what the user sees the sprite sitting on).
    const getL1: GetL1Tile = (c, r) => {
      const id = this.l1[r]?.[c] ?? null
      if (id === null) return null
      const tile = this.l1Tiles.get(id)
      const isPriority = tile ? isPriorityDecorative(tile) : false
      const collision = tile?.collision
      return { id, actsLike: tile?.actsLike ?? id, isPriority, collision }
    }
    const marioSpawnX = this.header.marioStartPx?.x
    for (const sprite of this.sprites) {
      if (!sprite.appearance.renderOverlay) continue
      const key    = `${sprite.id}:${sprite.x},${sprite.y}`
      sprite.renderOverlay(
        ctx, sprite.x, sprite.y, activeKeys.has(key), getL1, cols, rows, marioSpawnX,
      )
    }
  }

  spritesInRenderOrder(): Sprite[] {
    const horizontal = this.header.orientation === 'horizontal'
    return [...this.sprites].sort((a, b) => {
      if (horizontal) return a.x - b.x || a.y - b.y
      return a.y - b.y || a.x - b.x
    })
  }
}
