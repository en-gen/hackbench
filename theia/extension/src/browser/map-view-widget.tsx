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
  ProjectService,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { ProjectFrontendClient } from './project-push-client'
import { decodeRgba, TILE_PX } from './map16-pixels'
import { PALACES, screenKey } from './map-view-model'
import { SWITCH_ORDER } from './map16-view-model'
import { decodeSwitchButton, SwitchToggle, type SwitchButtonImages } from './switch-toggle'
import { LayerToggle } from './layer-icon'
import { PixelImageButton, type FrameImage } from './pixel-image-button'
import { slotLabel } from './map-explorer-widget'
import { perfEnd, perfStart } from '../common/perf-marks'

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
export class MapViewWidget extends ReactWidget {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(ProjectFrontendClient) protected readonly pushClient!: ProjectFrontendClient

  protected options: MapViewOptions | undefined
  protected details: MapDetailsDto | undefined
  protected error: string | undefined
  protected mapLayout: Layout | undefined
  protected screenError: string | undefined
  /** Each palace's block, decoded once per load, or why it cannot be drawn. */
  protected icons = new Map<Palace, PalaceIcon>()

  protected flags: SwitchFlagsDto = { yellow: false, green: false, red: false, blue: false }
  protected switches: SwitchStateDto = { blue: false, silver: false, onOff: false }
  /** The switch toggles' art (#574's), and why a kind has none. */
  protected switchArt: Partial<Record<Switch, SwitchButtonImages>> = {}
  protected switchWhy: Partial<Record<Switch, string>> = {}
  /** L1 (foreground) shown; off leaves the back area layer beneath it. */
  protected showL1 = true
  /** Undefined until the user zooms: the strip then fits the view. */
  protected userZoom: number | undefined
  protected fitZoom = 1
  protected readonly screens = new Map<string, ImageData>()
  protected readonly pending = new Set<string>()
  protected readonly canvases = new Map<number, HTMLCanvasElement>()
  protected readonly canvasRefs = new Map<number, (el: HTMLCanvasElement | null) => void>()
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
    perfStart('open-maps')
    this.options = options
    this.id = `${MAP_VIEW_ID}:${options.index}`
    this.title.label = options.label
    this.title.caption = `${options.label} (${slotLabel(options.index)})`
    this.title.iconClass = options.iconClass ?? 'codicon codicon-map'
    this.details = undefined
    this.error = undefined
    this.mapLayout = undefined
    // A reused (preview) tab keeps its strip across maps: blank it, and start at screen 0.
    for (const c of this.canvases.values()) {
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
    return screenKey(this.flags, this.switches, screen)
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
      r = await this.projects.mapScreen(o.manifestPath, o.index, screen, { ...this.flags }, { ...this.switches }) // prettier-ignore
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
    this.screens.set(key, new ImageData(decodeRgba(r.rgbaBase64), r.width, r.height))
    const l = this.mapLayout
    if (
      !l ||
      l.screenCount !== r.screenCount ||
      l.orientation !== r.orientation ||
      l.note !== r.note ||
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
   * Brings every canvas to what it should show, whatever event asked: the
   * cached picture for the current state. A toggle or an edit keeps the
   * current picture up until the new one lands, with no blank flash; only a
   * failed reply clears (and `open`, so a reused tab never shows the old
   * map). It owns the canvas size, so no React commit can clear a painted
   * canvas; `data-drawn` records only what a canvas was painted with.
   */
  protected readonly sync = (): void => {
    for (const [s, canvas] of this.canvases) {
      const want = `${this.generation}:${this.key(s)}`
      if (canvas.dataset.drawn === want) continue
      const img = this.screens.get(this.key(s))
      if (img) {
        if (canvas.width !== img.width) canvas.width = img.width
        if (canvas.height !== img.height) canvas.height = img.height
        canvas.getContext('2d')?.putImageData(img, 0, 0)
        canvas.dataset.drawn = want
        perfEnd('open-maps')
      } else if (this.screenError && canvas.dataset.drawn) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        delete canvas.dataset.drawn
      }
    }
  }

  /**
   * One stable ref per screen: React calls it only when that screen's canvas
   * mounts or unmounts, and on unmount it removes only its own canvas, never
   * a replacement. A new canvas starts blank, so it is synced at once (#421).
   */
  protected canvasRef(s: number): (el: HTMLCanvasElement | null) => void {
    let ref = this.canvasRefs.get(s)
    if (!ref) {
      let mine: HTMLCanvasElement | null = null
      ref = el => {
        if (el) {
          mine = el
          this.canvases.set(s, el)
          this.sync()
        } else {
          if (this.canvases.get(s) === mine) this.canvases.delete(s)
          mine = null
        }
      }
      this.canvasRefs.set(s, ref)
    }
    return ref
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

  protected toggleSwitch(k: Switch): void {
    this.switches = { ...this.switches, [k]: !this.switches[k] }
    this.update()
    this.requestVisible()
  }

  protected toggleL1(): void {
    this.showL1 = !this.showL1
    this.update()
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

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected render(): React.ReactNode {
    const z = this.zoom
    return (
      <div className="hb-map-view-main">
        <div className="hb-map-view-toolbar">
          <LayerToggle
            highlight="middle"
            label="Foreground"
            pressed={this.showL1}
            control="layer-l1"
            onClick={() => this.toggleL1()}
          />
          {PALACES.map(p => this.renderToggle(p))}
          {SWITCH_ORDER.map(k => (
            <SwitchToggle
              key={k}
              kind={k}
              images={this.switchArt[k]}
              pressed={this.switches[k]}
              reason={this.switchWhy[k]}
              scale={1}
              data={{ control: `switch-${k}` }}
              onClick={() => this.toggleSwitch(k)}
            />
          ))}
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
        <AfterCommit run={this.sync} />
        <details className="hb-map-view-header" data-control="header-panel">
          <summary>Header</summary>
          {this.renderDecode()}
        </details>
      </div>
    )
  }

  protected renderToggle(p: Palace): React.ReactNode {
    const icon = this.icons.get(p)
    const pressed = this.flags[p]
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
        {/* Bottom to top: the checkerboard, the back area, then the screens,
            so hiding a layer shows what is under it, down to nothing. */}
        <div className="hb-map-view-strip hb-checkerboard">
          <div
            className="hb-map-view-back-area"
            data-layer="back-area"
            style={{ background: `rgb(${l.backdrop.join(',')})` }}
          />
          {Array.from({ length: l.screenCount }, (_, s) => (
            <canvas
              key={s}
              className="hb-map-view-screen"
              data-screen={s}
              style={{ width: l.width * this.zoom, height: l.height * this.zoom, visibility: this.showL1 ? undefined : 'hidden' }} // prettier-ignore
              ref={this.canvasRef(s)}
            />
          ))}
        </div>
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
