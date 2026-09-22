/**
 * One BGM track, opened from the music explorer.
 *
 * Read-only, same as MapViewWidget: every field traces to MusicData.ts or
 * SpcBuilder.ts, read through trackDetails() over the wire. Nothing here
 * plays audio; see the music view's out-of-scope note for why.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { MusicService, MusicTrackDetailsDto } from '../common/music-protocol'

export const MUSIC_VIEW_ID = 'hackbench.music-view'

/** Identifies which track a widget instance shows. */
export interface MusicViewOptions {
  manifestPath: string
  bgmCommand: number
}

@injectable()
export class MusicViewWidget extends ReactWidget {
  @inject(MusicService) protected readonly music!: MusicService

  protected options: MusicViewOptions | undefined
  protected details: MusicTrackDetailsDto | undefined
  protected error: string | undefined

  @postConstruct()
  protected init(): void {
    this.addClass('hb-music-view')
    this.title.closable = true
    this.node.tabIndex = 0
  }

  async open(options: MusicViewOptions): Promise<void> {
    this.options = options
    this.id = `${MUSIC_VIEW_ID}:${options.bgmCommand}`
    const label = `Track ${options.bgmCommand}`
    this.title.label = label
    this.title.caption = label
    this.title.iconClass = 'codicon codicon-music'

    this.details = undefined
    this.error = undefined
    this.update()

    try {
      this.details = await this.music.trackDetails(options.manifestPath, options.bgmCommand)
    } catch (err) {
      this.error = (err as Error).message
    }
    this.update()
  }

  /** Which track this tab shows, so a pin can retire the preview of it. */
  shows(bgmCommand: number): boolean {
    return this.options?.bgmCommand === bgmCommand
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected render(): React.ReactNode {
    if (this.error) {
      return <div className="hb-music-view-error">{this.error}</div>
    }
    if (!this.details) {
      return <div className="hb-music-view-empty">Reading the cartridge...</div>
    }

    const d = this.details
    const rows: Array<{ label: string; value: string }> = [
      { label: 'BGM command', value: d.bgmHex },
      {
        label: 'Level music indices',
        value:
          d.levelIndices.length > 0
            ? d.levelIndices.map(i => `$${i.toString(16).toUpperCase()}`).join(', ')
            : 'none (not assigned by any level header)',
      },
      { label: 'Music bank address', value: d.bankRomAddr },
      { label: 'Music bank size', value: `${d.bankSize} bytes` },
      { label: 'Song pointer (ARAM)', value: d.aramPointer },
    ]

    return (
      <div className="hb-music-view-body">
        <h2 className="hb-music-view-title">
          <span className="hb-music-command">Track {d.bgmCommand}</span>
        </h2>

        <table className="hb-music-view-table">
          <tbody>
            {rows.map(f => (
              <tr key={f.label}>
                <th>{f.label}</th>
                <td>{f.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
}
