/**
 * One map, opened from the explorer.
 *
 * Not the map editor. This is what the editor will grow out of: it shows what
 * the cartridge actually says about a slot, read through the same header
 * decoder the rest of the project uses, with the five raw header bytes shown
 * beside the decode so a reader can check it rather than trust it.
 *
 * Every field traces to an ASM citation in src/rom/LevelParser.ts. Nothing is
 * inferred and nothing is defaulted: a map whose data will not parse reports
 * that, because an empty map looks exactly like one that lost its work.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { MapDetailsDto, ProjectService } from '../common/project-protocol'

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

@injectable()
export class MapViewWidget extends ReactWidget {
  @inject(ProjectService) protected readonly projects!: ProjectService

  protected options: MapViewOptions | undefined
  protected details: MapDetailsDto | undefined
  protected error: string | undefined

  @postConstruct()
  protected init(): void {
    this.addClass('hb-map-view')
    this.title.closable = true
    this.node.tabIndex = 0
  }

  async open(options: MapViewOptions): Promise<void> {
    this.options = options
    this.id = `${MAP_VIEW_ID}:${options.index}`
    this.title.label = options.label
    this.title.caption = `${options.label} (${slotLabel(options.index)})`
    this.title.iconClass = options.iconClass ?? 'codicon codicon-map'

    this.details = undefined
    this.error = undefined
    this.update()

    try {
      this.details = await this.projects.mapDetails(options.manifestPath, options.index)
    } catch (err) {
      this.error = (err as Error).message
    }
    this.update()
  }

  /** Which slot this tab currently shows, so a pin can retire the preview of it. */
  shows(index: number): boolean {
    return this.options?.index === index
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected render(): React.ReactNode {
    if (this.error) {
      return <div className="hb-map-view-error">{this.error}</div>
    }
    if (!this.details) {
      return <div className="hb-map-view-empty">Reading the ROM...</div>
    }

    const d = this.details
    const bytes = d.headerBytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')

    return (
      <div className="hb-map-view-body">
        <h2 className="hb-map-view-title">
          <span className="hb-map-slot">{slotLabel(d.index)}</span>
          {d.name ? <span className="hb-map-name">{d.name}</span> : null}
        </h2>

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
          {d.objectCount} objects{' · '}
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
