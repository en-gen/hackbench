/**
 * SPIKE (#946, not for merge): an entry map drawn together with its sub areas on one
 * read-only canvas. The backend (`mapSubAreas`) says where each sub area sits; the
 * screens come from the same `mapScreen` reply the map view draws, composited with
 * the same `composeScreen`. No sprites, no editing, no layer toggles.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget } from '@theia/core/lib/browser'
import {
  MAP_PLANE_KEYS,
  MapScreenResult,
  MapSubAreasResult,
  ProjectService,
} from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { withFlameKeys } from './map-view-model'
import { composeScreen, type SourceKey } from '../../../../src/rom/model/ColorMath'
import type { MapViewOptions } from './map-view-widget'
import type { ProjectBound } from './project-bound'
import type { SubAreaDto } from '../../../../src/rom/subAreaLayout'

export const SUBAREAS_VIEW_ID = 'hackbench.map-subareas'
type Layout = Extract<MapScreenResult, { status: 'ok' }>
const SCALES = [0.25, 0.5, 1]
/** The view's start state: no palace cleared, no switch pressed. */
const FLAGS_OFF = { green: false, yellow: false, blue: false, red: false }
const SWITCHES_OFF = { blue: false, silver: false, onOff: false }

/** One map's region on the stage: its offset from the entry map's top-left, and its canvas. */
interface Region {
  slot: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  dto?: SubAreaDto
  backdrop?: string
  ready: boolean
  error?: string
}

@injectable()
export class SubAreasWidget extends ReactWidget implements ProjectBound {
  @inject(ProjectService) protected readonly projects!: ProjectService

  readonly projectBound = true as const
  protected options: MapViewOptions | undefined
  get manifestPath(): string | undefined {
    return this.options?.manifestPath
  }
  protected result: MapSubAreasResult | undefined
  protected regions: Region[] = []
  protected scale = 0.5
  protected readonly canvases = new Map<number, HTMLCanvasElement>()
  protected seq = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map-subareas')
    this.title.closable = true
    this.node.style.overflow = 'auto'
  }

  async open(options: MapViewOptions): Promise<void> {
    const seq = ++this.seq
    this.options = options
    this.id = `${SUBAREAS_VIEW_ID}:${options.index}`
    this.title.label = `${options.label} with sub areas`
    this.title.iconClass = 'codicon codicon-map'
    this.result = undefined
    this.regions = []
    this.update()
    const r = await this.projects.mapSubAreas(options.manifestPath, options.index)
    if (seq !== this.seq) return
    this.result = r
    if (!r.ok) return this.update()
    this.regions = [
      { slot: r.entry.slot, offsetX: 0, offsetY: 0, width: r.entry.widthPx, height: r.entry.heightPx, ready: false }, // prettier-ignore
      ...r.subAreas.map(s => ({ slot: s.slot, offsetX: s.offsetX, offsetY: s.offsetY, width: s.widthPx, height: s.heightPx, dto: s, ready: false })), // prettier-ignore
    ]
    this.update()
    await Promise.all(this.regions.map(g => this.paintRegion(g, seq)))
  }

  /** Screen 0 first (it says the orientation and the screen count), then the rest, composited into the region's canvas. */
  protected async paintRegion(g: Region, seq: number): Promise<void> {
    const manifest = this.options!.manifestPath
    const get = (screen: number) =>
      this.projects.mapScreen(manifest, g.slot, screen, FLAGS_OFF, SWITCHES_OFF)
    try {
      const first = await get(0)
      if (first.status !== 'ok') throw new Error(first.status === 'unavailable' ? first.reason : 'The base ROM is not on this machine') // prettier-ignore
      const rest = await Promise.all(
        Array.from({ length: first.screenCount - 1 }, (_, i) => get(i + 1)),
      )
      if (seq !== this.seq) return
      g.backdrop = `rgb(${first.backdrop.join(',')})`
      this.update() // the canvas exists once the region has rendered
      await new Promise(resolve => requestAnimationFrame(resolve))
      const canvas = this.canvases.get(g.slot)
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) throw new Error('No canvas for this map')
      const vertical = first.orientation === 'vertical'
      for (const [i, r] of [first, ...rest].entries()) {
        if (r.status !== 'ok') throw new Error(r.status === 'unavailable' ? r.reason : 'The base ROM is not on this machine') // prettier-ignore
        ctx.putImageData(composite(r), vertical ? 0 : i * r.width, vertical ? i * r.height : 0)
      }
      g.ready = true
    } catch (e) {
      g.error = (e as Error).message
    }
    this.update()
  }

  protected render(): React.ReactNode {
    const r = this.result
    if (!r) return <div style={{ padding: 16 }}>Reading the map and its sub areas...</div>
    if (!r.ok) return <div style={{ padding: 16 }}>{r.reason}</div>
    const minX = Math.min(0, ...this.regions.map(g => g.offsetX))
    const minY = Math.min(0, ...this.regions.map(g => g.offsetY))
    const maxX = Math.max(...this.regions.map(g => g.offsetX + g.width))
    const maxY = Math.max(...this.regions.map(g => g.offsetY + g.height))
    const [w, h] = [maxX - minX, maxY - minY]
    const allReady = this.regions.length > 0 && this.regions.every(g => g.ready || g.error)
    const notes = [
      ...r.notes.map(n => ({ who: 'This map', n })),
      ...r.subAreas.flatMap(s => s.notes.map(n => ({ who: `Sub area ${slotHex(s.slot)}`, n }))),
    ]
    return (
      <div data-ready={allReady} style={{ padding: 12 }}>
        <label>
          Zoom{' '}
          <select
            value={this.scale}
            onChange={e => {
              this.scale = Number(e.target.value)
              this.update()
            }}
          >
            {SCALES.map(s => (
              <option key={s} value={s}>
                {s * 100}%
              </option>
            ))}
          </select>
        </label>
        <div
          style={{
            width: w * this.scale,
            height: h * this.scale,
            position: 'relative',
            marginTop: 8,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: w,
              height: h,
              transform: `scale(${this.scale})`,
              transformOrigin: '0 0',
            }}
          >
            {this.regions.map(g => (
              <div
                key={g.slot}
                data-subarea-slot={g.dto ? g.slot : undefined}
                data-entry-slot={g.dto ? undefined : g.slot}
                data-offset-x={g.offsetX}
                data-offset-y={g.offsetY}
                data-kind={g.dto?.kind ?? 'entry'}
                data-ready={g.ready}
                title={`${g.dto ? 'Sub area' : 'Map'} ${slotHex(g.slot)}`}
                style={{ position: 'absolute', left: g.offsetX - minX, top: g.offsetY - minY, width: g.width, height: g.height, background: g.backdrop ?? '#222', outline: '2px solid rgba(128,128,128,0.6)' }} // prettier-ignore
              >
                <canvas
                  width={g.width}
                  height={g.height}
                  style={{ display: 'block' }}
                  ref={el => {
                    if (el) this.canvases.set(g.slot, el)
                    else this.canvases.delete(g.slot)
                  }}
                />
                {g.error && (
                  <div style={{ position: 'absolute', top: 0, color: 'red' }}>{g.error}</div>
                )}
              </div>
            ))}
            <svg
              width={w}
              height={h}
              style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
            >
              {r.subAreas.map(s => (
                <line
                  key={s.slot}
                  data-connector-slot={s.slot}
                  x1={s.exitPx.x - minX}
                  y1={s.exitPx.y - minY}
                  x2={s.offsetX + s.landingPx.x - minX}
                  y2={s.offsetY + s.landingPx.y - minY}
                  stroke="white"
                  strokeOpacity={0.55}
                  strokeWidth={4}
                  strokeDasharray="16 10"
                />
              ))}
            </svg>
          </div>
        </div>
        <ul data-notes style={{ marginTop: 12 }}>
          {r.subAreas.map(s => (
            <li key={s.slot}>
              Sub area {slotHex(s.slot)} sits {s.kind}, from screen{' '}
              {s.fromScreen.toString(16).toUpperCase()}
              {s.basis === 'heuristic' ? ' (a guess)' : ''}.
            </li>
          ))}
          {notes.map((x, i) => (
            <li key={`n${i}`}>
              {x.who}: {x.n}
            </li>
          ))}
        </ul>
      </div>
    )
  }
}

const slotHex = (n: number) => `$${n.toString(16).toUpperCase().padStart(3, '0')}`

/** One screen's picture, the planes the map view shows with its sprites off. */
function composite(r: Layout): ImageData {
  const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = {}
  for (const k of MAP_PLANE_KEYS) planes[k] = r.planes[k] ? decodeRgba(r.planes[k]!) : null
  const out = composeScreen({ width: r.width, height: r.height, planes, lists: withFlameKeys(r.screens), math: r.math }) // prettier-ignore
  return new ImageData(out, r.width, r.height)
}
