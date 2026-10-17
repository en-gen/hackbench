/**
 * The Properties view (#984): one right-hand side panel that describes whatever the app is pointing at.
 * Today that is the sprite clicked in a map; #1023 adds the map description by registering a provider for a
 * new subject kind and filling the `none` slot, with no change to the panel, its title bar or its reopen
 * command. Read only: nothing here writes, and nothing re-reads the ROM (the subject is the map view's own DTO).
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget } from '@theia/core/lib/browser'
import type { SpritePartDto } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { PropertiesModel, PropertiesSubject } from './properties-model'
import { spriteProps } from './sprite-props'

export const PROPERTIES_VIEW_ID = 'hackbench.properties'
export const NO_SPRITE_SELECTED = 'No sprite selected'

const hex3 = (n: number) => '$' + n.toString(16).toUpperCase().padStart(3, '0')

/** The composite, painted at the art's own size and magnified by CSS so it stays nearest-neighbour. */
function Composite({ rgba, w, h }: { rgba: string; w: number; h: number }): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement>(null)
  React.useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    ctx?.putImageData(new ImageData(decodeRgba(rgba) as never, w, h), 0, 0)
  }, [rgba, w, h])
  const scale = Math.max(1, Math.floor(160 / Math.max(w, h)))
  return (
    <canvas
      ref={ref}
      className="hb-props-composite"
      data-control="sprite-composite"
      width={w}
      height={h}
      style={{ width: w * scale, height: h * scale }}
    />
  )
}

const flips = (p: SpritePartDto) => [p.flipX && 'flip X', p.flipY && 'flip Y'].filter(Boolean).join(', ') || 'no flip' // prettier-ignore

function SpriteSubject({
  subject,
}: {
  subject: Extract<PropertiesSubject, { kind: 'sprite' }>
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
      <Composite rgba={s.rgba} w={w} h={h} />
      <div className="hb-props-anim" data-field="animation">
        {p.animation.text}
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

  @postConstruct()
  protected init(): void {
    this.id = PROPERTIES_VIEW_ID
    this.title.label = 'Properties'
    this.title.caption = 'Properties'
    this.title.iconClass = 'codicon codicon-info'
    this.title.closable = true
    this.addClass('hb-props')
    this.toDispose.push(this.model.onChange(() => this.update()))
    this.update()
  }

  protected render(): React.ReactNode {
    const subject = this.model.subject
    // #1023: a `map` subject renders here; `none` then becomes the map description.
    if (subject.kind === 'sprite') return <SpriteSubject subject={subject} />
    return (
      <div className="hb-props-empty" data-subject="none">
        {NO_SPRITE_SELECTED}
      </div>
    )
  }
}
