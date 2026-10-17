/**
 * The Properties view (#984): one right-hand side panel that describes whatever the app is pointing at.
 * Today that is the sprite clicked in a map; #1023 adds the map description by registering a provider for a
 * new subject kind and filling the `none` slot, with no change to the panel, its title bar or its reopen
 * command. Read only: nothing here writes, and nothing re-reads the ROM (the subject is the map view's own DTO).
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget } from '@theia/core/lib/browser'
import type { Message } from '@theia/core/shared/@lumino/messaging'
import { ProjectService, type SpritePartDto } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { PropertiesModel, PropertiesSubject } from './properties-model'
import { animatedText, LOADING_FRAMES, spriteProps } from './sprite-props'
import { FramePlayer, type FramesState } from './sprite-frames'

export const PROPERTIES_VIEW_ID = 'hackbench.properties'
export const NO_SPRITE_SELECTED = 'No sprite selected'

const hex3 = (n: number) => '$' + n.toString(16).toUpperCase().padStart(3, '0')

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

/** Every frame of a loop on one canvas: the union of their boxes, which share the first pass's origin. */
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
  // prettier-ignore
  const s = subject.sprite
  const p = spriteProps(s)
  const [w, h] = [s.box.x1 - s.box.x0, s.box.y1 - s.box.y0]
  return (
    <div className="hb-props-sprite" data-subject="sprite">
      {/* A map description (#1023) puts its "Back" link in this breadcrumb. */}
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
        {frames.kind === 'playing'
          ? animatedText(frames.frames.length)
          : frames.kind === 'loading'
            ? LOADING_FRAMES
            : `${p.animation.text}${frames.kind === 'still' && frames.reason ? ` (${frames.reason})` : ''}`}
      </div>
      <h4>Parts ({p.parts?.length ?? 0})</h4>
      <ol className="hb-props-parts" data-field="parts">
        {(p.parts ?? []).map((part, i) => (
          <li key={i}>
            Tile {hex3(part.char)}, palette row {part.palette}, {flips(part)}, offset {part.dx},{' '}
            {part.dy}
          </li>
        ))}
      </ol>
      {p.notes.map(n => (
        <div key={n} className="hb-props-note" data-field="note">
          {n}
        </div>
      ))}
    </div>
  )
}

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
    // Only a new sprite (not a re-publish of the same one) restarts the loop.
    let shown: unknown
    this.toDispose.push(
      this.model.onChange(s => {
        const sprite = s.kind === 'sprite' ? s.sprite : undefined
        if (sprite !== shown) {
          shown = sprite
          this.player.select(s.kind === 'sprite' && s.source ? { ...s.source, spriteIndex: s.sprite.index } : undefined) // prettier-ignore
        }
        this.update()
      }),
    )
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
    // #1023: a `map` subject renders here; `none` then becomes the map description.
    if (subject.kind === 'sprite')
      return <SpriteSubject subject={subject} frames={this.player.state} />
    return (
      <div className="hb-props-empty" data-subject="none">
        {NO_SPRITE_SELECTED}
      </div>
    )
  }
}
