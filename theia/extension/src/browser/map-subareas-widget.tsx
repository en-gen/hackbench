/**
 * SPIKE (#946, not for merge): the selected map at half size with its neighbours as
 * fixed-size cards (`placeCards`) joined by dashed links. A card click selects the
 * map's Maps tree node, which opens it; the view then follows `onMapOpened`.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ApplicationShell, ReactWidget, WidgetManager } from '@theia/core/lib/browser'
import {
  MAP_PLANE_KEYS,
  MapScreenResult,
  MapSubAreasResult,
  ProjectService,
} from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { withFlameKeys } from './map-view-model'
import { MAP_EXPLORER_ID, MapExplorerWidget, slotLabel } from './map-explorer-widget'
import { composeScreen, type SourceKey } from '../../../../src/rom/model/ColorMath'
import {
  CARD_H,
  CARD_W,
  cardEnd,
  fitInCard,
  mainEnd,
  placeCards,
} from '../../../../src/rom/subAreaLayout'
import type { MapViewOptions } from './map-view-widget'
import type { ProjectBound } from './project-bound'

export const SUBAREAS_VIEW_ID = 'hackbench.map-subareas'
type Layout = Extract<MapScreenResult, { status: 'ok' }>
type Result = Extract<MapSubAreasResult, { ok: true }>
/** The view's start state: no palace cleared, no switch pressed. */
const FLAGS_OFF = { green: false, yellow: false, blue: false, red: false }
const SWITCHES_OFF = { blue: false, silver: false, onOff: false }
const CSS = `.hb-map-subareas .sa-link line.vis{stroke:#888;stroke-width:1;stroke-dasharray:4 3}
.hb-map-subareas .sa-link circle{fill:#888}
.hb-map-subareas .sa-link.hot line.vis{stroke:#1a73e8;stroke-width:2.5;stroke-dasharray:none;marker-end:url(#sa-arrow-hot)}
.hb-map-subareas .sa-link.hot circle{fill:#1a73e8;r:5px}
.hb-map-subareas .sa-card.hot{outline:2px solid #1a73e8!important}`

@injectable()
export class SubAreasWidget extends ReactWidget implements ProjectBound {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(WidgetManager) protected readonly widgets!: WidgetManager
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell

  readonly projectBound = true as const
  protected options: MapViewOptions | undefined
  get manifestPath(): string | undefined {
    return this.options?.manifestPath
  }
  protected result: MapSubAreasResult | undefined
  protected explorer: MapExplorerWidget | undefined
  protected readonly canvases = new Map<number, HTMLCanvasElement>()
  protected readonly ready = new Set<number>()
  protected readonly errors = new Map<number, string>()
  protected seq = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map-subareas')
    this.title.closable = true
    this.node.style.overflow = 'auto'
    // ReactWidget's suppressScrollX scrollbar zeroes scrollLeft on every update()
    // (perfect-scrollbar update-geometry.js:86); native scrollbars instead.
    this.scrollOptions = undefined
  }

  async open(options: MapViewOptions): Promise<void> {
    const seq = ++this.seq
    this.options = options
    if (!this.id) this.id = `${SUBAREAS_VIEW_ID}:${options.index}`
    this.title.label = `${options.label} neighbours`
    this.title.iconClass = 'codicon codicon-map'
    this.result = undefined
    this.ready.clear()
    this.errors.clear()
    this.update()
    if (!this.explorer) {
      this.explorer = await this.widgets.getOrCreateWidget<MapExplorerWidget>(MAP_EXPLORER_ID)
      this.toDispose.push(
        this.explorer.onMapOpened(({ index, label }) => {
          if (this.options && index !== this.options.index) void this.open({ ...this.options, index, label }) // prettier-ignore
        }),
      )
    }
    const r = await this.projects.mapSubAreas(options.manifestPath, options.index)
    if (seq !== this.seq) return
    this.result = r
    this.update()
    if (!r.ok) return
    await new Promise(resolve => requestAnimationFrame(resolve)) // the canvases exist after this render
    await Promise.all([
      this.paint(r.entry.slot, true, seq),
      ...r.cards.map(c => this.paint(c.slot, false, seq)),
    ])
  }

  /** Renders the map's screens off-screen, then draws them 1:1 (the selected map) or letterboxed (a card). */
  protected async paint(slot: number, isEntry: boolean, seq: number): Promise<void> {
    try {
      const pic = await this.renderMap(slot)
      if (seq !== this.seq) return
      const cv = this.canvases.get(slot)
      const ctx = cv?.getContext('2d')
      if (!cv || !ctx) throw new Error('No canvas for this map')
      ctx.fillStyle = pic.backdrop
      ctx.fillRect(0, 0, cv.width, cv.height)
      const f = isEntry ? { scale: 1, ox: 0, oy: 0 } : fitInCard(pic.canvas.width, pic.canvas.height) // prettier-ignore
      ctx.drawImage(pic.canvas, f.ox, f.oy, pic.canvas.width * f.scale, pic.canvas.height * f.scale) // prettier-ignore
      this.ready.add(slot)
    } catch (e) {
      this.errors.set(slot, (e as Error).message)
    }
    this.update()
  }

  /** Screen 0 first (it says the orientation and the screen count), then the rest. */
  protected async renderMap(
    slot: number,
  ): Promise<{ canvas: HTMLCanvasElement; backdrop: string }> {
    const manifest = this.options!.manifestPath
    const get = (screen: number) =>
      this.projects.mapScreen(manifest, slot, screen, FLAGS_OFF, SWITCHES_OFF)
    const ok = (r: MapScreenResult): Layout => {
      if (r.status === 'ok') return r
      throw new Error(r.status === 'unavailable' ? r.reason : 'The base ROM is not on this machine')
    }
    const first = ok(await get(0))
    const rest = (await Promise.all(Array.from({ length: first.screenCount - 1 }, (_, i) => get(i + 1)))).map(ok) // prettier-ignore
    const vertical = first.orientation === 'vertical'
    const n = first.screenCount
    const canvas = document.createElement('canvas')
    canvas.width = vertical ? first.width : first.width * n
    canvas.height = vertical ? first.height * n : first.height
    const ctx = canvas.getContext('2d')!
    for (const [i, r] of [first, ...rest].entries()) {
      ctx.putImageData(composite(r), vertical ? 0 : i * r.width, vertical ? i * r.height : 0)
    }
    return { canvas, backdrop: `rgb(${first.backdrop.join(',')})` }
  }

  /** Same as clicking the map's row in the Maps tree. */
  protected async go(slot: number): Promise<void> {
    await this.shell.revealWidget(MAP_EXPLORER_ID)
    await this.explorer?.selectSlot(slot)
  }

  /**
   * Each link in stage pixels, `from` to `to` as drawn (the arrowhead sits at `to`). An exit
   * and a return that leave this map from the same point are drawn apart by a few pixels
   * perpendicular to the line, so both read as two lines and not one double-headed one.
   */
  protected linkGeometry(
    cards: Result['cards'],
    pos: Array<{ x: number; y: number }>,
    S: number,
    minX: number,
    minY: number,
  ) {
    // prettier-ignore
    type P = { x: number; y: number }
    const toStage = (c: Result['cards'][number], i: number, p: P, inMain: boolean): P => {
      if (inMain) return { x: p.x * S - minX, y: p.y * S - minY }
      const f = fitInCard(c.widthPx, c.heightPx)
      return { x: pos[i]!.x - minX + f.ox + p.x * f.scale, y: pos[i]!.y - minY + f.oy + p.y * f.scale } // prettier-ignore
    }
    const all = cards.flatMap((c, i) =>
      c.links.map((l, k) => {
        const m = toStage(c, i, mainEnd(l), true)
        const o = toStage(c, i, cardEnd(l), false)
        const [from, to] = l.dir === 'exit' ? [m, o] : [o, m]
        return { key: `${c.slot}:${k}`, slot: c.slot, dir: l.dir, from, to, at: `${Math.round(m.x)},${Math.round(m.y)}` } // prettier-ignore
      }),
    )
    return all.map(l => {
      const mates = all.filter(o => o.at === l.at)
      const off = (mates.indexOf(l) - (mates.length - 1) / 2) * 6
      const [dx, dy] = [l.to.x - l.from.x, l.to.y - l.from.y]
      const len = Math.hypot(dx, dy) || 1
      const [ox, oy] = [(-dy / len) * off, (dx / len) * off]
      const seg = { x1: l.from.x + ox, y1: l.from.y + oy, x2: l.to.x + ox, y2: l.to.y + oy }
      return { ...l, seg }
    })
  }

  protected setHot(slot: number, on: boolean): void {
    const sel = `[data-slot="${slot}"], [data-link^="${slot}:"]`
    this.node.querySelectorAll(sel).forEach(el => el.classList.toggle('hot', on))
  }

  protected render(): React.ReactNode {
    const r = this.result
    if (!r) return <div style={{ padding: 16 }}>Reading the map and its neighbours...</div>
    if (!r.ok) return <div style={{ padding: 16 }}>{r.reason}</div>
    const S = 0.5
    const [mw, mh] = [r.entry.widthPx * S, r.entry.heightPx * S]
    const pos = placeCards({ w: r.entry.widthPx, h: r.entry.heightPx }, r.cards.map(c => ({ side: c.side, mains: c.links.map(mainEnd) })), S) // prettier-ignore
    const minX = Math.min(0, ...pos.map(p => p.x))
    const minY = Math.min(0, ...pos.map(p => p.y))
    const w = Math.max(mw, ...pos.map(p => p.x + CARD_W)) - minX
    const h = Math.max(mh, ...pos.map(p => p.y + CARD_H)) - minY
    const allReady = [r.entry.slot, ...r.cards.map(c => c.slot)].every(s => this.ready.has(s) || this.errors.has(s)) // prettier-ignore
    const notes = [...r.notes, ...r.cards.flatMap(c => c.notes.map(n => `${slotLabel(c.slot)}: ${n}`))] // prettier-ignore
    const canvasRef = (slot: number) => (el: HTMLCanvasElement | null) => {
      if (el) this.canvases.set(slot, el)
      else this.canvases.delete(slot)
    }
    const hov = (slot: number) => ({
      onMouseEnter: () => this.setHot(slot, true),
      onMouseLeave: () => this.setHot(slot, false),
      onClick: () => void this.go(slot),
    })
    const abs = { position: 'absolute' } as const
    const links = this.linkGeometry(r.cards, pos, S, minX, minY)
    return (
      <div data-ready={allReady} style={{ padding: 12 }}>
        <style>{CSS}</style>
        <div style={{ ...abs, position: 'relative', width: w, height: h }}>
          <canvas
            data-entry-slot={r.entry.slot}
            width={r.entry.widthPx}
            height={r.entry.heightPx}
            ref={canvasRef(r.entry.slot)}
            style={{ ...abs, left: -minX, top: -minY, width: mw, height: mh, outline: '1px solid #888' }} // prettier-ignore
          />
          {r.cards.map((c, i) => (
            <div
              key={c.slot}
              className="sa-card"
              data-slot={c.slot}
              data-side={c.side}
              data-ready={this.ready.has(c.slot)}
              title={this.errors.get(c.slot) ?? `Open ${slotLabel(c.slot)}`}
              {...hov(c.slot)}
              style={{ ...abs, left: pos[i]!.x - minX, top: pos[i]!.y - minY, width: CARD_W, height: CARD_H, cursor: 'pointer', overflow: 'hidden', outline: '1px solid #888' }} // prettier-ignore
            >
              <canvas
                width={CARD_W}
                height={CARD_H}
                ref={canvasRef(c.slot)}
                style={{ display: 'block' }}
              />{' '}
              {/* prettier-ignore */}
              <div style={{ ...abs, left: 0, right: 0, bottom: 0, padding: '1px 4px', fontSize: 10, lineHeight: '12px', background: 'rgba(0,0,0,0.65)', color: '#fff' }}> {/* prettier-ignore */}
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}> {/* prettier-ignore */}
                  {this.explorer?.findSlotNode(c.slot)?.mapName ?? slotLabel(c.slot)}
                </div>
                <div>{`${slotLabel(c.slot)}, ${c.screens} scr`}</div>
              </div>
            </div>
          ))}
          <svg width={w} height={h} style={{ ...abs, left: 0, top: 0, pointerEvents: 'none' }}>
            <defs>
              {(['', '-hot'] as const).map(k => (
                <marker
                  key={k}
                  id={`sa-arrow${k}`}
                  markerWidth={9}
                  markerHeight={8}
                  refX={8}
                  refY={4}
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  {' '}
                  {/* prettier-ignore */}
                  <path d="M0,0 L9,4 L0,8 z" fill={k ? '#1a73e8' : '#888'} />
                </marker>
              ))}
            </defs>
            {links.map(l => (
              <g
                key={l.key}
                className="sa-link"
                data-link={l.key}
                data-dir={l.dir}
                data-from={`${l.from.x},${l.from.y}`}
                data-to={`${l.to.x},${l.to.y}`}
              >
                {' '}
                {/* prettier-ignore */}
                <line {...l.seg} className="vis" markerEnd="url(#sa-arrow)" />
                <circle cx={l.seg.x1} cy={l.seg.y1} r={3} />
                <line
                  {...l.seg}
                  {...hov(l.slot)}
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                />{' '}
                {/* prettier-ignore */}
              </g>
            ))}
          </svg>
        </div>
        <div data-notes style={{ marginTop: 12 }}>
          {notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      </div>
    )
  }
}

/** One screen's picture, the planes the map view shows with its sprites off. */
function composite(r: Layout): ImageData {
  const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = {}
  for (const k of MAP_PLANE_KEYS) planes[k] = r.planes[k] ? decodeRgba(r.planes[k]!) : null
  const out = composeScreen({ width: r.width, height: r.height, planes, lists: withFlameKeys(r.screens), math: r.math }) // prettier-ignore
  return new ImageData(out, r.width, r.height)
}
