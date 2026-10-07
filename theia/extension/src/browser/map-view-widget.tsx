/**
 * One map, opened from the explorer: its L1 (foreground) and L2 (background), drawn by the
 * backend a screen at a time (#421 step 3), with the header decode below.
 *
 * The strip requests only the screens in view plus one either side, and
 * caches them in THIS tab, keyed by screen and switch-palace state. Every
 * piece of view state (palaces, zoom) lives on the widget instance, so two
 * open maps never share toggles. A working-copy push drops the cache and
 * re-fetches, so an edit in any view repaints the map.
 *
 * The header's key facts stay in view; the full decode is a secondary
 * panel, every field traced to src/rom/LevelParser.ts, beside its bytes.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message, Widget } from '@theia/core/lib/browser'
import {
  MAP_PLANE_KEYS,
  MapCollisionCheckResult,
  MapCollisionResult,
  MapDetailsDto,
  MapPlaneKey,
  MapScreenResult,
  MapBlockContentsResult,
  MapSpritesResult,
  ProjectService,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { ProjectContext } from './project-context'
import { decodeRgba, TILE_PX } from './map16-pixels'
import {
  compositeSpriteScreen,
  decodeArts,
  hoverTarget,
  indicatorId,
  IndicatorDisplay,
  paintSpriteCanvas,
  PALACES,
  screenKey,
  type Indicator,
} from './map-view-model'
import { SWITCH_ORDER } from './map16-view-model'
import { decodeSwitchButton, SwitchToggle, type SwitchButtonImages } from './switch-toggle'
import { LayerToggle } from './layer-icon'
import { PixelImageButton, type FrameImage } from './pixel-image-button'
import { slotLabel } from './map-explorer-widget'
import { WheelBinding, ZoomController } from './zoom-controller'
import { ZoomStepper } from './zoom-stepper'
import { MapGridOverlay } from './grid-overlay'
import { CollisionOverlay } from './collision-overlay'
import { collisionKey, collisionPlan } from './map-view-state'
import { MapViewStateStore } from './map-view-state-store'
import { layer2Label } from './map-layer-labels'
import { isUnverifiedMode } from '../../../../src/rom/model/UnverifiedModes'
import { composeScreen, type SourceKey } from '../../../../src/rom/model/ColorMath'
import { perfEnd, perfStart } from '../common/perf-marks'
import { ProjectBound } from './project-bound'

export { slotLabel }
/** One screen's decoded planes; null is an empty plane, which draws nothing. */
interface ScreenImages {
  width: number
  height: number
  planes: Record<MapPlaneKey, ImageData | null>
  /** What the compositor needs, from the same reply (#562). */
  screens: Layout['screens']
  math: Layout['math']
}

export const MAP_VIEW_ID = 'hackbench.map-view'

/** Identifies which map a widget instance shows. */
export interface MapViewOptions {
  manifestPath: string
  index: number
  label: string
  /** The tree row's own icon, so the tab matches where it was opened from. */
  iconClass?: string
}

type Layout = Extract<MapScreenResult, { status: 'ok' }>
type Sprites = Extract<MapSpritesResult, { status: 'ok' }>
type Collision = Extract<MapCollisionResult, { status: 'ok' }>
/** Why a collision reply (or check) leaves the overlay unavailable, or undefined when it does not. */
function collisionWhyNot(
  r: Exclude<MapCollisionResult, { status: 'stale' }> | MapCollisionCheckResult,
): string | undefined {
  if (r.status === 'ok' || r.status === 'available') return undefined
  if (r.status === 'unavailable') return r.reason
  return `The base ROM ${r.baseRom.title} is not on this machine`
}

type BlockContents = Extract<MapBlockContentsResult, { status: 'ok' }> & {
  decoded: Map<string, Uint8ClampedArray>
}
/** The sprite canvases' key in place of a plane's: one per screen, between L2 and L1's priority plane. */
const SPRITES = 'sprites'
/** Each screen's display canvas: the screen at screen resolution when it holds indicators (#566). */
const DISPLAY = 'display'
type LayerKey = MapPlaneKey | typeof SPRITES | typeof DISPLAY
type Palace = keyof SwitchFlagsDto
type Switch = keyof SwitchStateDto

const ZOOMS = [1, 2, 3, 4]
/** Screens fetched beyond each edge of the view. */
const MARGIN = 1
const ICON_FRAME = { width: TILE_PX, height: TILE_PX }

type PalaceIcon = { uncleared: FrameImage; cleared: FrameImage } | { reason: string }

/** Runs `run` after every commit, placed after the strip: a backstop for `sync`. */
function AfterCommit({ run }: { run: () => void }): null {
  React.useLayoutEffect(run)
  return null
}

const palaceName = (p: Palace) => p[0]!.toUpperCase() + p.slice(1)

@injectable()
export class MapViewWidget extends ReactWidget implements ProjectBound {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  protected options: MapViewOptions | undefined

  readonly projectBound = true as const
  /** Closed by the shell when another project opens (#628). */
  get manifestPath(): string | undefined {
    return this.options?.manifestPath
  }
  protected details: MapDetailsDto | undefined
  protected error: string | undefined
  protected mapLayout: Layout | undefined
  protected screenError: string | undefined
  /** Each palace's block, decoded once per load, or why it cannot be drawn. */
  protected icons = new Map<Palace, PalaceIcon>()

  /** The palaces and switches, this tab's own; buttons dispatch, consumers subscribe (see `init`). */
  protected readonly view = new MapViewStateStore()
  /** The switch toggles' art (#574's), and why a kind has none. */
  protected switchArt: Partial<Record<Switch, SwitchButtonImages>> = {}
  protected switchWhy: Partial<Record<Switch, string>> = {}
  /** L1 (foreground) and L2 (background) shown; off leaves what is beneath them. */
  protected showL1 = true
  protected showL2 = true
  /** The tile / sub-screen / screen grid; off by default. */
  protected showGrid = false
  protected showL3 = true
  protected showSprites = true
  /** The map's sprites (#564), once read; `spritesWhy` is why there are none to show. */
  protected sprites: Sprites | undefined
  protected spritesWhy: string | undefined
  /** Bumped when `sprites` is replaced, so a canvas painted from the old ones is repainted. */
  protected spritesVersion = 0
  /** The collision overlay (#435); off by default. */
  protected showCollision = false
  /** The map's collision lines once read; `collisionWhy` is why there are none to show. */
  protected collision: Collision | undefined
  protected collisionWhy: string | undefined
  /** The state key a probe's refusal was for; undefined when the cheap check refused (true of the map, whatever the state). */
  protected collisionWhyKey: string | undefined
  /** The state key `collision` was probed for. */
  protected collisionKey: string | undefined
  /** The cheap check or a probe has answered for this map; a probe's answer is the authority over the check's. */
  protected collisionChecked = false
  protected collisionProbed = false
  /** Bumped per probe request: a reply for an older palace or P-switch state is dropped. */
  protected collisionSeq = 0
  /** Replies taken, for the overlay's test hook. */
  protected collisionRevision = 0
  /** Block content indicators (#566), once read; `blocksWhy` is why there are none to show. */
  protected blocks: BlockContents | undefined
  protected blocksWhy: string | undefined
  protected blocksVersion = 0
  /** The indicator under the pointer: it fills its block, the rest sit in their quadrants. */
  protected hover: Indicator | undefined
  /** Fit mode until the user zooms; the fit is the cross axis filling the view (#526). */
  protected readonly zoomController = new ZoomController(ZOOMS, 1, () => this.measureFit())
  protected wheelBinding: WheelBinding | undefined
  /** The zoom the last `render()` laid the strip out at. */
  protected renderedZoom = 0
  protected readonly screens = new Map<string, ScreenImages>()
  protected readonly pending = new Set<string>()
  /** Keyed `<plane>:<screen>`. */
  protected readonly canvases = new Map<string, HTMLCanvasElement>()
  protected readonly canvasRefs = new Map<string, (el: HTMLCanvasElement | null) => void>()
  /** The composite canvas of each screen (what the user sees), keyed by screen index. */
  protected readonly composites = new Map<number, HTMLCanvasElement>()
  protected readonly compositeRefs = new Map<number, (el: HTMLCanvasElement | null) => void>()
  protected scroller: HTMLDivElement | null = null
  /** Refits when the strip's box changes, e.g. when the facts line arrives above it. */
  protected readonly resizes = new ResizeObserver(() => this.fitStrip())
  /** Bumped on every invalidation, so a reply to an older request is dropped. */
  protected generation = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map-view')
    this.title.closable = true
    this.node.tabIndex = 0
    this.toDispose.push({ dispose: () => this.resizes.disconnect() })
    this.toDispose.push(this.view)
    // Three consumers of one store, each deciding for itself.
    this.toDispose.push(
      // The toolbar: aria-pressed and the palace art follow the state.
      this.view.onDidChange(() => this.update()),
    )
    this.toDispose.push(
      // Layer 1: the screens in view are drawn for the new state.
      this.view.onDidChange(() => this.requestVisible()),
    )
    this.toDispose.push(
      // The collision overlay: the palaces and the blue P-switch change the map's tiles, so its lines.
      // On: ask again (a reply for an older state is dropped). Off: the lines are stale, the next press fetches.
      this.view.onDidChange(c => {
        const plan = collisionPlan(c, this.showCollision, this.collisionWhyKey !== undefined)
        if (plan.drop) {
          this.collisionSeq++ // a reply still on its way is for the old state
          this.collision = undefined
        }
        if (plan.recheck) {
          // The refusal was for the old state: the toggle is enabled again until the cheap check says otherwise.
          this.collisionWhy = undefined
          this.collisionWhyKey = undefined
          this.collisionProbed = false // so the check's answer is taken, not dropped for the probe's
          void this.checkCollision()
        }
        if (plan.refetch) void this.loadCollision()
      }),
    )
    this.zoomController.centreAnchored = true
    this.toDispose.push(this.zoomController)
    this.toDispose.push({ dispose: () => this.wheelBinding?.dispose() })
    this.toDispose.push(
      this.zoomController.onDidChange(() => {
        this.update()
        requestAnimationFrame(() => {
          this.requestVisible()
          this.updateHover()
        })
      }),
    )
    this.zoomController.enterFit()
    this.toDispose.push(
      this.projectContext.onEdit(event => {
        if (event.subject === this.options?.manifestPath) this.refresh()
      }),
    )
    this.toDispose.push(
      this.projectContext.onRomChanged(manifestPath => {
        if (manifestPath === this.options?.manifestPath) this.refresh()
      }),
    )
  }

  async open(options: MapViewOptions): Promise<void> {
    perfStart('open-maps')
    this.options = options
    this.id = `${MAP_VIEW_ID}:${options.index}`
    this.title.label = options.label
    this.title.caption = `${options.label} (${slotLabel(options.index)})`
    this.title.iconClass = options.iconClass ?? 'codicon codicon-map'
    this.details = undefined
    this.error = undefined
    this.mapLayout = undefined
    this.sprites = undefined
    this.spritesWhy = undefined
    this.collision = undefined
    this.collisionWhy = undefined
    this.collisionWhyKey = undefined
    this.collisionKey = undefined
    this.collisionChecked = false
    this.collisionProbed = false
    this.blocks = undefined
    this.blocksWhy = undefined
    this.hover = undefined
    // A new map opens fitted, whatever zoom the last one was left at.
    this.zoomController.enterFit()
    // A reused (preview) tab keeps its strip across maps: blank it, and start at screen 0.
    // The composites too: they are what is on screen, and paintComposite leaves a canvas alone
    // until its screen has arrived.
    for (const c of [...this.canvases.values(), ...this.composites.values()]) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
      delete c.dataset.drawn
    }
    this.scroller?.scrollTo(0, 0)
    this.update()
    this.refresh()
  }

  /** Which slot this tab currently shows, so a pin can retire the preview of it. */
  shows(index: number): boolean {
    return this.options?.index === index
  }

  protected get zoom(): number {
    return this.zoomController.value
  }

  /** Drops every cached screen and reads the map again from the working copy. */
  protected refresh(): void {
    this.generation++
    this.screens.clear()
    this.pending.clear()
    this.screenError = undefined
    void this.loadDetails()
    void this.loadIcons()
    // Old indicators must not stay up as a picture of the edited map.
    this.blocks = undefined
    this.hover = undefined
    this.blocksVersion++
    void this.loadSprites()
    // The probe runs the ROM's code: it runs only while the overlay is on. Off, an edit drops the stale
    // lines and the toggle's refusal is re-read (a cheap check, no probe); the next press fetches.
    if (this.showCollision) void this.loadCollision()
    else {
      this.collision = undefined
      this.collisionProbed = false
      void this.checkCollision()
    }
    void this.loadBlocks()
    this.requestVisible()
  }

  /** Whether collision can be probed for this map at all, without probing: the toggle's enabled state. */
  protected async checkCollision(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapCollisionCheck(o.manifestPath, o.index)
      .catch(err => ({ status: 'unavailable' as const, reason: (err as Error).message }))
    // A probe that already answered knows more than the check: a late `available` must not undo its refusal.
    if (generation !== this.generation || this.collisionProbed) return
    this.setCollisionWhy(collisionWhyNot(r))
    this.update()
  }

  protected async loadCollision(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const seq = ++this.collisionSeq
    const { flags, switches } = this.view.state
    const key = collisionKey(this.view.state)
    const r = await this.projects
      .mapCollision(o.manifestPath, o.index, flags, switches)
      .catch(err => ({ status: 'unavailable' as const, reason: (err as Error).message }))
    // An older map's or edit's lines must not land over a newer one.
    if (generation !== this.generation || seq !== this.collisionSeq) return
    // The working copy moved on under the probe; its push is on the way and will ask again.
    if (r.status === 'stale') return
    this.collision = r.status === 'ok' ? r : undefined
    this.collisionKey = key
    this.collisionRevision++
    this.collisionProbed = true
    this.setCollisionWhy(collisionWhyNot(r), key)
    this.update()
  }

  /** A refusal turns the overlay off, so a disabled toggle never looks pressed and nothing is left to switch off. */
  protected setCollisionWhy(why: string | undefined, probedFor?: string): void {
    this.collisionWhy = why
    this.collisionWhyKey = why ? probedFor : undefined
    this.collisionChecked = true
    if (why) this.showCollision = false
  }

  protected async loadSprites(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapSprites(o.manifestPath, o.index)
      .catch(err => ({ status: 'unavailable' as const, reason: (err as Error).message }))
    // An older map's or edit's sprites must not land over a newer one.
    if (generation !== this.generation) return
    this.sprites = r.status === 'ok' ? r : undefined
    this.spritesWhy = r.status === 'ok' ? undefined : r.status === 'unavailable' ? r.reason : `The base ROM ${r.baseRom.title} is not on this machine` // prettier-ignore
    this.spritesVersion++
    this.update()
    this.sync()
  }

  protected async loadBlocks(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapBlockContents(o.manifestPath, o.index)
      .catch(err => ({ status: 'unavailable' as const, reason: (err as Error).message }))
    if (generation !== this.generation) return
    this.blocks = r.status === 'ok' ? { ...r, decoded: decodeArts(r.arts) } : undefined
    this.blocksWhy =
      r.status === 'ok'
        ? r.note
        : r.status === 'unavailable'
          ? `Block contents are not drawn: ${r.reason}`
          : `Block contents are not drawn: the base ROM ${r.baseRom.title} is not on this machine`
    this.blocksVersion++
    this.update()
    this.updateHover()
    this.sync()
  }

  protected async loadDetails(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    let details: MapDetailsDto | undefined
    let error: string | undefined
    try {
      details = await this.projects.mapDetails(o.manifestPath, o.index)
    } catch (err) {
      error = (err as Error).message
    }
    // An older map's or edit's reply must not land over a newer one.
    if (generation !== this.generation) return
    this.details = details
    this.error = error
    this.update()
  }

  protected async loadIcons(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapPalaceIcons(o.manifestPath, o.index)
      .catch(err => ({ status: 'unavailable' as const, reason: (err as Error).message }))
    // An older map's or edit's art must not land over a newer one.
    if (generation !== this.generation) return
    const image = (b64: string): FrameImage => ({ width: 16, height: 16, rgba: decodeRgba(b64) })
    const why = r.status === 'ok' ? undefined : r.status === 'unavailable' ? r.reason : `The base ROM ${r.baseRom.title} is not on this machine` // prettier-ignore
    this.icons = new Map(
      PALACES.map((p): [Palace, PalaceIcon] => {
        const i = r.status === 'ok' ? r.icons.find(x => x.palace === p) : undefined
        if (i && 'cleared' in i) return [p, { uncleared: image(i.uncleared), cleared: image(i.cleared) }] // prettier-ignore
        return [p, { reason: i && 'unavailable' in i ? i.unavailable : (why ?? 'no art') }]
      }),
    )
    const art = r.status === 'ok' ? r.switchArt : {}
    this.switchArt = Object.fromEntries(SWITCH_ORDER.filter(k => art[k]).map(k => [k, decodeSwitchButton(art[k]!, decodeRgba)])) // prettier-ignore
    this.switchWhy = r.status === 'ok' ? r.switchUnavailable : Object.fromEntries(SWITCH_ORDER.map(k => [k, why])) // prettier-ignore
    this.update()
  }

  protected key(screen: number): string {
    return screenKey(this.view.state.flags, this.view.state.switches, screen)
  }

  /** The screens in view, plus MARGIN either side; screen 0 before the layout is known. */
  protected visibleScreens(): number[] {
    const l = this.mapLayout
    if (!l) return [0]
    const vertical = l.orientation === 'vertical'
    const size = (vertical ? l.height : l.width) * this.zoom
    const el = this.scroller
    const pos = el ? (vertical ? el.scrollTop : el.scrollLeft) : 0
    const view = (el && (vertical ? el.clientHeight : el.clientWidth)) || size
    const first = Math.max(0, Math.floor(pos / size) - MARGIN)
    const last = Math.min(l.screenCount - 1, Math.floor((pos + view - 1) / size) + MARGIN)
    return Array.from({ length: last - first + 1 }, (_, i) => first + i)
  }

  protected requestVisible(): void {
    this.sync()
    for (const s of this.visibleScreens()) void this.fetchScreen(s)
  }

  protected async fetchScreen(screen: number): Promise<void> {
    const o = this.options
    const key = this.key(screen)
    if (!o || this.screens.has(key) || this.pending.has(key)) return
    this.pending.add(key)
    const generation = this.generation
    let r: MapScreenResult
    try {
      r = await this.projects.mapScreen(o.manifestPath, o.index, screen, this.view.state.flags, this.view.state.switches) // prettier-ignore
    } catch (err) {
      r = { status: 'unavailable', reason: (err as Error).message }
    }
    if (generation !== this.generation) return
    this.pending.delete(key)

    if (r.status !== 'ok') {
      this.screenError =
        r.status === 'rom-not-located'
          ? `The base ROM ${r.baseRom.title} is not on this machine.`
          : r.reason
      this.sync()
      this.update()
      return
    }
    const image = (b64: string | null) =>
      b64 === null ? null : new ImageData(decodeRgba(b64), r.width, r.height)
    this.screens.set(key, {
      width: r.width,
      height: r.height,
      planes: Object.fromEntries(
        MAP_PLANE_KEYS.map(k => [k, image(r.planes[k])]),
      ) as ScreenImages['planes'],
      screens: r.screens,
      math: r.math,
    })
    const l = this.mapLayout
    if (
      !l ||
      l.screenCount !== r.screenCount ||
      l.orientation !== r.orientation ||
      l.note !== r.note ||
      l.layerNotes.join() !== r.layerNotes.join() ||
      JSON.stringify([l.layer3, l.screens, l.math, l.layer2Interactive]) !==
        JSON.stringify([r.layer3, r.screens, r.math, r.layer2Interactive]) ||
      l.backdrop.join() !== r.backdrop.join()
    ) {
      // The first reply sizes the strip; the screens in view follow once it is laid out.
      this.mapLayout = r
      this.update()
      requestAnimationFrame(() => this.fitStrip())
    }
    if (this.screenError) {
      this.screenError = undefined
      this.update()
    }
    this.sync()
  }

  /**
   * After a React commit only: the strip now has its new zoom's size, so the
   * wheel/centre anchor can be put back. `sync` also runs from scrolls and
   * replies, where restoring early would consume the anchor too soon.
   */
  protected readonly afterCommit = (): void => {
    // Only a commit that shows the CURRENT zoom: an older one still has the
    // old layout, and restoring on it would consume the anchor early.
    if (this.renderedZoom === this.zoomController.value) this.wheelBinding?.restoreAnchor()
    this.sync()
  }

  /**
   * Brings every canvas to what it should show, whatever event asked: the
   * cached picture for the current state. A toggle or an edit keeps the
   * current picture up until the new one lands, with no blank flash; only a
   * failed reply clears (and `open`, so a reused tab never shows the old
   * map). It owns the canvas size, so no React commit can clear a painted
   * canvas; `data-drawn` records only what a canvas was painted with.
   */
  protected readonly sync = (): void => {
    for (const [k, canvas] of this.canvases) {
      const [plane, s] = k.split(':') as [LayerKey, string]
      if (plane === DISPLAY) continue
      if (plane === SPRITES) {
        this.syncSprites(canvas, Number(s))
        continue
      }
      const want = `${this.generation}:${this.key(Number(s))}`
      if (canvas.dataset.drawn === want) continue
      const shot = this.screens.get(this.key(Number(s)))
      if (shot) {
        if (canvas.width !== shot.width) canvas.width = shot.width
        if (canvas.height !== shot.height) canvas.height = shot.height
        const ctx = canvas.getContext('2d')
        const img = shot.planes[plane]
        if (img) ctx?.putImageData(img, 0, 0)
        else ctx?.clearRect(0, 0, canvas.width, canvas.height)
        canvas.dataset.drawn = want
        perfEnd('open-maps')
      } else if (this.screenError && canvas.dataset.drawn) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        delete canvas.dataset.drawn
      }
    }
    for (const [s, canvas] of this.composites) this.paintComposite(s, canvas)
    for (const [k, canvas] of this.canvases)
      if (k.startsWith(`${DISPLAY}:`)) this.syncDisplay(canvas, Number(k.split(':')[1]))
  }

  /**
   * One screen's picture: the plane canvases' pixels, composited per SNES screen with color
   * math (#562). Redone on every layer toggle, since a toggle changes both plane lists.
   */
  protected paintComposite(s: number, canvas: HTMLCanvasElement): void {
    const shot = this.screens.get(this.key(s))
    if (!shot) {
      if (this.screenError && canvas.dataset.drawn) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        delete canvas.dataset.drawn
      }
      return
    }
    const want = `${this.generation}:${this.key(s)}:${+this.showL1}${+this.showL2}${+this.showL3}${+this.showSprites}:${this.spritesVersion}`
    if (canvas.dataset.drawn === want) return
    canvas.width = shot.width
    canvas.height = shot.height
    const planes = this.shownPlanes(s, shot)
    const out = composeScreen({
      width: shot.width,
      height: shot.height,
      planes,
      lists: shot.screens,
      math: shot.math,
    })
    canvas.getContext('2d')?.putImageData(new ImageData(out, shot.width, shot.height), 0, 0)
    canvas.dataset.drawn = want
  }

  /** The sources a screen composes: a hidden layer's plane is left out (not empty), so its indicators go with it. */
  protected shownPlanes(
    s: number,
    shot: ScreenImages,
  ): Partial<Record<SourceKey, Uint8ClampedArray | null>> {
    // prettier-ignore
    const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = {}
    for (const k of MAP_PLANE_KEYS) if (this.layerShown(k)) planes[k] = shot.planes[k]?.data ?? null
    // The sprites are one more source, not in color math (their palette split is #564's to add).
    const sp = this.sprites
    if (this.showSprites) planes.sprites = sp ? compositeSpriteScreen(sp.sprites, s, sp) : null
    return planes
  }

  /** Each screen's picture at screen resolution, while it holds indicators: built once, then only hover cells are redone. */
  protected readonly displays = new Map<number, { want: string; display: IndicatorDisplay }>()

  /**
   * The display canvas of screen `s` covers the native composite, which stays untouched, with the same
   * picture at the zoom and the indicators drawn in their planes (`IndicatorDisplay`). `data-indicators`
   * records the boxes it painted. A screen with none shows the composite itself.
   */
  protected syncDisplay(canvas: HTMLCanvasElement, s: number): void {
    const [comp, shot, b] = [this.composites.get(s), this.screens.get(this.key(s)), this.blocks]
    const hide = () => {
      this.displays.delete(s)
      if (canvas.width !== 0) canvas.width = 0
      delete canvas.dataset.drawn
      canvas.dataset.indicators = '[]'
      if (comp) comp.style.visibility = ''
    }
    if (!comp?.dataset.drawn || !shot || !b) return hide()
    const want = `${comp.dataset.drawn}:${this.blocksVersion}:${this.zoom}`
    let cur = this.displays.get(s)
    if (cur?.want !== want) {
      const display = new IndicatorDisplay({
        width: shot.width,
        height: shot.height,
        zoom: this.zoom,
        screen: s,
        geometry: b,
        planes: this.shownPlanes(s, shot),
        lists: shot.screens,
        math: shot.math,
        base: comp.getContext('2d')!.getImageData(0, 0, comp.width, comp.height).data,
        indicators: b.indicators,
        arts: b.decoded,
      }, this.hoverOn(s) && indicatorId(this.hoverOn(s)!)) // prettier-ignore
      if (!display.touches) return hide()
      canvas.width = display.width
      canvas.height = display.height
      canvas
        .getContext('2d')
        ?.putImageData(new ImageData(display.image, display.width, display.height), 0, 0)
      this.displays.set(s, (cur = { want, display }))
    } else {
      const hov = this.hoverOn(s)
      for (const r of cur.display.setHover(hov && indicatorId(hov))) {
        canvas.getContext('2d')?.putImageData(new ImageData(r.rgba, r.width, r.height), r.x, r.y)
      }
    }
    canvas.dataset.drawn = want
    canvas.dataset.indicators = JSON.stringify(cur.display.records())
    comp.style.visibility = 'hidden'
  }

  /** The hovered indicator, when its block touches screen `s`. */
  protected hoverOn(s: number): Indicator | undefined {
    const h = this.hover
    const b = this.blocks
    if (!h || !b) return undefined
    const [size, at] = b.orientation === 'vertical' ? [b.height, h.y] : [b.width, h.x]
    return at + 16 > s * size && at < (s + 1) * size ? h : undefined
  }

  /** The pointer's client position over the strip, kept so a scroll or zoom can re-find the block under it. */
  protected pointer: { x: number; y: number } | undefined

  protected readonly onPointerMove = (e: React.MouseEvent): void => {
    this.pointer = { x: e.clientX, y: e.clientY }
    this.updateHover()
  }

  /** Finds the topmost visible block under the pointer; run on moves, scrolls, zooms and new replies. */
  protected updateHover(): void {
    const strip = this.scroller?.querySelector<HTMLElement>('.hb-map-view-strip')
    const l = this.mapLayout
    const p = this.pointer
    if (!strip || !l || !this.blocks || !p) return this.setHover(undefined)
    const r = strip.getBoundingClientRect()
    const [x, y] = [(p.x - r.left) / this.zoom, (p.y - r.top) / this.zoom]
    const order = this.layerOrder(l)
    const shown = (q: Indicator['plane']) => order.includes(q) && this.layerShown(q)
    this.setHover(hoverTarget(this.blocks.indicators, x, y, shown, q => order.indexOf(q)) ?? undefined) // prettier-ignore
  }

  protected setHover(next: Indicator | undefined): void {
    if ((next && indicatorId(next)) === (this.hover && indicatorId(this.hover))) return
    this.hover = next
    this.sync()
  }

  protected compositeRef(s: number): (el: HTMLCanvasElement | null) => void {
    let ref = this.compositeRefs.get(s)
    if (!ref) {
      let mine: HTMLCanvasElement | null = null
      ref = el => {
        if (el) {
          mine = el
          this.composites.set(s, el)
          this.sync()
        } else {
          if (this.composites.get(s) === mine) this.composites.delete(s)
          mine = null
        }
      }
      this.compositeRefs.set(s, ref)
    }
    return ref
  }

  /** The sprite canvas of one screen: the map's sprites cut to it, or blank when none reach it. */
  protected syncSprites(canvas: HTMLCanvasElement, screen: number): void {
    paintSpriteCanvas(canvas, this.sprites, screen, `${this.generation}:${this.spritesVersion}`)
  }

  /**
   * One stable ref per screen: React calls it only when that screen's canvas
   * mounts or unmounts, and on unmount it removes only its own canvas, never
   * a replacement. A new canvas starts blank, so it is synced at once (#421).
   */
  protected canvasRef(plane: LayerKey, s: number): (el: HTMLCanvasElement | null) => void {
    const k = `${plane}:${s}`
    let ref = this.canvasRefs.get(k)
    if (!ref) {
      let mine: HTMLCanvasElement | null = null
      ref = el => {
        if (el) {
          mine = el
          this.canvases.set(k, el)
          this.sync()
        } else {
          if (this.canvases.get(k) === mine) this.canvases.delete(k)
          mine = null
        }
      }
      this.canvasRefs.set(k, ref)
    }
    return ref
  }

  /** The zoom at which the map's cross axis fills the view; undefined until measurable. */
  protected measureFit(): number | undefined {
    const l = this.mapLayout
    const el = this.scroller
    if (!l || !el) return undefined
    const vertical = l.orientation === 'vertical'
    const avail = vertical ? el.clientWidth : el.clientHeight
    if (avail <= 0) return undefined
    return Math.min(4, Math.max(0.25, avail / (vertical ? l.width : l.height)))
  }

  /** Refits while in fit mode; always asks for the screens now in view. */
  protected fitStrip(): void {
    this.zoomController.refit()
    requestAnimationFrame(() => this.requestVisible())
  }

  protected togglePalace(palace: Palace): void {
    this.view.dispatch({ type: 'togglePalace', palace })
  }

  protected toggleSwitch(key: Switch): void {
    this.view.dispatch({ type: 'toggleSwitch', key })
  }

  protected toggleL1(): void {
    this.showL1 = !this.showL1
    this.update()
    this.sync()
  }

  toggleGrid(): void {
    this.showGrid = !this.showGrid
    this.update()
  }

  /** Shows or hides the collision overlay (`hackbench.maps.toggleCollision`); a refused map stays off. */
  toggleCollision(): void {
    if (this.collisionWhy) return
    this.showCollision = !this.showCollision
    this.collisionSeq++ // off: a reply still on its way is not wanted; on: it is asked for afresh below
    if (this.showCollision && !this.collisionCurrent()) void this.loadCollision()
    this.update()
  }

  /** The lines, when they are for the state the toolbar shows now. */
  protected collisionCurrent(): Collision | undefined {
    return this.collisionKey === collisionKey(this.view.state) ? this.collision : undefined
  }

  /** Whether the collision toggle can be used: what `hackbench.maps.toggleCollision` and the button share. */
  get canToggleCollision(): boolean {
    return !this.collisionWhy
  }

  /** The collision toggle's tooltip: what pressing it does, or why it cannot. */
  protected collisionLabel(): string {
    if (this.collisionWhy) return `Collision unavailable: ${this.collisionWhy}`
    if (this.showCollision)
      return this.collisionCurrent() ? 'Hide collision' : 'Collision · reading the map'
    return 'Show collision'
  }

  protected toggleL2(): void {
    this.showL2 = !this.showL2
    this.update()
    this.sync()
  }

  protected toggleL3(): void {
    this.showL3 = !this.showL3
    this.update()
    this.sync()
  }

  protected toggleSprites(): void {
    this.showSprites = !this.showSprites
    this.update()
    this.sync()
  }

  /** The sprite toggle's tooltip: "Sprites" when it works, else why it does not. */
  protected spritesLabel(): string {
    if (this.spritesWhy) return `Sprites unavailable: ${this.spritesWhy}`
    if (!this.sprites) return 'Sprites · reading the map'
    if (this.sprites.sprites.length === 0) return 'Sprites · this map has none'
    const u = this.sprites.sprites.find(x => x.unverified)?.unverified
    return u ? `Sprites · unverified: ${u}` : 'Sprites'
  }

  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg)
    this.fitStrip()
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  /** Layer 3's tooltip: its role when drawn (the header's priority bit), else why it is not. */
  protected layer3Label(): string {
    const l3 = this.mapLayout?.layer3
    if (!l3) return 'Layer 3 · reading the map'
    return l3.reason ?? (l3.priority ? 'Layer 3 · Overlay' : 'Layer 3 · Background')
  }

  protected render(): React.ReactNode {
    this.renderedZoom = this.zoomController.value
    return (
      <div className="hb-map-view-main">
        <div className="hb-map-view-toolbar">
          <LayerToggle
            glyph="1"
            label="Layer 1 · Foreground"
            pressed={this.showL1}
            control="layer-l1"
            onClick={() => this.toggleL1()}
          />
          <LayerToggle
            glyph="2"
            label={layer2Label(this.mapLayout)}
            pressed={this.showL2}
            control="layer-l2"
            onClick={() => this.toggleL2()}
          />
          <LayerToggle
            glyph="3"
            label={this.layer3Label()}
            pressed={this.showL3 && !this.mapLayout?.layer3.reason}
            disabled={!this.mapLayout || !!this.mapLayout.layer3.reason}
            control="layer-l3"
            onClick={() => this.toggleL3()}
          />
          <LayerToggle
            glyph="S"
            label={this.spritesLabel()}
            pressed={this.showSprites && !!this.sprites?.sprites.length}
            disabled={!this.sprites?.sprites.length}
            control="layer-sprites"
            onClick={() => this.toggleSprites()}
          />
          <button
            data-control="collision-toggle"
            type="button"
            className={
              'hb-icon-btn' + (this.showCollision ? ' hb-icon-btn-on' : ' hb-icon-btn-off')
            }
            data-collision-state={
              !this.collisionChecked ? 'checking' : this.collisionWhy ? 'refused' : 'ready'
            }
            aria-pressed={this.showCollision}
            disabled={!this.canToggleCollision}
            title={this.collisionLabel()}
            aria-label={this.collisionLabel()}
            onClick={() => this.toggleCollision()}
          >
            <span className="codicon codicon-layout-panel-dock" />
          </button>
          <span className="hb-toolbar-sep" data-control="toolbar-sep" />
          {PALACES.map(p => this.renderToggle(p))}
          {SWITCH_ORDER.map(k => (
            <SwitchToggle
              key={k}
              kind={k}
              images={this.switchArt[k]}
              pressed={this.view.state.switches[k]}
              reason={this.switchWhy[k]}
              scale={1}
              data={{ control: `switch-${k}` }}
              onClick={() => this.toggleSwitch(k)}
            />
          ))}
          <span className="hb-toolbar-spacer" />
          {isUnverifiedMode(this.details?.levelMode) && (
            <span
              className="hb-map-view-mode-warning"
              data-control="unverified-mode"
              title="Sprites in this mode may draw in the wrong order. This mode has not been checked against the game."
            >
              <span className="codicon codicon-warning" />
              {`Level mode ${this.details!.levelMode!.toString(16).toUpperCase().padStart(2, '0')}: sprite layering not verified`}
            </span>
          )}
          <button
            data-control="grid-toggle"
            type="button"
            className={'hb-icon-btn' + (this.showGrid ? ' hb-icon-btn-on' : ' hb-icon-btn-off')}
            aria-pressed={this.showGrid}
            title={this.showGrid ? 'Hide grid' : 'Show grid'}
            aria-label={this.showGrid ? 'Hide grid' : 'Show grid'}
            onClick={() => this.toggleGrid()}
          >
            <span className="codicon codicon-table" />
          </button>
          <ZoomStepper controller={this.zoomController} fitControls />
        </div>
        {this.renderFacts()}
        {this.mapLayout?.note && (
          <div className="hb-map-view-note" data-control="map-note">
            {this.mapLayout.note}
          </div>
        )}
        {this.screenError && this.mapLayout && (
          <div className="hb-map-view-note hb-map-view-error" data-control="map-error">
            {this.screenError}
          </div>
        )}
        {this.sprites?.note && (
          <div className="hb-map-view-note" data-note="sprites">
            {this.sprites.note}
          </div>
        )}
        {this.blocksWhy && (
          <div className="hb-map-view-note" data-note="block-contents">
            {this.blocksWhy}
          </div>
        )}
        {this.mapLayout?.layerNotes.map(n => (
          <div key={n} className="hb-map-view-note" data-note="layers">
            {n}
          </div>
        ))}
        {this.renderStrip()}
        <AfterCommit run={this.afterCommit} />
        <details className="hb-map-view-header" data-control="header-panel">
          <summary>Header</summary>
          {this.renderDecode()}
        </details>
      </div>
    )
  }

  protected renderToggle(p: Palace): React.ReactNode {
    const icon = this.icons.get(p)
    const pressed = this.view.state.flags[p]
    return (
      <PixelImageButton
        key={p}
        frame={ICON_FRAME}
        scale={1}
        image={icon && 'cleared' in icon ? (pressed ? icon.cleared : icon.uncleared) : undefined}
        label={`${palaceName(p)} switch palace`}
        reason={icon && 'reason' in icon ? icon.reason : undefined}
        pressed={pressed}
        onClick={() => this.togglePalace(p)}
        data={{ control: `palace-${p}` }}
      />
    )
  }

  /**
   * One stable ref: an inline arrow is re-called (null, then the element) on
   * every render, which would rebuild the wheel binding and drop its pending
   * anchor between the zoom and the commit that restores it.
   */
  protected readonly scrollerRef = (el: HTMLDivElement | null): void => {
    if (el === this.scroller) return
    if (this.scroller) this.resizes.unobserve(this.scroller)
    this.scroller = el
    // The grid overlay takes the scroller as a prop and the ref lands after the commit.
    if (this.showGrid) queueMicrotask(() => this.update())
    this.wheelBinding?.dispose()
    this.wheelBinding = undefined
    if (el) {
      this.resizes.observe(el)
      // Anchored on the strip: it scrolls with the content, unlike the scroller.
      this.wheelBinding = this.zoomController.bindWheel(el, () =>
        el.querySelector<HTMLElement>('.hb-map-view-strip'),
      )
    }
  }

  protected renderStrip(): React.ReactNode {
    const l = this.mapLayout
    if (!l) {
      return this.screenError ? (
        <div className="hb-map-view-error" data-control="map-error">
          {this.screenError}
        </div>
      ) : (
        <div className="hb-map-view-empty">Reading the ROM...</div>
      )
    }
    return (
      <div className="hb-map-grid-host">
        <div
          className={'hb-map-view-scroller' + (l.orientation === 'vertical' ? ' hb-vertical' : '')}
          data-control="map-scroller"
          ref={this.scrollerRef}
          onScroll={() => {
            this.requestVisible()
            this.updateHover()
          }}
          onMouseMove={this.onPointerMove}
          onMouseLeave={() => {
            this.pointer = undefined
            this.setHover(undefined)
          }}
        >
          {/* Bottom to top (planes by `screens`, composited per screen): the checkerboard, the back area, then the screens,
              so hiding a layer shows what is under it, down to nothing. */}
          <div className="hb-map-view-strip hb-checkerboard">
            <div
              className="hb-map-view-back-area"
              data-layer="back-area"
              style={{ background: `rgb(${l.backdrop.join(',')})` }}
            />
            {Array.from({ length: l.screenCount }, (_, s) => (
              <div
                key={s}
                className="hb-map-view-screen"
                style={{ width: l.width * this.zoom, height: l.height * this.zoom }}
              >
                {([...MAP_PLANE_KEYS, SPRITES] as LayerKey[]).map(plane => {
                  const z = this.layerOrder(l).indexOf(plane) + 1
                  return (
                    // The plane canvases are the compositor's source, never seen: opacity 0, not
                    // display none, so a plane in no list or toggled off still reads as hidden.
                    <canvas
                      key={plane}
                      className="hb-map-view-plane"
                      data-plane={plane}
                      data-screen={s}
                      style={{
                        zIndex: z,
                        opacity: 0,
                        visibility: z > 0 && this.layerShown(plane) ? undefined : 'hidden',
                      }}
                      ref={this.canvasRef(plane, s)}
                    />
                  )
                })}
                <canvas
                  className="hb-map-view-plane hb-map-view-composite"
                  data-layer="screen"
                  data-screen={s}
                  style={{ zIndex: 100 }}
                  ref={this.compositeRef(s)}
                />
                <canvas
                  className="hb-map-view-plane hb-map-view-composite"
                  data-layer="display"
                  data-screen={s}
                  style={{ zIndex: 101 }}
                  ref={this.canvasRef(DISPLAY, s)}
                />
              </div>
            ))}
            {this.showCollision && this.collisionCurrent() && (
              <CollisionOverlay
                layer={this.collisionCurrent()!}
                zoom={this.zoom}
                owner={String(this.options?.index ?? '')}
                revision={this.collisionRevision}
              />
            )}
          </div>
        </div>
        {this.showGrid && (
          <MapGridOverlay
            scroller={this.scroller}
            vertical={l.orientation === 'vertical'}
            screenCount={l.screenCount}
            zoom={this.zoom}
          />
        )}
      </div>
    )
  }

  /** The sources bottom to top over both screens (sprites included: `screenPlanes` places them), for stacking the source canvases. */
  protected layerOrder(l: Layout): LayerKey[] {
    return [...l.screens.sub, ...l.screens.main]
  }

  protected layerShown(plane: LayerKey): boolean {
    if (plane === SPRITES) return this.showSprites
    return plane.startsWith('l2') ? this.showL2 : plane.startsWith('l3') ? this.showL3 : this.showL1
  }

  /** What a reader wants at a glance: which map, how big, and what is unavailable and why. */
  protected renderFacts(): React.ReactNode {
    if (this.error) {
      return (
        <div className="hb-map-view-body hb-map-view-facts hb-map-view-error">{this.error}</div>
      )
    }
    const d = this.details
    if (!d) return null
    const title = (
      <h2 className="hb-map-view-title">
        <span className="hb-map-slot">{slotLabel(d.index)}</span>
        {d.name ? (
          <span className="hb-map-name">{d.name}</span>
        ) : d.nameUnavailable ? (
          <span title={d.nameUnavailable}>name unavailable</span>
        ) : null}
      </h2>
    )
    if (d.levelDataUnavailable) {
      return (
        <div className="hb-map-view-body hb-map-view-facts">
          {title}
          <div className="hb-map-view-summary">
            <span title={d.levelDataUnavailable}>level data unavailable</span>
          </div>
        </div>
      )
    }
    return (
      <div className="hb-map-view-body hb-map-view-facts">
        {title}
        <div className="hb-map-view-summary">
          {d.screens} screens,{' '}
          {d.isVertical !== undefined ? (
            d.isVertical ? (
              'vertical'
            ) : (
              'horizontal'
            )
          ) : (
            <span title={d.orientationUnavailable}>orientation unavailable</span>
          )}
          {' · '}
          {d.objectCount !== undefined ? (
            `${d.objectCount} objects`
          ) : (
            <span title={d.objectsUnavailable}>objects unavailable</span>
          )}
          {' · '}
          {d.spriteCount !== undefined ? (
            `${d.spriteCount} sprites`
          ) : (
            <span title={d.spriteUnavailable}>sprites unavailable</span>
          )}
        </div>
        {/* With the facts, not in the folded header: it qualifies the picture. */}
        {d.gfxAssignmentNote && (
          <div className="hb-map-view-error hb-map-view-note" data-note="gfx-assignment">
            {d.gfxAssignmentNote}
          </div>
        )}
      </div>
    )
  }

  protected renderDecode(): React.ReactNode {
    const d = this.details
    if (!d) return <div className="hb-map-view-empty">{this.error ?? 'Reading the ROM...'}</div>
    if (!d.headerBytes || !d.header) {
      return (
        <div className="hb-map-view-empty">
          <span title={d.levelDataUnavailable}>level data unavailable</span>
        </div>
      )
    }
    const bytes = d.headerBytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
    return (
      <>
        <table className="hb-map-view-table">
          <tbody>
            {d.header.map(f => (
              <tr key={f.label}>
                <th>{f.label}</th>
                <td>{f.value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* The decode above is a claim; these are the bytes it was made from. */}
        <div className="hb-map-view-raw">
          <span>Header bytes</span>
          <code>{bytes}</code>
        </div>
      </>
    )
  }
}
