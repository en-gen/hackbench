import { isPriorityDecorative, type GetL1Tile, type OverlayContext } from './OverlayContext'
import { cellBoxOf } from './RenderTarget'
import type { Phase, RenderTarget } from './RenderTarget'
import { livePasses, ppuDrawOrder, type PassOccupancy, type RenderPass } from './RenderPass'
import type { L2Layer } from './L2Layer'
import type { L3Layer } from './L3Layer'
import type { Palette } from './palette/Palette'
import { spriteOverlayKey, type Sprite } from './sprites/Sprite'
import { editorStore } from './stores/editorStore'
import type { MapStore } from './stores/mapStore'
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
  /** True when BG3 priority is set - L3 draws in front of L1 non-priority tiles. */
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
   * Mario's starting pixel position at map load. Every map, entry maps $100+
   * included, picks its primary entrance from DATA_05F000/DATA_05F200 via
   * DATA_05D730/740/750/758, plus the entrance screen (DATA_05F600) and type
   * nudge. A sub area's secondary entrance is a return entrance and is not
   * read. See `readMarioStartPos` in MarioStartPos.ts. Used by sprite handlers that depend on Mario's spawn side
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
     * data table and makes the editing model straightforward - replacing
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
     * Full 512-entry BG Map16 tile palette for this level's tileset -
     * always loaded, independent of whether this level's L2 layout
     * references every entry. The Map16 viewer surface (pages 0x80 /
     * 0x81) renders from this, so an editor always shows the whole
     * palette.
     */
    readonly bgTiles: Map<number, Tile>,
    /**
     * Per-map reactive store. Holds palette + ROM-derived per-level data
     * (orientation, screen pipe variants, initial camera Y, mario spawn X).
     * Threaded through render() into every behavior so they can read
     * level-wide ROM data without reaching into globals.
     */
    readonly mapStore: MapStore,
  ) {}

  /**
   * The mode-1 passes this level actually occupies, back to front. The
   * order is the PPU's (see `RenderPass.ts`); the filtering is this level's
   * own content, so the list is data per level rather than a fixed array.
   * A later stage gives each entry its own canvas.
   */
  passes(): RenderPass[] {
    const bgPhases = (phases: Set<Phase>): Set<number> => {
      const out = new Set<number>()
      if (phases.has('nonPriority')) out.add(0)
      if (phases.has('priority')) out.add(1)
      return out
    }
    const occupancy: PassOccupancy = {
      l1: bgPhases(this.l1Phases()),
      l2: bgPhases(this.l2?.phases(this.mapStore) ?? new Set()),
      l3: bgPhases(this.l3?.phases() ?? new Set()),
      sprites: new Set(this.sprites.map(s => s.priority.value)),
    }
    return livePasses(this.header.layer3Priority ?? false, occupancy)
  }

  render(target: RenderTarget): void {
    const toggles = editorStore.layerToggles
    // Overlays are a pre-pass: tiles drawn afterwards cover the lower part
    // of any overlay reaching into their own cell, which is the effect the
    // vine/1-up indicators rely on.
    if (toggles.l1) this.renderL1Overlays(target)
    const sprites = toggles.sprites ? this.spritesInRenderOrder() : []

    // The editor annotation seam ($4D Monty Mole ghosts its emerged pose
    // over its anonymous mound) is NOT a hardware pass, so it is not in
    // `ppuDrawOrder`. It belongs directly above the Layer 1 priority tiles
    // and deliberately BELOW any Layer 3 priority pass: an annotation goes
    // over layer 1 only, it is not promoted over the foreground BG. See
    // SpriteAppearance.renderAboveL1 and docs/sprites/sprite-4d-monty-mole.md.
    //
    // Anchored to L1.1's slot in the FULL mode-1 order, not to the live
    // pass list, because 75 percent of levels have no L1 priority content
    // and the annotation still has to draw on them.
    const order = ppuDrawOrder(this.header.layer3Priority ?? false)
    const rank = (q: RenderPass): number =>
      order.findIndex(o => o.layer === q.layer && o.priority === q.priority)
    const annotateAfter = order.findIndex(o => o.layer === 'l1' && o.priority === 1)
    let annotated = false
    const annotate = (): void => {
      if (annotated) return
      annotated = true
      for (const sprite of sprites) sprite.renderAboveL1(target, this.mapStore)
    }

    for (const pass of this.passes()) {
      if (rank(pass) > annotateAfter) annotate()
      const phase: Phase = pass.priority === 1 ? 'priority' : 'nonPriority'
      switch (pass.layer) {
        case 'l1':
          if (toggles.l1) this.renderL1(target, phase)
          break
        case 'l2':
          if (toggles.l2) this.l2?.render(target, this.mapStore, phase)
          break
        case 'l3':
          if (toggles.l3) this.l3?.render(target, this.mapStore, phase)
          break
        case 'sprites':
          for (const sprite of sprites) {
            if (sprite.priority.value === pass.priority) sprite.render(target, this.mapStore)
          }
          break
      }
    }
    annotate()
  }

  /** Tile-priority phases the Layer-1 grid occupies. */
  private l1Phases(): Set<Phase> {
    const out = new Set<Phase>()
    const seen = new Set<number>()
    for (let y = 0; y < this.l1.length && out.size < 2; y++) {
      const row = this.l1[y]
      if (!row) continue
      for (let x = 0; x < row.length && out.size < 2; x++) {
        const id = row[x]
        if (id === null || seen.has(id)) continue
        seen.add(id)
        for (const sub of this.l1Tiles.get(id)?.quadAt(cellBoxOf(x, y), this.mapStore) ?? []) {
          out.add(sub.priority ? 'priority' : 'nonPriority')
        }
      }
    }
    return out
  }

  private renderL1Overlays(target: RenderTarget): void {
    for (let y = 0; y < this.l1.length; y++) {
      const row = this.l1[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile?.behavior.renderOverlay) continue
        tile.renderOverlay(target, cellBoxOf(x, y), this.mapStore)
      }
    }
  }

  private renderL1(target: RenderTarget, phase: Phase): void {
    for (let y = 0; y < this.l1.length; y++) {
      const row = this.l1[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile) continue
        tile.render(target, cellBoxOf(x, y), this.mapStore, phase)
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
   * @param activeKeys Set of `spriteOverlayKey` strings for sprites whose
   *                   annotation is currently toggled on by the user.
   */
  renderSpriteOverlays(ctx: OverlayContext, activeKeys: ReadonlySet<string>): void {
    const rows = this.l1.length
    const cols = this.l1[0]?.length ?? 0
    // Priority-1 decorative tiles (foreground grass, backdrop tubes, etc.)
    // render in front of sprites but pass through sprite collision per
    // SMW's bank_01 interaction routines. Filter them out once here so every
    // sprite overlay sees a collision-correct L1 grid without open-coding
    // the check - matches CODE_01928E's "actsLike is gospel except when the
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
    for (const sprite of this.sprites) {
      if (!sprite.appearance.renderOverlay) continue
      const key = spriteOverlayKey(sprite)
      sprite.renderOverlay(
        ctx,
        sprite.x,
        sprite.y,
        activeKeys.has(key),
        getL1,
        cols,
        rows,
        this.mapStore,
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
