/**
 * One palette group, or one variant of it, as an ordinary main-area tab.
 * Opened from the Palettes explorer through PreviewTabs, so it docks,
 * splits and pins like any other editor tab.
 *
 * One class for both kinds: a variant tab is a group tab filtered to one
 * variant. Every tab re-fetches when the working copy changes, so an edit
 * in one shows in every other tab holding the same word, with no
 * tab-to-tab messages. A project switch closes the tab: it belongs to a
 * ROM that is no longer open.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { Message, ReactWidget } from '@theia/core/lib/browser'
import {
  LoadPaletteResult,
  PaletteGroupDto,
  PaletteService,
  SetColorResult,
} from '../common/palette-protocol'
import { ProjectContext } from './project-context'
import { PaletteFrontendClient } from './palette-push-client'
import { PaletteSwatchRow } from './palette-swatch-row'
import { EditableWord, PaletteInspector } from './palette-inspector'
import { animatedColumns, cellTitle, tabTitle, targetFor, viewWidgetId } from './palette-view-model'
import { perfEndAfterPaint, perfStart } from '../common/perf-marks'

export interface PaletteGroupViewOptions {
  manifestPath: string
  groupId: string
  variant?: number
}

interface CellSelection {
  variantIdx: number
  rowIdx: number
  colIdx: number
}

@injectable()
export class PaletteGroupViewWidget extends ReactWidget {
  @inject(PaletteService) protected readonly palettes!: PaletteService
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(PaletteFrontendClient) protected readonly pushClient!: PaletteFrontendClient

  /** Exposed for tests: the service's last answer. */
  result: LoadPaletteResult | undefined
  protected options: PaletteGroupViewOptions | undefined
  protected error: string | undefined
  protected editError: string | undefined
  protected selection: CellSelection | undefined
  protected selectedFrame: number | undefined
  /** Discards a response superseded by a later request. */
  protected requestToken = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-palette-group-view')
    this.title.closable = true
    this.title.iconClass = 'codicon codicon-symbol-color'
    this.node.tabIndex = 0
    this.toDispose.push(
      this.pushClient.onChanged(mp => {
        if (mp === this.options?.manifestPath) void this.fetch()
      }),
    )
    this.toDispose.push(
      this.context.onChanged(p => {
        if (!this.options || p?.manifestPath !== this.options.manifestPath) this.close()
      }),
    )
  }

  /**
   * Theia's layout restorer recreates a saved tab through the factory and
   * never calls open(), so it would sit on "Reading the ROM..." forever.
   * preview() and pin() always open() before attaching, so only a restored
   * tab arrives here without options. Deferred so the restore finishes
   * building the dock layout before this tab leaves it.
   */
  protected override onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg)
    if (this.options) return
    setTimeout(() => {
      if (!this.options && !this.isDisposed) this.close()
    })
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  /** The inspector's animation preview pauses while the tab isn't shown. */
  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg)
    this.update()
  }

  protected override onAfterHide(msg: Message): void {
    super.onAfterHide(msg)
    this.update()
  }

  shows(o: PaletteGroupViewOptions): boolean {
    return (
      !!this.options &&
      this.options.manifestPath === o.manifestPath &&
      this.options.groupId === o.groupId &&
      this.options.variant === o.variant
    )
  }

  async open(options: PaletteGroupViewOptions): Promise<void> {
    const same = this.options && this.shows(options)
    this.options = options
    this.id = viewWidgetId(options.groupId, options.variant)
    if (!same) {
      this.selection = undefined
      this.selectedFrame = undefined
      this.editError = undefined
    }
    perfStart('open-palette')
    await this.fetch()
  }

  protected async fetch(): Promise<void> {
    const o = this.options
    if (!o) return
    const token = ++this.requestToken
    try {
      const result = await this.palettes.loadPalettes(o.manifestPath)
      if (token !== this.requestToken) return
      this.result = result
      this.error = undefined
    } catch (err) {
      if (token !== this.requestToken) return
      this.error = (err as Error).message
    }
    const g = this.group()
    this.title.label = g ? tabTitle(g, o.variant) : o.groupId
    this.title.caption = this.title.label
    this.update()
    if (g) perfEndAfterPaint('open-palette')
    // An edit is pending: the new color is on screen once this fetch paints.
    perfEndAfterPaint('edit')
  }

  protected group(): PaletteGroupDto | undefined {
    return this.result?.status === 'ok'
      ? this.result.palettes.groups.find(g => g.id === this.options?.groupId)
      : undefined
  }

  protected async commit(romAddr: number, oldHex: string, newHex: string): Promise<void> {
    const mp = this.options?.manifestPath
    if (!mp) return
    perfStart('edit')
    // Shares fetch()'s token, but gates only the grid: the write fires the
    // working-copy push synchronously, so its fetch() always supersedes this
    // response. The edit's own outcome (error set or cleared) still applies.
    const token = ++this.requestToken
    let r: SetColorResult
    try {
      r = await this.palettes.setColor(mp, romAddr, oldHex, newHex)
    } catch (err) {
      if (this.options?.manifestPath !== mp) return
      this.editError = (err as Error).message
      this.update()
      return
    }
    if (this.options?.manifestPath !== mp) return
    if (r.status === 'stale' || r.status === 'io-error') {
      this.editError = r.reason
    } else {
      if (token === this.requestToken) this.result = r
      this.editError = undefined
    }
    this.update()
  }

  protected render(): React.ReactNode {
    if (this.error) return <div className="hb-palette-error">{this.error}</div>
    const r = this.result
    if (!r) return <div className="hb-palette-empty">Reading the ROM...</div>
    if (r.status === 'rom-not-located')
      return (
        <div className="hb-palette-empty">{`Locate ${r.baseRom.title || 'the base ROM'} to view its palettes`}</div>
      )
    if (r.status === 'unreadable') return <div className="hb-palette-error">{r.reason}</div>
    const g = this.group()
    if (!g)
      return <div className="hb-palette-error">{`No palette group "${this.options?.groupId}"`}</div>

    const variants = g.variants
      .map((v, vi) => ({ v, vi }))
      .filter(({ vi }) => this.options?.variant === undefined || vi === this.options.variant)
    const targets = r.palettes.animation.targets

    return (
      <div className="hb-palette-view-layout">
        <div className="hb-palette-main">
          <header className="hb-palette-header">
            <h2 className="hb-palette-title">{this.title.label}</h2>
            <div className="hb-palette-selection-note">{g.description}</div>
          </header>
          {variants.map(({ v, vi }) => (
            <section key={vi} className="hb-palette-variant">
              {this.options?.variant === undefined && (
                <div className="hb-palette-variant-label">{v.label}</div>
              )}
              {v.rows.map((row, ri) => {
                const cgramRow = g.cgRamRow !== null ? g.cgRamRow + ri : null
                const sel = this.selection
                return (
                  <PaletteSwatchRow
                    key={ri}
                    cells={row}
                    gutter={cgramRow !== null ? `CGRAM ${cgramRow}` : undefined}
                    marker={animatedColumns(targets, cgramRow)}
                    selectedIndex={
                      sel && sel.variantIdx === vi && sel.rowIdx === ri ? sel.colIdx : undefined
                    }
                    onSelect={ci => {
                      this.selection = { variantIdx: vi, rowIdx: ri, colIdx: ci }
                      this.selectedFrame = undefined
                      this.editError = undefined
                      this.update()
                    }}
                  />
                )
              })}
            </section>
          ))}
        </div>
        {this.renderInspector(g)}
      </div>
    )
  }

  protected renderInspector(g: PaletteGroupDto): React.ReactNode {
    const sel = this.selection
    const targets = this.result?.status === 'ok' ? this.result.palettes.animation.targets : []
    const cell = sel ? g.variants[sel.variantIdx]?.rows[sel.rowIdx]?.[sel.colIdx] : undefined
    const cgramRow = sel && g.cgRamRow !== null ? g.cgRamRow + sel.rowIdx : null
    const animation = sel ? targetFor(targets, cgramRow, sel.colIdx) : undefined
    const frame =
      animation && this.selectedFrame !== undefined
        ? animation.frames[this.selectedFrame]
        : undefined

    let word: EditableWord | undefined
    let wordLabel: string | undefined
    if (frame) {
      word = { color: frame.color, table: 'Animation frame', romAddr: frame.romAddr }
      wordLabel = `Frame ${this.selectedFrame}`
    } else if (cell?.written && cell.romAddr !== null) {
      word = { color: cell.color, table: cell.table, romAddr: cell.romAddr }
      wordLabel = animation ? 'Stock value, overwritten every frame by the animation' : undefined
    }

    return (
      <PaletteInspector
        key={word?.romAddr ?? 'none'}
        title={sel ? cellTitle(g, cgramRow, sel.colIdx) : g.label}
        word={word}
        wordLabel={wordLabel}
        animation={animation}
        visible={this.isVisible}
        selectedFrame={this.selectedFrame}
        onSelectFrame={i => {
          this.selectedFrame = i
          this.editError = undefined
          this.update()
        }}
        error={this.editError}
        onCommit={(a, o, n) => void this.commit(a, o, n)}
        onDismissError={() => {
          this.editError = undefined
          this.update()
        }}
      />
    )
  }
}
