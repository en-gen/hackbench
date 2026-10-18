/**
 * The Properties view (#984): one right-hand side panel that describes whatever the app is pointing at.
 * Today that is the sprite clicked in a map. A subject kind is drawn by a renderer in `SUBJECT_RENDERERS`
 * (sprite and none are registered below), so #1023 adds the map description by extending `PropertiesSubject`
 * with a `map` kind and calling `registerSubjectRenderer('map', ...)`, with no edit to `render()`, the title
 * bar or the reopen command. Not built here: the notes summary, and the Back link of the breadcrumb.
 * Read only: nothing here writes, and nothing re-reads the ROM (the subject is the map view's own DTO).
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget } from '@theia/core/lib/browser'
import type { Message } from '@theia/core/shared/@lumino/messaging'
import { ProjectService, type SpritePartDto } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { formatCharNum } from './map16-view-model'
import { PropertiesModel, PropertiesSubject } from './properties-model'
import { animationText, spriteProps } from './sprite-props'
import { FramePlayer, type FramesState } from './sprite-frames'
import { followSubject } from './properties-follow'

export const PROPERTIES_VIEW_ID = 'hackbench.properties'
export const NO_SPRITE_SELECTED = 'No sprite selected'

/** The composite, painted at the art's own size and magnified by CSS so it stays nearest-neighbour. */
function Composite({
  pixels,
  w,
  h,
  frame,
}: {
  pixels: Uint8ClampedArray
  w: number
  h: number
  frame?: number
}): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement>(null)
  React.useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    ctx?.putImageData(new ImageData(pixels as never, w, h), 0, 0)
  }, [pixels, w, h])
  const scale = Math.max(1, Math.floor(160 / Math.max(w, h)))
  return (
    <canvas
      ref={ref}
      className="hb-props-composite"
      data-control="sprite-composite"
      data-frame={frame}
      width={w}
      height={h}
      style={{ width: w * scale, height: h * scale }}
    />
  )
}

const flips = (p: SpritePartDto) => [p.flipX && 'flip X', p.flipY && 'flip Y'].filter(Boolean).join(', ') || 'no flip' // prettier-ignore

/** Every frame of a loop on one canvas: the union of their boxes; the frames share the chosen pass's anchor. */
function framesView(f: Extract<FramesState, { kind: 'playing' }>) {
  const [x0, y0] = [Math.min(...f.frames.map(q => q.box.x0)), Math.min(...f.frames.map(q => q.box.y0))] // prettier-ignore
  const [w, h] = [Math.max(...f.frames.map(q => q.box.x1)) - x0, Math.max(...f.frames.map(q => q.box.y1)) - y0] // prettier-ignore
  const q = f.frames[f.current]!
  // Re-seat the frame's bitmap on the shared canvas so a smaller pose does not jump.
  const src = decodeRgba(q.rgba)
  const out = new Uint8ClampedArray(w * h * 4)
  const [fw, fh] = [q.box.x1 - q.box.x0, q.box.y1 - q.box.y0]
  for (let y = 0; y < fh; y++)
    out.set(
      src.subarray(y * fw * 4, (y + 1) * fw * 4),
      ((q.box.y0 - y0 + y) * w + q.box.x0 - x0) * 4,
    )
  return { pixels: out, w, h }
}

function SpriteSubject({
  subject,
  frames,
}: {
  subject: Extract<PropertiesSubject, { kind: 'sprite' }>
  frames: FramesState
}): React.ReactElement {
  const s = subject.sprite
  const p = spriteProps(s)
  const [w, h] = [s.box.x1 - s.box.x0, s.box.y1 - s.box.y0]
  return (
    <div className="hb-props-sprite" data-subject="sprite">
      {p.notes.map(n => (
        <div
          key={n}
          className="hb-props-note"
          data-field="note"
          title={n.startsWith('Not drawn') ? p.rawReason : undefined}
        >
          {n}
        </div>
      ))}
      {/* #1023: the map's notes summary sits above the breadcrumb (docs design map-facts-properties.md); its "Back" link goes in the breadcrumb. */}
      <div className="hb-props-crumb" data-control="crumb">
        Sprite
      </div>
      <h3 data-field="label">{p.label}</h3>
      <dl>
        <dt>Sprite</dt>
        <dd data-field="id">{'$' + p.id.toString(16).toUpperCase().padStart(2, '0')}</dd>
        <dt>Name</dt>
        <dd data-field="name">{p.name ?? 'No name known'}</dd>
        <dt>Position</dt>
        <dd data-field="position">
          Column {p.col}, row {p.row}
        </dd>
        <dt>Palette rows</dt>
        <dd data-field="palette-rows">
          {p.paletteRows.length ? p.paletteRows.join(', ') : 'None'}
        </dd>
      </dl>
      {frames.kind === 'playing' ? (
        <Composite {...framesView(frames)} frame={frames.current} />
      ) : (
        <Composite pixels={decodeRgba(s.rgba)} w={w} h={h} />
      )}
      <div className="hb-props-anim" data-field="animation">
        {animationText(frames)}
      </div>
      <h4>Parts ({p.parts?.length ?? 0})</h4>
      <ol className="hb-props-parts" data-field="parts">
        {(p.parts ?? []).map((part, i) => (
          <li key={i}>
            Tile {formatCharNum(part.char)}, palette row {part.palette}, {flips(part)}, offset{' '}
            {part.dx}, {part.dy}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** What a renderer is given besides its subject. */
export interface RenderContext {
  frames: FramesState
}
type SubjectOf<K extends PropertiesSubject['kind']> = Extract<PropertiesSubject, { kind: K }>
type Renderer = (subject: PropertiesSubject, ctx: RenderContext) => React.ReactNode

/** One renderer per subject kind: a new kind registers here and `render()` never changes (#1023). */
export const SUBJECT_RENDERERS = new Map<string, Renderer>()
export function registerSubjectRenderer<K extends PropertiesSubject['kind']>(
  kind: K,
  render: (subject: SubjectOf<K>, ctx: RenderContext) => React.ReactNode,
): void {
  SUBJECT_RENDERERS.set(kind, render as unknown as Renderer)
}

registerSubjectRenderer('sprite', (subject, ctx) => (
  <SpriteSubject subject={subject} frames={ctx.frames} />
))
registerSubjectRenderer('none', () => (
  <div className="hb-props-empty" data-subject="none">
    {NO_SPRITE_SELECTED}
  </div>
))

@injectable()
export class PropertiesWidget extends ReactWidget {
  @inject(PropertiesModel) protected readonly model!: PropertiesModel
  @inject(ProjectService) protected readonly projects!: ProjectService
  protected player!: FramePlayer

  @postConstruct()
  protected init(): void {
    this.id = PROPERTIES_VIEW_ID
    this.title.label = 'Properties'
    this.title.caption = 'Properties'
    this.title.iconClass = 'codicon codicon-info'
    this.title.closable = true
    this.addClass('hb-props')
    this.player = new FramePlayer(src => this.projects.mapSpriteFrames(src.manifestPath, src.index, src.spriteIndex)) // prettier-ignore
    this.toDispose.push(this.player)
    this.toDispose.push(this.player.onChange(() => this.update()))
    // Starts with the subject already published: the click that opened this panel published first.
    this.toDispose.push(followSubject(this.model, this.player, () => this.update()))
    this.update()
  }

  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg)
    this.player.setVisible(true)
  }

  protected override onAfterHide(msg: Message): void {
    super.onAfterHide(msg)
    this.player.setVisible(false)
  }

  protected render(): React.ReactNode {
    const subject = this.model.subject
    return SUBJECT_RENDERERS.get(subject.kind)?.(subject, { frames: this.player.state }) ?? null
  }
}
