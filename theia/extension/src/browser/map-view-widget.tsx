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
import { HoverService } from '@theia/core/lib/browser/hover-service'
import { CommandService } from '@theia/core/lib/common'
import {
  MAP_PLANE_KEYS,
  MapCollisionCheckResult,
  MapCollisionResult,
  MapDetailsDto,
  MapPlaneKey,
  MapScreenResult,
  MapBlockContentsResult,
  MapSpriteDto,
  MapSpritesResult,
  ProjectService,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { ProjectContext } from './project-context'
import { decodeRgba, TILE_PX } from './map16-pixels'
import {
  spriteDoors,
  spriteAt,
  spriteName,
  hoverPlacementKey,
  doorIdAt,
  liftIfCovered,
  spritePlanes,
  flamePlanes,
  withFlameKeys,
  decodeArts,
  hoverTarget,
  indicatorId,
  IndicatorDisplay,
  paintSpriteCanvas,
  PALACES,
  screenKey,
  type Indicator,
} from './map-view-model'
import { PropertiesModel } from './properties-model'
import { RevealPropertiesCommand } from './properties-contribution'
import { SWITCH_ORDER } from './map16-view-model'
import { decodeSwitchButton, SwitchToggle, type SwitchButtonImages } from './switch-toggle'
import { LayerToggle } from './layer-icon'
import { PixelImageButton, type FrameImage } from './pixel-image-button'
import { slotLabel } from './map-explorer-widget'
import { WheelBinding, ZoomController } from './zoom-controller'
import { ZoomStepper } from './zoom-stepper'
import { MapGridOverlay } from './grid-overlay'
import { CollisionOverlay } from './collision-overlay'
import { RefusedOverlay } from './refused-overlay'
import {
  fadeMask,
  cellRect,
  centerScroll,
  insideMap,
  NO_PAD,
  offMapPad,
  offMapSpritePixels,
  samePad,
  screensInView,
  type Pad,
} from './off-map-extent'
import { GUTTER_PX } from '../../../../src/rom/model/MapGutter'
import { collisionKey, collisionPlan } from './map-view-state'
import { MapViewStateStore } from './map-view-state-store'
import { layer2Label } from './map-layer-labels'
import { isUnverifiedMode } from '../../../../src/rom/model/UnverifiedModes'
import {
  composeScreen,
  doorFlips,
  type ScreenInput,
  type SourceKey,
} from '../../../../src/rom/model/ColorMath'
import { perfEnd, perfStart } from '../common/perf-marks'
import { ProjectBound } from './project-bound'
import {
  lowerFirst,
  rawText,
  readFailed,
  romMissingMessage,
  unverifiedLabel,
  withDetail,
} from './map-view-messages'

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
/** A refusal's plain words, and the technical text that belongs on a tooltip's second line (#967). */
type Why = { text: string; detail?: string }

/** Why a collision reply (or check) leaves the overlay unavailable, or undefined when it does not. */
function collisionWhyNot(
  r: Exclude<MapCollisionResult, { status: 'stale' }> | MapCollisionCheckResult,
): Why | undefined {
  if (r.status === 'ok' || r.status === 'available') return undefined
  if (r.status === 'unavailable') return { text: r.reason, detail: r.detail }
  return { text: lowerFirst(romMissingMessage(r.baseRom.title)) }
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

type PalaceIcon = { uncleared: FrameImage; cleared: FrameImage } | { reason: string; detail?: string } // prettier-ignore

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
  @inject(HoverService) protected readonly hoverService!: HoverService
  @inject(PropertiesModel) protected readonly properties!: PropertiesModel
  @inject(CommandService) protected readonly commands!: CommandService

  protected options: MapViewOptions | undefined

  readonly projectBound = true as const
  /** Closed by the shell when another project opens (#628). */
  get manifestPath(): string | undefined {
    return this.options?.manifestPath
  }
  protected details: MapDetailsDto | undefined
  protected error: string | undefined
  /** The exception text behind `error`: a tooltip and the console, never the visible words (#786). */
  protected errorDetail: string | undefined
  protected mapLayout: Layout | undefined
  /** The canvas for sprites the data places off the map, in its pad (#1004). */
  protected offMapCanvas: HTMLCanvasElement | null = null
  /** `pad` for one (layout, sprites) pair: it is read on every pointer move. */
  protected padMemo: { l: Layout; s: Sprites | undefined; pad: Pad } | undefined
  /** The sprite pixels outside the map for one (layout, sprites) pair, null when none reach outside. */
  protected offMapMemo: { l: Layout; s: Sprites; px: Uint8ClampedArray | null } | undefined
  /** Wheel, pointer and key events in the tab: the late-pad restore yields to any of them. */
  protected userInputs = 0
  /** A late-pad restore waiting for its frames: the pixel to hold and the pad to restore to. */
  protected pendingRestore: { held: { x?: number; y?: number } | null | undefined; after: Pad; generation: number; inputs: number; dirty: boolean } | undefined // prettier-ignore
  protected screenError: string | undefined
  protected screenErrorDetail: string | undefined
  /** Each palace's block, decoded once per load, or why it cannot be drawn. */
  protected icons = new Map<Palace, PalaceIcon>()

  /** The palaces and switches, this tab's own; buttons dispatch, consumers subscribe (see `init`). */
  protected readonly view = new MapViewStateStore()
  /** The switch toggles' art (#574's), and why a kind has none. */
  protected switchArt: Partial<Record<Switch, SwitchButtonImages>> = {}
  protected switchWhy: Partial<Record<Switch, string>> = {}
  /** The technical text behind each `switchWhy`, for the tooltip's second line (#967). */
  protected switchDetail: Partial<Record<Switch, string>> = {}
  /** L1 (foreground) and L2 (background) shown; off leaves what is beneath them. */
  protected showL1 = true
  protected showL2 = true
  /** The tile / sub-screen / screen grid; on by default. */
  protected showGrid = true
  protected showL3 = true
  protected showSprites = true
  /** The map's sprites (#564), once read; `spritesWhy` is why there are none to show. */
  protected sprites: Sprites | undefined
  protected spritesWhy: string | undefined
  protected spritesDetail: string | undefined
  /** The sprite under the pointer (#981); its name shows in Theia's themed hover, anchored on the sprite. */
  protected hoverSprite: MapSpriteDto | undefined
  /** The clicked sprite (#984): published to the Properties panel, never drawn on the map. */
  protected selectedSprite: MapSpriteDto | undefined
  /** The invisible box over the hovered sprite that the hover is placed against. */
  protected spriteAnchor: HTMLElement | undefined
  /** Where the anchor was placed (`hoverPlacementKey`): a different zoom or strip origin moves the sprite, so the hover is asked for again. */
  protected hoverPlaced = ''
  /** Bumped when `sprites` is replaced, so a canvas painted from the old ones is repainted. */
  protected spritesVersion = 0
  /** The collision overlay (#435); off by default. */
  protected showCollision = false
  /** The map's collision lines once read; `collisionWhy` is why there are none to show. */
  protected collision: Collision | undefined
  protected collisionWhy: string | undefined
  protected collisionDetail: string | undefined
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
  /** The exception text behind `blocksWhy`, for its tooltip only (#967). */
  protected blocksDetail: string | undefined
  protected blocksVersion = 0
  /** The indicator under the pointer: it fills its block, the rest sit in their quadrants. */
  protected hover: Indicator | undefined
  /** The sprite under the pointer (#879): its door id, global to the map, drawn opaque on every screen it covers. */
  protected lift: number | undefined
  /** Door maps (and the ids in each) by screen for the hit test, valid for the `spritesVersion` they were built at. */
  protected readonly doorMaps = new Map<number, { doors: Uint32Array | null; ids: Set<number> }>()
  protected doorMapsVersion = -1
  /** Per composed screen, the door ids with a covered pixel: a sprite without one never lifts (#879). */
  protected readonly coveredIds = new Map<number, ReadonlySet<number>>()
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
  /** Bumped only by `open`, so the start reply of an earlier map is dropped; an edit's refresh leaves it (#339). */
  protected startSeq = 0
  /** Where the player first enters this map, until the view has been scrolled to it once. */
  protected pendingStart: { x: number; y: number } | undefined
  /** Why the start is not known: the view stays at screen 0 and says so. */
  protected startWhy: string | undefined
  protected startDetail: string | undefined
  /** Where this open's start stands, for the strip's `data-start` (a test waits on it, not on a timer). */
  protected startState: 'pending' | 'placed' | 'skipped' | 'unavailable' = 'pending'
  /** The view left offset 0 while the start was pending, even if it came back: the user has taken over. */
  protected movedBeforeStart = false

  /** Sets the tab up once the container has built it: its class and focus, the listeners (including the key counter for the late-pad restore), and the disposables that undo them. */
  @postConstruct()
  protected init(): void {
    this.addClass('hb-map-view')
    this.title.closable = true
    this.node.tabIndex = 0
    this.toDispose.push({ dispose: () => this.resizes.disconnect() })
    this.toDispose.push({ dispose: () => this.setHoverSprite(undefined) })
    // Keys count as user input for the late-pad restore; the tab, not the scroller, has the focus.
    this.node.addEventListener('keydown', this.countInput, true)
    this.toDispose.push({
      dispose: () => this.node.removeEventListener('keydown', this.countInput, true),
    })
    this.toDispose.push({ dispose: () => this.selectSprite(undefined) })
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
          this.collisionDetail = undefined
          this.collisionWhyKey = undefined
          this.collisionProbed = false // so the check's answer is taken, not dropped for the probe's
          void this.checkCollision()
        }
        if (plan.refetch) void this.loadCollision()
      }),
    )
    this.zoomController.centreAnchored = true
    // A user zoom while the start is pending is the user taking over, as a scroll is (#787).
    this.zoomController.onUserZoom = () => {
      if (this.startState === 'pending') this.movedBeforeStart = true
    }
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
    this.setHoverSprite(undefined)
    this.spritesWhy = undefined
    this.spritesDetail = undefined
    this.collision = undefined
    this.collisionWhy = undefined
    this.collisionDetail = undefined
    this.collisionWhyKey = undefined
    this.collisionKey = undefined
    this.collisionChecked = false
    this.collisionProbed = false
    this.blocks = undefined
    this.blocksWhy = undefined
    this.blocksDetail = undefined
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
    this.pendingStart = undefined
    this.startWhy = undefined
    this.startDetail = undefined
    this.startState = 'pending'
    this.movedBeforeStart = false
    void this.loadStart(++this.startSeq)
    this.update()
    this.refresh()
  }

  /**
   * Asks where the player first enters this map (#339). Once per `open`: a later refit, zoom or
   * scroll never re-applies it, and a reply for a map the tab has moved on from is dropped.
   */
  protected async loadStart(seq: number): Promise<void> {
    const o = this.options
    if (!o) return
    const r = await this.projects.mapStart(o.manifestPath, o.index).catch(() => ({
      status: 'unavailable' as const,
      reason: 'The start position could not be read just now.',
    }))
    if (seq !== this.startSeq) return
    if (r.status === 'ok') {
      this.pendingStart = { x: r.x, y: r.y }
      this.placeStart()
      return
    }
    this.startState = 'unavailable'
    this.startWhy = r.status === 'unavailable' ? r.reason : romMissingMessage(r.baseRom.title)
    this.startDetail = r.status === 'unavailable' && 'detail' in r ? r.detail : undefined
    this.update()
  }

  /**
   * Scrolls the start onto the centre of the scroll axis, once the strip is laid out at its fit
   * zoom; called on every commit and reply until it has run, then never again for this open.
   * Skipped (and dropped) when the user has already scrolled.
   */
  protected placeStart(): void {
    const start = this.pendingStart
    const l = this.mapLayout
    const el = this.scroller
    const strip = el?.querySelector<HTMLElement>('.hb-map-view-strip')
    if (!start || !l || !el || !strip || this.renderedZoom !== this.zoom) return
    const vertical = l.orientation === 'vertical'
    const fit = this.zoomController.fitting ? this.measureFit() : undefined
    if (fit !== undefined && Math.abs(fit - this.zoom) > 1e-6) return
    const [lead, trail] = this.scrollPad(l)
    const extent = (l.screenCount * (vertical ? l.height : l.width) + lead + trail) * this.zoom
    if ((vertical ? strip.offsetHeight : strip.offsetWidth) < extent - 1) return
    this.pendingStart = undefined
    if (this.movedBeforeStart || (vertical ? el.scrollTop : el.scrollLeft) !== 0) {
      this.startState = 'skipped'
      return this.update()
    }
    const view = vertical ? el.clientHeight : el.clientWidth
    const max = (vertical ? el.scrollHeight : el.scrollWidth) - view
    const at = centerScroll(vertical ? start.y : start.x, lead, this.zoom, view, max)
    el.scrollTo(vertical ? { top: at } : { left: at })
    this.startState = 'placed'
    this.update()
    this.requestVisible()
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
    this.pendingRestore = undefined
    this.setHoverSprite(undefined)
    this.screens.clear()
    this.coveredIds.clear()
    this.lift = undefined
    this.pending.clear()
    this.screenError = undefined
    this.screenErrorDetail = undefined
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
      .catch(readFailed(this.what('collision check')))
    // A probe that already answered knows more than the check: a late `available` must not undo its refusal.
    if (generation !== this.generation || this.collisionProbed) return
    this.setCollisionWhy(collisionWhyNot(r))
    this.update()
  }

  /** Reads the collision lines; a failure becomes plain words with the raw text as tooltip detail (#967), never the main message. */
  protected async loadCollision(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const seq = ++this.collisionSeq
    const { flags, switches } = this.view.state
    const key = collisionKey(this.view.state)
    const r = await this.projects
      .mapCollision(o.manifestPath, o.index, flags, switches)
      .catch(readFailed(this.what('collision')))
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
  protected setCollisionWhy(why: Why | undefined, probedFor?: string): void {
    this.collisionWhy = why?.text
    this.collisionDetail = why?.detail
    this.collisionWhyKey = why ? probedFor : undefined
    this.collisionChecked = true
    if (why) this.showCollision = false
  }

  /** What a failed overlay read is called in the log: the map and the overlay. */
  protected what(overlay: string): string {
    return `Map ${this.options?.index.toString(16)} ${overlay}`
  }

  /**
   * Reads the map's sprites for the open slot and replaces the current ones. A reply for an older map or edit
   * is dropped (generation). The pad can depend on the sprites, so the view is held across a pad change.
   */
  protected async loadSprites(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapSprites(o.manifestPath, o.index)
      .catch(readFailed(this.what('sprites')))
    // An older map's or edit's sprites must not land over a newer one.
    if (generation !== this.generation) return
    const before = this.pad
    this.sprites = r.status === 'ok' ? r : undefined
    this.keepViewOnPadChange(before)
    this.setHoverSprite(undefined)
    this.selectSprite(undefined)
    this.lift = undefined
    this.coveredIds.clear()
    this.spritesWhy = r.status === 'ok' ? undefined : r.status === 'unavailable' ? r.reason : lowerFirst(romMissingMessage(r.baseRom.title)) // prettier-ignore
    this.spritesDetail = r.status === 'unavailable' ? r.detail : undefined
    this.spritesVersion++
    this.update()
    this.sync()
  }

  /**
   * Sprites arrive after the map (and an edit can move a mark), and off-map content can grow the pad.
   * Fit refits to the new cross axis, and a leading pad that appears under a scrolled view shifts the
   * content. The map pixel under the view center is recorded before the change and the scroll set
   * absolutely after the refit has committed (the way ZoomController.restoreAnchor does), so the view
   * stays on it; a relative nudge would drift with the refit's zoom. An axis at scroll 0 is left alone,
   * so the leading pad shows. A second change while a restore is pending reuses the recorded pixel and
   * only replaces the pad it restores to. Skipped when the map was reopened (generation), or the user
   * zoomed, scrolled, pressed a key or a pointer in the two frames. Nothing happens when the pad is unchanged.
   */
  protected keepViewOnPadChange(before: Pad): void {
    const l = this.mapLayout
    const after = this.pad
    if (!l || samePad(before, after)) return
    const pending = this.pendingRestore
    if (pending) {
      pending.after = after
      pending.dirty = true
      return
    }
    const el = this.scroller
    const z = this.zoom
    const held = el && {
      x: el.scrollLeft > 0 ? (el.scrollLeft + el.clientWidth / 2 - before.left * z) / z : undefined,
      y: el.scrollTop > 0 ? (el.scrollTop + el.clientHeight / 2 - before.top * z) / z : undefined,
    }
    const restore = {
      held,
      after,
      generation: this.generation,
      inputs: this.userInputs,
      dirty: false,
    }
    this.pendingRestore = restore
    // The refit's zoom is the one to restore at; a different one by the last frame is the user's.
    let zoom = this.zoom
    /** The last frame of the restore: runs once more after a refit if the pad changed again, then scrolls. */
    const finish = (): void => {
      if (this.pendingRestore !== restore) return // the map was reopened or refreshed
      // The pad changed again while waiting: refit once more and give the layout a frame to commit.
      if (restore.dirty) {
        restore.dirty = false
        this.fitStrip()
        zoom = this.zoom
        requestAnimationFrame(finish)
        return
      }
      this.pendingRestore = undefined
      const { held: h, after: a, generation, inputs } = restore
      if (!el || !h || generation !== this.generation || zoom !== this.zoom || inputs !== this.userInputs) return // prettier-ignore
      el.scrollTo({
        left: h.x === undefined ? undefined : (h.x + a.left) * zoom - el.clientWidth / 2,
        top: h.y === undefined ? undefined : (h.y + a.top) * zoom - el.clientHeight / 2,
      })
    }
    requestAnimationFrame(() => {
      this.fitStrip()
      zoom = this.zoom
      requestAnimationFrame(finish)
    })
  }

  /** Reads block contents; a failure keeps plain words on the label and the technical text in the tooltip (#967). */
  protected async loadBlocks(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapBlockContents(o.manifestPath, o.index)
      .catch(readFailed(this.what('block contents')))
    if (generation !== this.generation) return
    this.blocks = r.status === 'ok' ? { ...r, decoded: decodeArts(r.arts) } : undefined
    this.blocksDetail =
      r.status === 'unavailable' ? r.detail : r.status === 'ok' ? r.noteDetail : undefined
    this.blocksWhy =
      r.status === 'ok'
        ? r.note
        : r.status === 'unavailable'
          ? `Block contents are not drawn: ${r.reason}`
          : `Block contents are not drawn. ${romMissingMessage(r.baseRom.title)}`
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
    let detail: string | undefined
    try {
      const r = await this.projects.mapDetails(o.manifestPath, o.index)
      if ('status' in r) error = romMissingMessage(r.baseRom.title)
      else details = r
    } catch (err) {
      detail = rawText(err)
      console.error(`Map ${o.index.toString(16)} details failed:`, err)
      error = "This map's details could not be read. Open the map again to try again."
    }
    // An older map's or edit's reply must not land over a newer one.
    if (generation !== this.generation) return
    this.details = details
    this.error = error
    this.errorDetail = detail
    this.update()
  }

  /** Reads the palace icons; a failure leaves the icons undrawn with a plain-word reason (#967). */
  protected async loadIcons(): Promise<void> {
    const o = this.options
    if (!o) return
    const generation = this.generation
    const r = await this.projects
      .mapPalaceIcons(o.manifestPath, o.index)
      .catch(readFailed(this.what('switch art')))
    // An older map's or edit's art must not land over a newer one.
    if (generation !== this.generation) return
    const image = (b64: string): FrameImage => ({ width: 16, height: 16, rgba: decodeRgba(b64) })
    const why = r.status === 'ok' ? undefined : r.status === 'unavailable' ? r.reason : lowerFirst(romMissingMessage(r.baseRom.title)) // prettier-ignore
    const whyDetail = r.status === 'unavailable' ? r.detail : undefined
    this.icons = new Map(
      PALACES.map((p): [Palace, PalaceIcon] => {
        const i = r.status === 'ok' ? r.icons.find(x => x.palace === p) : undefined
        if (i && 'cleared' in i) return [p, { uncleared: image(i.uncleared), cleared: image(i.cleared) }] // prettier-ignore
        if (i && 'unavailable' in i) return [p, { reason: i.unavailable, detail: i.detail }]
        return [p, { reason: why ?? 'no art', detail: whyDetail }]
      }),
    )
    const art = r.status === 'ok' ? r.switchArt : {}
    this.switchArt = Object.fromEntries(SWITCH_ORDER.filter(k => art[k]).map(k => [k, decodeSwitchButton(art[k]!, decodeRgba)])) // prettier-ignore
    this.switchWhy = r.status === 'ok' ? r.switchUnavailable : Object.fromEntries(SWITCH_ORDER.map(k => [k, why])) // prettier-ignore
    this.switchDetail = r.status === 'ok' ? (r.switchDetail ?? {}) : Object.fromEntries(SWITCH_ORDER.map(k => [k, whyDetail])) // prettier-ignore
    this.update()
  }

  protected key(screen: number): string {
    return screenKey(this.view.state.flags, this.view.state.switches, screen)
  }

  /** The whole map's size in map pixels: every screen, no padding. */
  protected mapPx(
    l: Pick<Layout, 'orientation' | 'width' | 'height' | 'screenCount'>,
  ): [number, number] {
    return l.orientation === 'vertical' ? [l.width, l.height * l.screenCount] : [l.width * l.screenCount, l.height] // prettier-ignore
  }

  /**
   * The canvas beyond each side of the map (D48 part 2, D145, #1004): the content the data places off
   * it, rounded to tiles, plus the gutter beyond that at each long end. The ONE origin every pointer
   * and overlay consumer reads. It is derived from the layout and the sprites together, so it can change
   * when the sprites reply lands (`keepViewOnPadChange`).
   */
  protected get pad(): Pad {
    const l = this.mapLayout
    if (!l) return NO_PAD
    const m = this.padMemo
    if (m && m.l === l && m.s === this.sprites) return m.pad
    const [w, h] = this.mapPx(l)
    const rects = [
      ...(l.refusedCells ?? []).map(c => cellRect(c.x, c.y)),
      ...(this.sprites?.sprites ?? []).map(sp => sp.box),
    ]
    const pad = offMapPad(w, h, rects, l.orientation === 'vertical')
    this.padMemo = { l, s: this.sprites, pad }
    return pad
  }

  /**
   * The map's top-left corner in MAP pixels from the strip's: the leading pads. Same name, signature
   * and units as #977's `mapOrigin()` (neighbor cards add it times the zoom).
   */
  protected mapOrigin(): { x: number; y: number } {
    return { x: this.pad.left, y: this.pad.top }
  }

  /** The pad on the scroll axis before and after the map, map pixels. */
  protected scrollPad(l: Layout): [number, number] {
    const p = this.pad
    return l.orientation === 'vertical' ? [p.top, p.bottom] : [p.left, p.right]
  }

  /** The screens in view, plus MARGIN either side; screen 0 before the layout is known. */
  protected visibleScreens(): number[] {
    const l = this.mapLayout
    if (!l) return [0]
    const vertical = l.orientation === 'vertical'
    const size = (vertical ? l.height : l.width) * this.zoom
    const el = this.scroller
    const scroll = el ? (vertical ? el.scrollTop : el.scrollLeft) : 0
    const view = (el && (vertical ? el.clientHeight : el.clientWidth)) || size
    const [first, last] = screensInView(scroll, view, size, this.scrollPad(l)[0] * this.zoom, l.screenCount, MARGIN) // prettier-ignore
    return Array.from({ length: last - first + 1 }, (_, i) => first + i)
  }

  protected requestVisible(): void {
    this.sync()
    for (const s of this.visibleScreens()) void this.fetchScreen(s)
  }

  /**
   * Fetches one screen's planes (once per cache key) and, on the first reply, sizes the strip from it. A reply
   * whose layout changed the pad (an edit moved a mark off the map) keeps the view on the same map pixel.
   */
  protected async fetchScreen(screen: number): Promise<void> {
    const o = this.options
    const key = this.key(screen)
    if (!o || this.screens.has(key) || this.pending.has(key)) return
    this.pending.add(key)
    const generation = this.generation
    let r: MapScreenResult
    let detail: string | undefined
    try {
      r = await this.projects.mapScreen(o.manifestPath, o.index, screen, this.view.state.flags, this.view.state.switches) // prettier-ignore
    } catch (err) {
      detail = rawText(err)
      console.error(`Map ${o.index.toString(16)} screen ${screen} failed:`, err)
      r = { status: 'unavailable', reason: 'Part of this map could not be drawn. Open the map again to try again.' } // prettier-ignore
    }
    if (generation !== this.generation) return
    this.pending.delete(key)

    if (r.status !== 'ok') {
      this.screenError =
        r.status === 'rom-not-located' ? romMissingMessage(r.baseRom.title) : r.reason
      this.screenErrorDetail = detail ?? (r.status === 'unavailable' ? r.detail : undefined)
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
      JSON.stringify(l.refusedCells) !== JSON.stringify(r.refusedCells) ||
      l.layerNotes.join() !== r.layerNotes.join() ||
      JSON.stringify([l.layer3, l.screens, l.math, l.layer2Interactive]) !==
        JSON.stringify([r.layer3, r.screens, r.math, r.layer2Interactive]) ||
      l.backdrop.join() !== r.backdrop.join()
    ) {
      // The first reply sizes the strip; the screens in view follow once it is laid out.
      const before = this.pad
      this.mapLayout = r
      // An edit can move a mark off the map and change the pad under a scrolled view.
      if (l) this.keepViewOnPadChange(before)
      this.update()
      requestAnimationFrame(() => this.fitStrip())
    }
    if (this.screenError) {
      this.screenError = undefined
      this.screenErrorDetail = undefined
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
    // Untested on purpose: no UI input yields a stale-zoom commit (Lumino
    // renders in a microtask, so render() sees the latest zoom before React's
    // commit task; @lumino/messaging 2.0.5 dist/index.js:141-147). See
    // docs/decisions/2026-10-08-zoom-anchor-race-seam.md.
    if (this.renderedZoom === this.zoomController.value) this.wheelBinding?.restoreAnchor()
    this.placeStart()
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
    this.syncOffMap()
  }

  /**
   * The sprite pixels outside the map on one bitmap of the padded strip (the screens draw the rest),
   * or null when no sprite reaches outside. Memoized per (layout, sprites): the render asks on every
   * pass and the bitmap is the expensive part.
   */
  protected offMapPixels(): Uint8ClampedArray | null {
    const l = this.mapLayout
    const sp = this.sprites
    if (!l || !sp) return null
    const m = this.offMapMemo
    if (m && m.l === l && m.s === sp) return m.px
    const [mw, mh] = this.mapPx(l)
    const px = offMapSpritePixels(sp.sprites, mw, mh, this.pad, l.orientation === 'vertical')
    this.offMapMemo = { l, s: sp, px }
    return px
  }

  /** Paints the off-map sprite canvas, when it is mounted (it is only when `offMapPixels` has pixels). */
  protected syncOffMap(): void {
    const c = this.offMapCanvas
    const l = this.mapLayout
    const px = this.offMapPixels()
    if (!c || !l || !px) return
    const p = this.pad
    const want = `${this.generation}:${this.spritesVersion}:${p.left},${p.top},${p.right},${p.bottom}`
    if (c.dataset.drawn === want) return
    const [mw, mh] = this.mapPx(l)
    c.width = mw + p.left + p.right
    c.height = mh + p.top + p.bottom
    const ctx = c.getContext('2d')
    ctx?.clearRect(0, 0, c.width, c.height)
    ctx?.putImageData(new ImageData(px, c.width, c.height), 0, 0)
    c.dataset.drawn = want
  }

  /** Remembers the off-map sprite canvas (mounted only when `offMapPixels` is non-null) and paints it at once. */
  protected readonly offMapRef = (el: HTMLCanvasElement | null): void => {
    this.offMapCanvas = el
    this.syncOffMap()
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
    const lift = this.liftOn(s)
    const want = `${this.generation}:${this.key(s)}:${+this.showL1}${+this.showL2}${+this.showL3}${+this.showSprites}:${this.spritesVersion}:${lift ?? ''}` // prettier-ignore
    if (canvas.dataset.drawn === want) return
    canvas.width = shot.width
    canvas.height = shot.height
    const planes = this.shownPlanes(s, shot)
    const input: ScreenInput = {
      width: shot.width,
      height: shot.height,
      planes,
      lists: withFlameKeys(shot.screens),
      math: shot.math,
      doors: this.showSprites ? spriteDoors(this.sprites, s) : null,
      lift: this.lift,
    }
    const flips = doorFlips(input)
    const covered = new Set(flips?.keys())
    const before = this.coveredIds.get(s)
    this.coveredIds.set(s, covered)
    // A pointer already resting on a hidden sprite lifts it once its screen is first painted (or its set changes); a
    // repeat paint with the same set stays quiet, so paint -> updateHover -> paint cannot loop.
    if (!before || before.size !== covered.size || [...covered].some(id => !before.has(id))) queueMicrotask(() => this.updateHover()) // prettier-ignore
    const out = composeScreen({ ...input, flips })
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
    // The sprites are four more sources, one per OAM priority (#795), not in color math (their palette split is #564's to add).
    if (this.showSprites) {
      Object.assign(planes, spritePlanes(this.sprites, s))
      // The Layer 2 flames (#894) ride Layer 2's routing; its priority plane is read even while Layer 2 is hidden.
      Object.assign(planes, flamePlanes(this.sprites, s, shot.planes.l2High?.data))
    }
    return planes
  }

  /** Each screen's picture at screen resolution, while it holds indicators: built once, then only hover cells are redone. */
  protected readonly displays = new Map<number, { want: string; display: IndicatorDisplay }>()

  /** Screens whose last build found no indicator, with the key it was for: no rebuild until the key moves (#973). */
  protected readonly bare = new Map<number, string>()

  /** The state `syncDisplay` leaves a screen with nothing to draw in: the composite itself shows. */
  protected showBare(canvas: HTMLCanvasElement, comp?: HTMLCanvasElement): void {
    if (canvas.width !== 0) canvas.width = 0
    delete canvas.dataset.drawn
    canvas.dataset.indicators = '[]'
    if (comp) comp.style.visibility = ''
  }

  /** IndicatorDisplay builds so far; the scroll perf spec (#973) reads it to prove a warm scroll builds none. */
  protected displayBuilds = 0

  /**
   * The display canvas of screen `s` covers the native composite, which stays untouched, with the same
   * picture at the zoom and the indicators drawn in their planes (`IndicatorDisplay`). `data-indicators`
   * records the boxes it painted. A screen with none shows the composite itself.
   */
  protected syncDisplay(canvas: HTMLCanvasElement, s: number): void {
    const [comp, shot, b] = [this.composites.get(s), this.screens.get(this.key(s)), this.blocks]
    const hide = () => {
      this.displays.delete(s)
      this.showBare(canvas, comp)
    }
    if (!comp?.dataset.drawn || !shot || !b) return hide()
    const want = `${comp.dataset.drawn}:${this.blocksVersion}:${this.zoom}`
    // A screen found to hold no indicator stays that way for this key: skip the rebuild (#973).
    if (this.bare.get(s) === want) return this.showBare(canvas, comp)
    this.bare.delete(s)
    let cur = this.displays.get(s)
    if (cur?.want !== want) {
      this.displayBuilds++
      const display = new IndicatorDisplay({
        width: shot.width,
        height: shot.height,
        zoom: this.zoom,
        screen: s,
        geometry: b,
        planes: this.shownPlanes(s, shot),
        lists: withFlameKeys(shot.screens),
        math: shot.math,
        doors: this.showSprites ? spriteDoors(this.sprites, s) : null,
        lift: this.lift,
        base: comp.getContext('2d')!.getImageData(0, 0, comp.width, comp.height).data,
        indicators: b.indicators,
        arts: b.decoded,
      }, this.hoverOn(s) && indicatorId(this.hoverOn(s)!)) // prettier-ignore
      if (!display.touches) {
        this.bare.set(s, want)
        return hide()
      }
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

  /** The lift as part of screen `s`'s cache key: only a screen whose door map holds the id changes with it. */
  protected liftOn(s: number): number | undefined {
    return this.lift !== undefined && this.showSprites && this.screenDoors(s).ids.has(this.lift) ? this.lift : undefined // prettier-ignore
  }

  protected screenDoors(s: number): { doors: Uint32Array | null; ids: Set<number> } {
    if (this.doorMapsVersion !== this.spritesVersion) {
      this.doorMaps.clear()
      this.doorMapsVersion = this.spritesVersion
    }
    let d = this.doorMaps.get(s)
    if (!d) {
      if (this.doorMaps.size >= 64) this.doorMaps.clear()
      const doors = s >= 0 ? spriteDoors(this.sprites, s) : null
      d = { doors, ids: new Set(doors ? Array.from(doors, v => v >> 1) : []) }
      this.doorMaps.set(s, d)
    }
    return d
  }

  /** The door id of the sprite under the strip pixel (x, y), native units, when a tile covers some of it (S3). */
  protected liftAt(x: number, y: number): number | undefined {
    const g = this.sprites
    if (!g || !this.showSprites) return undefined
    const vertical = g.orientation === 'vertical'
    // Off the map (the pad, #1004): no tile covers a sprite there, and no screen is there to look up.
    const [mw, mh] = this.mapPx(g)
    if (!insideMap(x, y, mw, mh)) return undefined
    const s = Math.floor(vertical ? y / g.height : x / g.width)
    const id = doorIdAt(this.screenDoors(s).doors, g.width, x - (vertical ? 0 : s * g.width), y - (vertical ? s * g.height : 0)) // prettier-ignore
    return liftIfCovered(id, this.coveredIds.values())
  }

  protected setLift(next: number | undefined): void {
    if (next === this.lift) return
    this.lift = next
    this.sync()
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

  /** Counts a wheel or pointer event on the scroller (keys are counted on the tab node, see `init`), so the late-pad restore can tell the user moved. */
  protected readonly countInput = (): void => {
    this.userInputs++
  }

  protected readonly onPointerMove = (e: React.MouseEvent): void => {
    this.pointer = { x: e.clientX, y: e.clientY }
    this.updateHover()
  }

  /** Finds the topmost visible block under the pointer; run on moves, scrolls, zooms and new replies. */
  protected updateHover(): void {
    const strip = this.scroller?.querySelector<HTMLElement>('.hb-map-view-strip')
    const l = this.mapLayout
    const p = this.pointer
    if (!strip || !l || !p || !this.isVisible) {
      this.setLift(undefined)
      this.setHoverSprite(undefined)
      return this.setHover(undefined)
    }
    const r = strip.getBoundingClientRect()
    const pad = this.pad
    const [x, y] = [(p.x - r.left) / this.zoom - pad.left, (p.y - r.top) / this.zoom - pad.top]
    this.setLift(this.liftAt(x, y))
    this.setHoverSprite(this.spriteUnder(x, y))
    if (!this.blocks) return this.setHover(undefined)
    const order = this.layerOrder(l)
    const shown = (q: Indicator['plane']) => order.includes(q) && this.layerShown(q)
    this.setHover(hoverTarget(this.blocks.indicators, x, y, shown, q => order.indexOf(q)) ?? undefined) // prettier-ignore
  }

  /** The topmost drawn sprite at the strip pixel (x, y), native units; none while sprites are toggled off. */
  protected spriteUnder(x: number, y: number): MapSpriteDto | undefined {
    const g = this.sprites
    return g && this.showSprites ? spriteAt(g.sprites, g, x, y) : undefined
  }

  /**
   * Sets the sprite under the pointer and places Theia's hover over it. The anchor box is the sprite's box
   * plus the pad, because the strip's origin is not the map's origin (#1004).
   */
  protected setHoverSprite(next: MapSpriteDto | undefined): void {
    const strip = this.node.querySelector('.hb-map-view-strip')
    const placed = hoverPlacementKey(
      this.zoom,
      strip?.getBoundingClientRect() ?? { left: 0, top: 0 },
    )
    if (next === this.hoverSprite && this.hoverPlaced === placed) return
    this.hoverSprite = next
    this.hoverPlaced = placed
    // The hover service is shared: only cancel a hover this widget asked for.
    if (this.spriteAnchor) this.hoverService.cancelHover()
    this.spriteAnchor?.remove()
    this.spriteAnchor = undefined
    const name = next && spriteName(next)
    if (next && name && strip) {
      // Theia's hover is placed against an element, so a fixed box over the sprite stands in for it.
      const r = strip.getBoundingClientRect()
      const { x0, y0, x1, y1 } = next.box
      const a = document.createElement('div')
      a.className = 'hb-map-sprite-anchor'
      Object.assign(a.style, { position: 'fixed', pointerEvents: 'none', left: `${r.left + (x0 + this.pad.left) * this.zoom}px`, top: `${r.top + (y0 + this.pad.top) * this.zoom}px`, width: `${(x1 - x0) * this.zoom}px`, height: `${(y1 - y0) * this.zoom}px` }) // prettier-ignore
      document.body.append(a)
      this.spriteAnchor = a
      // A click hides the hover until the pointer re-enters (Theia cancels on mousedown), as a native title does.
      this.hoverService.requestHover({ content: name, target: a, position: 'top', cssClasses: ['hb-map-sprite-hover'] }) // prettier-ignore
    }
  }

  /** Click selection (#984): the sprite goes to the Properties panel until another click, a map change, hide or close. */
  protected selectSprite(next: MapSpriteDto | undefined): void {
    this.selectedSprite = next
    this.syncSelection()
    // Revealed on a pick, not on every sync: closing the panel must stay closed until the next click.
    if (next && this.isVisible) void this.commands.executeCommand(RevealPropertiesCommand.id)
  }

  /** Publishes this widget's selection, or releases it; only the owner's clear takes effect (see PropertiesModel). */
  protected syncSelection(): void {
    if (this.selectedSprite && this.isVisible) {
      const o = this.options
      this.properties.publish(this, {
        kind: 'sprite',
        sprite: this.selectedSprite,
        source: o && { manifestPath: o.manifestPath, index: o.index },
      })
    } else this.properties.clear(this)
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
    const p = this.pad
    const cross = vertical ? l.width + p.left + p.right : l.height + p.top + p.bottom
    return Math.min(4, Math.max(0.25, avail / cross))
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

  /** The collision button's tooltip: its label, and a refusal's technical text on a second line. */
  protected collisionTitle(): string {
    return this.collisionWhy ? withDetail(this.collisionLabel(), this.collisionDetail) : this.collisionLabel() // prettier-ignore
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

  /** Tooltip for Sprites: the label first, then the technical detail as a second line, so raw text never leads (#967). */
  protected spritesTitle(): string {
    if (this.spritesWhy) return withDetail(this.spritesLabel(), this.spritesDetail)
    return withDetail(
      this.spritesLabel(),
      this.sprites?.sprites.find(x => x.unverified)?.unverified,
    )
  }

  protected toggleSprites(): void {
    this.showSprites = !this.showSprites
    if (!this.showSprites) {
      this.setHoverSprite(undefined)
      this.selectSprite(undefined)
    }
    this.update()
    this.sync()
  }

  /** The sprite toggle's tooltip: "Sprites" when it works, else why it does not. */
  protected spritesLabel(): string {
    if (this.spritesWhy) return `Sprites unavailable: ${this.spritesWhy}`
    if (!this.sprites) return 'Sprites · reading the map'
    if (this.sprites.sprites.length === 0) return 'Sprites · this map has none'
    return this.sprites.sprites.some(x => x.unverified) ? unverifiedLabel() : 'Sprites'
  }

  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg)
    this.fitStrip()
  }

  /** A hidden or detached tab gets no mouseleave, so its hover must be dropped here. */
  protected override onAfterHide(msg: Message): void {
    super.onAfterHide(msg)
    this.pointer = undefined
    this.setHoverSprite(undefined)
    this.syncSelection()
  }

  protected override onBeforeDetach(msg: Message): void {
    this.pointer = undefined
    this.setHoverSprite(undefined)
    super.onBeforeDetach(msg)
  }

  /** A zoom or layout change moves the sprite: once the render has committed, place the hover again. */
  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg)
    if (this.spriteAnchor) requestAnimationFrame(() => this.updateHover())
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
    // The active map owns the panel: its selection, else "No sprite selected" (a split layout keeps both maps visible).
    if (this.selectedSprite) this.syncSelection()
    else this.properties.publish(this, { kind: 'none' })
  }

  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg)
    this.syncSelection()
  }

  /** Layer 3's tooltip: its role when drawn (the header's priority bit), else why it is not. */
  protected layer3Label(): string {
    const l3 = this.mapLayout?.layer3
    if (!l3) return 'Layer 3 · reading the map'
    return l3.reason ?? (l3.priority ? 'Layer 3 · Overlay' : 'Layer 3 · Background')
  }

  /** Renders the toolbar and canvas; every unavailable overlay title comes from the plain-word helpers (#967). */
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
            title={this.spritesTitle()}
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
            title={this.collisionTitle()}
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
              detail={this.switchDetail[k]}
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
          <div
            className="hb-map-view-note hb-map-view-error"
            data-control="map-error"
            title={this.screenErrorDetail}
          >
            {this.screenError}
          </div>
        )}
        {this.sprites?.note && (
          <div className="hb-map-view-note" data-note="sprites" title={this.sprites.noteDetail}>
            {this.sprites.note}
          </div>
        )}
        {this.blocksWhy && (
          <div className="hb-map-view-note" data-note="block-contents" title={this.blocksDetail}>
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

  /** Renders one palace toggle, passing its plain-word reason and detail down as the tooltip (#967). */
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
        detail={icon && 'reason' in icon ? icon.detail : undefined}
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

  /**
   * The strip: checkerboard, back area (masked to fade over the gutters), one canvas stack per screen, then
   * the overlays. Every overlay is positioned from the one `pad`, so the map sits where its data says.
   */
  protected renderStrip(): React.ReactNode {
    const l = this.mapLayout
    if (!l) {
      return this.screenError ? (
        <div className="hb-map-view-error" data-control="map-error" title={this.screenErrorDetail}>
          {this.screenError}
        </div>
      ) : (
        <div className="hb-map-view-empty">Reading the ROM...</div>
      )
    }
    const pad = this.pad
    const z = this.zoom
    const [mapW, mapH] = this.mapPx(l)
    const origin = this.mapOrigin()
    // The back color is solid across the map and fades to transparent over each long-end gutter only (D48 part 2,
    // R24), by a mask, so the element's background-color stays the map's back color.
    const vertical = l.orientation === 'vertical'
    const back = `rgb(${l.backdrop.join(',')})`
    const fade = fadeMask(vertical, GUTTER_PX * z)
    // The strip's rect without the gutters: the outermost `GUTTER_PX` of each long-end pad (content grows inward of it).
    const checker = vertical ? `${GUTTER_PX * z}px 0` : `0 ${GUTTER_PX * z}px`
    return (
      <div className="hb-map-grid-host">
        <div
          className={'hb-map-view-scroller' + (l.orientation === 'vertical' ? ' hb-vertical' : '')}
          data-control="map-scroller"
          data-rendered-zoom={this.renderedZoom}
          data-start={this.startState}
          ref={this.scrollerRef}
          onScroll={e => {
            // The widget writes no offset while the start is pending (init resets to 0). The
            // start's own scrollTo runs before the state leaves 'pending', but its scroll event
            // is delivered after, so it never counts. Any offset seen here is the user's:
            // remember it even if they scroll back to 0. Only the scroll axis, as placeStart reads.
            const t = e.currentTarget
            const at = l.orientation === 'vertical' ? t.scrollTop : t.scrollLeft
            if (this.startState === 'pending' && at !== 0) this.movedBeforeStart = true
            this.requestVisible()
            // The sprite moved under a still pointer: drop the hover so it is asked for again at the new place.
            this.setHoverSprite(undefined)
            this.updateHover()
          }}
          onMouseMove={this.onPointerMove}
          onWheelCapture={this.countInput}
          onPointerDownCapture={this.countInput}
          onMouseLeave={() => {
            this.pointer = undefined
            this.setHover(undefined)
            this.setLift(undefined)
            this.setHoverSprite(undefined)
          }}
        >
          {/* Bottom to top (planes by `screens`, composited per screen): the checkerboard, the back area, then the screens,
              so hiding a layer shows what is under it, down to nothing. */}
          <div
            className="hb-map-view-strip"
            style={{ padding: `${pad.top * z}px ${pad.right * z}px ${pad.bottom * z}px ${pad.left * z}px` }} // prettier-ignore
            onClick={e => {
              const strip = e.currentTarget.getBoundingClientRect()
              // Strip pixels to map pixels: the gutter before screen 0 is not map.
              this.selectSprite(this.spriteUnder((e.clientX - strip.left) / this.zoom - pad.left, (e.clientY - strip.top) / this.zoom - pad.top)) // prettier-ignore
            }}
          >
            {/* The checkerboard is confined to the map and its content bands: the gutter, where the back color
                fades out, shows the panel behind it (D48 part 2). */}
            <div
              className="hb-checkerboard"
              data-layer="checkerboard"
              style={{ position: 'absolute', inset: checker }}
            />
            <div
              className="hb-map-view-back-area"
              data-layer="back-area"
              style={{ background: back, maskImage: fade, WebkitMaskImage: fade }}
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
            {l.refusedCells && !this.screenError && (
              <RefusedOverlay
                cells={l.refusedCells}
                width={mapW}
                height={mapH}
                zoom={this.zoom}
                pad={pad}
              />
            )}
            {this.showSprites && !this.screenError && !!this.offMapPixels() && (
              <canvas
                className="hb-map-view-offmap"
                data-layer="off-map-sprites"
                style={{ width: (mapW + pad.left + pad.right) * z, height: (mapH + pad.top + pad.bottom) * z }} // prettier-ignore
                ref={this.offMapRef}
              />
            )}
            {!this.screenError && (
              <div
                className="hb-map-view-edge"
                data-control="map-edge"
                style={{ left: pad.left * z, top: pad.top * z, width: mapW * z, height: mapH * z }}
              />
            )}
            {this.showCollision && this.collisionCurrent() && (
              <CollisionOverlay
                layer={this.collisionCurrent()!}
                zoom={this.zoom}
                owner={String(this.options?.index ?? '')}
                revision={this.collisionRevision}
                origin={{ x: origin.x * z, y: origin.y * z }}
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
            pad={pad}
          />
        )}
      </div>
    )
  }

  /**
   * The sources bottom to top over both screens, for stacking the source canvases. The one sprite
   * canvas (every priority) stands at OBJ.2's place; the other priorities have no canvas of their own.
   */
  protected layerOrder(l: Layout): LayerKey[] {
    return [...l.screens.sub, ...l.screens.main].flatMap(k =>
      k === 'sprites2' ? [SPRITES] : k.startsWith('sprites') ? [] : [k as MapPlaneKey],
    )
  }

  protected layerShown(plane: LayerKey): boolean {
    if (plane === SPRITES) return this.showSprites
    return plane.startsWith('l2') ? this.showL2 : plane.startsWith('l3') ? this.showL3 : this.showL1
  }

  /** What a reader wants at a glance: which map, how big, and what is unavailable and why. */
  protected renderFacts(): React.ReactNode {
    if (this.error) {
      return (
        <div
          className="hb-map-view-body hb-map-view-facts hb-map-view-error"
          title={this.errorDetail}
        >
          {this.error}
        </div>
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
          {this.startWhy && (
            <>
              {' · '}
              <span
                data-control="map-start-note"
                title={withDetail(this.startWhy, this.startDetail)}
              >
                start unavailable
              </span>
            </>
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
    if (!d)
      return (
        <div className="hb-map-view-empty" title={this.error ? this.errorDetail : undefined}>
          {this.error ?? 'Reading the ROM...'}
        </div>
      )
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
