/**
 * One map, opened from the explorer: its L1 (foreground), drawn by the
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
  MapDetailsDto,
  MapScreenResult,
  PalaceIconDto,
  ProjectService,
  SwitchFlagsDto,
} from '../common/project-protocol'
import { ProjectFrontendClient } from './project-push-client'
import { decodeRgba } from './map16-pixels'
import { PixelImageButton, type FrameImage } from './pixel-image-button'
import { slotLabel } from './map-explorer-widget'

export { slotLabel }
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
type Palace = keyof SwitchFlagsDto

const PALACES: Palace[] = ['yellow', 'green', 'red', 'blue']
const ZOOMS = [1, 2, 3, 4]
/** Screens fetched beyond each edge of the view. */
const MARGIN = 1
const ICON_FRAME = { width: 16, height: 16 }

/** Calls `run` after every commit of the tree it sits in: refs are attached by then. */
function AfterCommit({ run }: { run: () => void }): null {
  React.useLayoutEffect(run)
  return null
}

const title = (p: Palace) => p[0]!.toUpperCase() + p.slice(1)

/** The palace bits a screen was drawn for, yellow green red blue: `1000` is yellow pressed. */
export const palaceKey = (f: SwitchFlagsDto): string =>
  PALACES.map(p => (f[p] ? '1' : '0')).join('')

@injectable()
export class MapViewWidget extends ReactWidget {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(ProjectFrontendClient) protected readonly pushClient!: ProjectFrontendClient

  protected options: MapViewOptions | undefined
  protected details: MapDetailsDto | undefined
  protected error: string | undefined
  protected mapLayout: Layout | undefined
  protected screenError: string | undefined
  /** Each palace's block, decoded once per load, or why it cannot be drawn. */
  protected icons = new Map<Palace, { uncleared: FrameImage; cleared: FrameImage } | { reason: string }>() // prettier-ignore

  protected flags: SwitchFlagsDto = { yellow: false, green: false, red: false, blue: false }
  /** Undefined until the user zooms: the strip then fits the view. */
  protected userZoom: number | undefined
  protected fitZoom = 1
  protected readonly screens = new Map<string, ImageData>()
  protected readonly pending = new Set<string>()
  protected readonly canvases = new Map<number, HTMLCanvasElement>()
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
    this.toDispose.push(
      this.pushClient.onChanged(manifestPath => {
        if (manifestPath === this.options?.manifestPath) this.refresh()
      }),
    )
  }

  async open(options: MapViewOptions): Promise<void> {
    this.options = options
    this.id = `${MAP_VIEW_ID}:${options.index}`
    this.title.label = options.label
    this.title.caption = `${options.label} (${slotLabel(options.index)})`
    this.title.iconClass = options.iconClass ?? 'codicon codicon-map'
    this.details = undefined
    this.error = undefined
    this.mapLayout = undefined
    this.update()
    this.refresh()
  }

  /** Which slot this tab currently shows, so a pin can retire the preview of it. */
  shows(index: number): boolean {
    return this.options?.index === index
  }

  protected get zoom(): number {
    return this.userZoom ?? this.fitZoom
  }

  /** Drops every cached screen and reads the map again from the working copy. */
  protected refresh(): void {
    this.generation++
    this.screens.clear()
    this.pending.clear()
    this.screenError = undefined
    void this.loadDetails()
    void this.loadIcons()
    this.requestVisible()
  }

  protected async loadDetails(): Promise<void> {
    const o = this.options
    if (!o) return
    try {
      this.details = await this.projects.mapDetails(o.manifestPath, o.index)
      this.error = undefined
    } catch (err) {
      this.error = (err as Error).message
    }
    this.update()
  }

  protected async loadIcons(): Promise<void> {
    const o = this.options
    if (!o) return
    const r = await this.projects.mapPalaceIcons(o.manifestPath, o.index).catch(() => undefined)
    const image = (b64: string): FrameImage => ({ width: 16, height: 16, rgba: decodeRgba(b64) })
    const decoded = (i: PalaceIconDto) =>
      'cleared' in i
        ? { uncleared: image(i.uncleared), cleared: image(i.cleared) }
        : { reason: i.unavailable }
    this.icons = new Map(r?.status === 'ok' ? r.icons.map(i => [i.palace, decoded(i)]) : [])
    this.update()
  }

  protected key(screen: number): string {
    return `${palaceKey(this.flags)}:${screen}`
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
      r = await this.projects.mapScreen(o.manifestPath, o.index, screen, { ...this.flags })
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
      // Never leave an older picture standing as if it were current.
      for (const s of this.canvases.keys()) this.paint(s)
      this.update()
      return
    }
    this.screens.set(key, new ImageData(decodeRgba(r.rgbaBase64), r.width, r.height))
    const l = this.mapLayout
    if (
      !l ||
      l.screenCount !== r.screenCount ||
      l.orientation !== r.orientation ||
      l.note !== r.note
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
    this.paint(screen)
  }

  /** Paints a screen's cached picture, or clears it after a failed fetch. */
  protected paint(screen: number): void {
    const canvas = this.canvases.get(screen)
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const img = this.screens.get(this.key(screen))
    if (img) {
      ctx?.putImageData(img, 0, 0)
      canvas.dataset.drawn = `${this.generation}:${this.key(screen)}`
    } else if (this.screenError) {
      // A failed fetch: an older picture must not stand as if it were current.
      // Otherwise it stays until the reply lands, marked by its old generation.
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
      delete canvas.dataset.drawn
    }
  }

  /** Fits the map's cross axis to the view unless the user has zoomed. */
  protected fitStrip(): void {
    const l = this.mapLayout
    const el = this.scroller
    if (l && el && this.userZoom === undefined) {
      const vertical = l.orientation === 'vertical'
      const avail = vertical ? el.clientWidth : el.clientHeight
      const fit = Math.min(4, Math.max(0.25, avail / (vertical ? l.width : l.height)))
      if (avail > 0 && Math.abs(fit - this.fitZoom) > 0.001) {
        this.fitZoom = fit
        this.update()
      }
    }
    requestAnimationFrame(() => this.requestVisible())
  }

  protected togglePalace(p: Palace): void {
    this.flags = { ...this.flags, [p]: !this.flags[p] }
    this.update()
    this.requestVisible()
  }

  protected stepZoom(dir: 1 | -1): void {
    const z = this.zoom
    const next =
      dir > 0 ? ZOOMS.find(s => s > z + 0.001) : [...ZOOMS].reverse().find(s => s < z - 0.001)
    if (next === undefined) return
    this.userZoom = next
    this.update()
    requestAnimationFrame(() => this.requestVisible())
  }

  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg)
    this.fitStrip()
  }

  /**
   * Repaints every screen canvas from the cache after each React commit (see
   * `AfterCommit`): a canvas React keeps keeps its pixels, one it creates
   * starts blank. The strip's canvases are created by the render that the
   * FIRST reply triggers, after that reply was already cached, so a repaint
   * timed any other way (the old requestAnimationFrame after an update
   * request, which can run before React commits) left screen 0 blank.
   */
  protected readonly repaintAll = (): void => {
    for (const s of this.canvases.keys()) this.paint(s)
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected render(): React.ReactNode {
    const z = this.zoom
    return (
      <div className="hb-map-view-main">
        <AfterCommit run={this.repaintAll} />
        <div className="hb-map-view-toolbar">
          <span className="hb-map-view-toolbar-label">Switch palaces</span>
          {PALACES.map(p => this.renderToggle(p))}
          <span className="hb-toolbar-spacer" />
          <button
            type="button"
            data-control="zoom-out"
            className="hb-icon-btn"
            disabled={z <= ZOOMS[0]!}
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => this.stepZoom(-1)}
          >
            <span className="codicon codicon-zoom-out" />
          </button>
          <span data-control="zoom-indicator" className="hb-zoom-indicator">
            {`${Math.round(z * 100)}%`}
          </span>
          <button
            type="button"
            data-control="zoom-in"
            className="hb-icon-btn"
            disabled={z >= ZOOMS[ZOOMS.length - 1]!}
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => this.stepZoom(1)}
          >
            <span className="codicon codicon-zoom-in" />
          </button>
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
        {this.renderStrip()}
        <details className="hb-map-view-header" data-control="header-panel">
          <summary>Header</summary>
          {this.renderDecode()}
        </details>
      </div>
    )
  }

  /**
   * The palace's own block, dotted or solid, on the shared PixelImageButton
   * (the Map16 view's switch toggles use it too); its name when the ROM will
   * not say which tile.
   */
  protected renderToggle(p: Palace): React.ReactNode {
    const icon = this.icons.get(p)
    const pressed = this.flags[p]
    return (
      <PixelImageButton
        key={p}
        frame={ICON_FRAME}
        scale={1}
        image={icon && 'cleared' in icon ? (pressed ? icon.cleared : icon.uncleared) : undefined}
        label={`${title(p)} switch palace`}
        reason={icon && 'reason' in icon ? icon.reason : undefined}
        pressed={pressed}
        onClick={() => this.togglePalace(p)}
        data={{ control: `palace-${p}` }}
      />
    )
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
      <div
        className={'hb-map-view-scroller' + (l.orientation === 'vertical' ? ' hb-vertical' : '')}
        data-control="map-scroller"
        ref={el => {
          if (el === this.scroller) return
          if (this.scroller) this.resizes.unobserve(this.scroller)
          this.scroller = el
          if (el) this.resizes.observe(el)
        }}
        onScroll={() => this.requestVisible()}
      >
        {Array.from({ length: l.screenCount }, (_, s) => (
          <canvas
            key={s}
            className="hb-map-view-screen"
            data-screen={s}
            width={l.width}
            height={l.height}
            style={{ width: l.width * this.zoom, height: l.height * this.zoom }}
            ref={el => {
              if (el) this.canvases.set(s, el)
              else if (this.canvases.get(s)?.isConnected === false) this.canvases.delete(s)
            }}
          />
        ))}
      </div>
    )
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
