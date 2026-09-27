/**
 * One map, opened from the explorer: its L1 (foreground), drawn by the
 * backend a screen at a time (#421 step 3), over the header decode.
 *
 * The strip requests only the screens in view plus one either side, and
 * caches them in THIS tab, keyed by screen and switch-palace state. Every
 * piece of view state (palaces, zoom) lives on the widget instance, so two
 * open maps never share toggles. A working-copy push drops the cache and
 * re-fetches, so an edit in any view repaints the map.
 *
 * The header decode is the secondary panel, unchanged: every field traces
 * to an ASM citation in src/rom/LevelParser.ts, shown beside the raw bytes
 * it was read from.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message, Widget } from '@theia/core/lib/browser'
import {
  MapDetailsDto,
  MapScreenResult,
  ProjectService,
  SwitchFlagsDto,
} from '../common/project-protocol'
import { ProjectFrontendClient } from './project-push-client'
import { decodeRgba } from './map16-pixels'

export const MAP_VIEW_ID = 'hackbench.map-view'

/** Identifies which map a widget instance shows. */
export interface MapViewOptions {
  manifestPath: string
  index: number
  label: string
  /** The tree row's own icon, so the tab matches where it was opened from. */
  iconClass?: string
}

export const slotLabel = (index: number): string =>
  `$${index.toString(16).toUpperCase().padStart(3, '0')}`

type Layout = Extract<MapScreenResult, { status: 'ok' }>
type Palace = keyof SwitchFlagsDto

const PALACES: Palace[] = ['yellow', 'green', 'red', 'blue']
const ZOOMS = [1, 2, 3, 4]
/** Screens fetched beyond each edge of the view. */
const MARGIN = 1

const title = (p: Palace) => p[0]!.toUpperCase() + p.slice(1)

@injectable()
export class MapViewWidget extends ReactWidget {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(ProjectFrontendClient) protected readonly pushClient!: ProjectFrontendClient

  protected options: MapViewOptions | undefined
  protected details: MapDetailsDto | undefined
  protected error: string | undefined
  protected mapLayout: Layout | undefined
  protected screenError: string | undefined

  protected flags: SwitchFlagsDto = { yellow: false, green: false, red: false, blue: false }
  protected zoom = 2
  protected readonly screens = new Map<string, ImageData>()
  protected readonly pending = new Set<string>()
  protected readonly canvases = new Map<number, HTMLCanvasElement>()
  protected scroller: HTMLDivElement | null = null
  /** Bumped on every invalidation, so a reply to an older request is dropped. */
  protected generation = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map-view')
    this.title.closable = true
    this.node.tabIndex = 0
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
    this.screenError = undefined
    this.update()
    this.refresh()
  }

  /** Which slot this tab currently shows, so a pin can retire the preview of it. */
  shows(index: number): boolean {
    return this.options?.index === index
  }

  /** Drops every cached screen and reads the map again from the working copy. */
  protected refresh(): void {
    this.generation++
    this.screens.clear()
    this.pending.clear()
    void this.loadDetails()
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

  protected key(screen: number): string {
    const f = this.flags
    return `${+f.yellow}${+f.green}${+f.red}${+f.blue}:${screen}`
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
      this.update()
      return
    }
    this.screens.set(key, new ImageData(decodeRgba(r.rgbaBase64), r.width, r.height))
    const l = this.mapLayout
    if (!l || l.screenCount !== r.screenCount || l.orientation !== r.orientation) {
      // The first reply sizes the strip; the screens in view follow once it is laid out.
      this.mapLayout = r
      this.screenError = undefined
      this.update()
      requestAnimationFrame(() => this.requestVisible())
    }
    this.paint(screen)
  }

  protected paint(screen: number): void {
    const canvas = this.canvases.get(screen)
    const img = this.screens.get(this.key(screen))
    // A screen not yet fetched for the current palaces keeps what it shows:
    // the reply replaces it, rather than flashing blank.
    if (!canvas || !img) return
    canvas.getContext('2d')?.putImageData(img, 0, 0)
    canvas.dataset.drawn = this.key(screen)
  }

  protected togglePalace(p: Palace): void {
    this.flags = { ...this.flags, [p]: !this.flags[p] }
    this.update()
    for (const s of this.canvases.keys()) this.paint(s)
    this.requestVisible()
  }

  protected setZoom(zoom: number): void {
    this.zoom = zoom
    this.update()
    requestAnimationFrame(() => this.requestVisible())
  }

  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg)
    this.requestVisible()
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected render(): React.ReactNode {
    const zi = ZOOMS.indexOf(this.zoom)
    return (
      <div className="hb-map-view-main">
        <div className="hb-map-view-toolbar">
          <span className="hb-map-view-toolbar-label">Switch palaces</span>
          {PALACES.map(p => (
            <button
              key={p}
              type="button"
              data-control={`palace-${p}`}
              className={`hb-map-view-toggle hb-palace-${p}` + (this.flags[p] ? ' hb-on' : '')}
              aria-pressed={this.flags[p]}
              title={`${title(p)} switch palace pressed`}
              onClick={() => this.togglePalace(p)}
            >
              {title(p)}
            </button>
          ))}
          <span className="hb-map-view-spacer" />
          <button
            type="button"
            data-control="zoom-out"
            className="hb-map-view-icon-btn"
            disabled={zi <= 0}
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => this.setZoom(ZOOMS[zi - 1]!)}
          >
            <span className="codicon codicon-zoom-out" />
          </button>
          <span data-control="zoom-indicator" className="hb-map-view-zoom">{`${this.zoom}x`}</span>
          <button
            type="button"
            data-control="zoom-in"
            className="hb-map-view-icon-btn"
            disabled={zi >= ZOOMS.length - 1}
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => this.setZoom(ZOOMS[zi + 1]!)}
          >
            <span className="codicon codicon-zoom-in" />
          </button>
        </div>
        {this.renderStrip()}
        <details className="hb-map-view-header" data-control="header-panel">
          <summary>Header</summary>
          {this.renderDetails()}
        </details>
      </div>
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
          this.scroller = el
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
              if (!el) return void this.canvases.delete(s)
              const fresh = this.canvases.get(s) !== el
              this.canvases.set(s, el)
              if (fresh) this.paint(s)
            }}
          />
        ))}
      </div>
    )
  }

  protected renderDetails(): React.ReactNode {
    if (this.error) {
      return <div className="hb-map-view-error">{this.error}</div>
    }
    if (!this.details) {
      return <div className="hb-map-view-empty">Reading the ROM...</div>
    }

    const d = this.details
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
    if (!d.headerBytes || !d.header) {
      return (
        <div className="hb-map-view-body">
          {title}
          <div className="hb-map-view-summary">
            <span title={d.levelDataUnavailable}>level data unavailable</span>
          </div>
        </div>
      )
    }
    const bytes = d.headerBytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')

    return (
      <div className="hb-map-view-body">
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
      </div>
    )
  }
}
