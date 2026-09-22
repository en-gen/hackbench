/**
 * The palette view: stock ROM palette tables, opened in the main editor
 * area from the activity bar. One widget, three regions - a thin group
 * list, the selected group's rows, and an inspector for the selected cell -
 * because the content needs the editor's width, not a 280px sidebar.
 *
 * This shows the STOCK TABLES loadRomPalettes() reads, not the composed
 * runtime CGRAM a specific level or the overworld actually loads (that
 * needs a chosen context and Lunar Magic custom-palette detection first,
 * and is a follow-up: see palette-protocol.ts).
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import {
  LoadPaletteResult,
  PaletteCellDto,
  PaletteGroupDto,
  PaletteService,
  PaletteVariantDto,
} from '../common/palette-protocol'
import { ProjectContext } from './project-context'
import { formatBgr555, formatRomAddr, cssColor } from './palette-color-format'

export const PALETTE_VIEW_ID = 'hackbench.palette-view'

/** Which cell the inspector is showing. */
interface Selection {
  groupId: string
  variantIdx: number
  rowIdx: number
  colIdx: number
}

@injectable()
export class PaletteViewWidget extends ReactWidget {
  @inject(PaletteService) protected readonly palettes!: PaletteService
  @inject(ProjectContext) protected readonly context!: ProjectContext

  /** Exposed for tests: the service's last answer for the open project. */
  result: LoadPaletteResult | undefined

  protected manifestPath: string | undefined
  protected error: string | undefined
  protected loading = false
  protected activeGroupId: string | undefined
  protected selection: Selection | undefined

  /**
   * Discards a response that is no longer the most recent request: without
   * it, opening project A then quickly B can have A's slower RPC resolve
   * after B's and overwrite what the user is now looking at.
   */
  protected requestToken = 0

  @postConstruct()
  protected init(): void {
    this.id = PALETTE_VIEW_ID
    this.title.label = 'Palettes'
    this.title.caption = 'Palettes'
    this.title.iconClass = 'codicon codicon-symbol-color'
    this.title.closable = true
    this.addClass('hb-palette-view')
    this.node.tabIndex = 0

    this.toDispose.push(
      this.context.onChanged(project => {
        void this.load(project?.manifestPath)
      }),
    )
    void this.load(this.context.current?.manifestPath)
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  /** Loads (or clears, for `undefined`) the palettes for a project. Public: called directly by tests. */
  async load(manifestPath: string | undefined): Promise<void> {
    const token = ++this.requestToken
    this.manifestPath = manifestPath
    this.result = undefined
    this.error = undefined
    this.selection = undefined

    if (!manifestPath) {
      this.update()
      return
    }

    this.loading = true
    this.update()
    try {
      const result = await this.palettes.loadPalettes(manifestPath)
      if (token !== this.requestToken) return // superseded by a later load()
      this.result = result
      this.activeGroupId = result.status === 'ok' ? result.palettes.groups[0]?.id : undefined
    } catch (err) {
      if (token !== this.requestToken) return
      this.error = (err as Error).message
    }
    if (token !== this.requestToken) return
    this.loading = false
    this.update()
  }

  protected render(): React.ReactNode {
    if (!this.manifestPath) {
      return <div className="hb-palette-empty">Open a project to see its palettes</div>
    }
    if (this.error) {
      return <div className="hb-palette-error">{this.error}</div>
    }
    if (this.loading || !this.result) {
      return <div className="hb-palette-empty">Reading the cartridge...</div>
    }
    if (this.result.status === 'rom-not-located') {
      const title = this.result.baseRom.title || 'the base cartridge'
      return <div className="hb-palette-empty">{`Locate ${title} to view its palettes`}</div>
    }
    if (this.result.status === 'unreadable') {
      return <div className="hb-palette-error">{this.result.reason}</div>
    }

    const { palettes, romName } = this.result
    const group = palettes.groups.find(g => g.id === this.activeGroupId) ?? palettes.groups[0]

    return (
      <div className="hb-palette-layout">
        <nav className="hb-palette-nav">
          <div className="hb-palette-nav-title">{romName}</div>
          {palettes.customPaletteLevelCount > 0 ? (
            <div className="hb-palette-warning">
              {palettes.customPaletteLevelCount} level
              {palettes.customPaletteLevelCount === 1 ? '' : 's'} override these tables with a Lunar
              Magic custom palette this view does not read.
            </div>
          ) : null}
          <div className="hb-palette-nav-section">GROUPS</div>
          {palettes.groups.map(g => (
            <div
              key={g.id}
              className={
                'hb-palette-nav-item' + (g.id === group?.id ? ' hb-palette-nav-item-active' : '')
              }
              tabIndex={0}
              onClick={() => this.selectGroup(g.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') this.selectGroup(g.id)
              }}
            >
              <div className="hb-palette-nav-label">{g.label}</div>
              <div className="hb-palette-nav-sub">
                {g.variants.length} variant{g.variants.length === 1 ? '' : 's'}
              </div>
            </div>
          ))}
          <div className="hb-palette-nav-section">OVERWORLD</div>
          <div className="hb-palette-nav-note">
            Not shown here yet: the overworld loads its own palette blocks through a different
            routine, with its own written-index set. Planned follow-up.
          </div>
        </nav>

        <div className="hb-palette-main">
          {group ? this.renderGroup(group) : null}
          <div className="hb-palette-legend">
            <span className="hb-palette-legend-swatch" /> not written by any table this view reads
          </div>
        </div>

        {this.renderInspector()}
      </div>
    )
  }

  protected selectGroup(id: string): void {
    this.activeGroupId = id
    this.selection = undefined
    this.update()
  }

  protected selectCell(sel: Selection): void {
    this.selection = sel
    this.update()
  }

  protected renderGroup(group: PaletteGroupDto): React.ReactNode {
    const rowCount = Math.max(0, ...group.variants.map(v => v.rows.length))
    const rowsLabel =
      group.cgRamRow === null
        ? ''
        : rowCount <= 1
          ? `row ${group.cgRamRow}`
          : `rows ${group.cgRamRow}-${group.cgRamRow + rowCount - 1}`

    return (
      <>
        <header className="hb-palette-header">
          <h2 className="hb-palette-title">{group.label}</h2>
          <div className="hb-palette-meta">
            {group.variants.length} variant{group.variants.length === 1 ? '' : 's'}
            {rowsLabel ? ` · ${rowsLabel}` : ''}
          </div>
          <div className="hb-palette-selection-note">{group.description}</div>
        </header>
        {group.variants.map((v, vi) => this.renderVariant(group, v, vi))}
      </>
    )
  }

  protected renderVariant(
    group: PaletteGroupDto,
    variant: PaletteVariantDto,
    vi: number,
  ): React.ReactNode {
    return (
      <section key={vi} className="hb-palette-variant">
        <div className="hb-palette-variant-label">
          {variant.label} <span className="hb-palette-addr">{formatRomAddr(variant.romAddr)}</span>
          {variant.backAreaColor ? (
            <span className="hb-palette-backarea">
              <span
                className="hb-palette-backarea-chip"
                style={{ background: cssColor(variant.backAreaColor) }}
              />
              back area {formatBgr555(variant.backAreaColor)}
            </span>
          ) : null}
        </div>
        {variant.rows.map((row, ri) => this.renderRow(group, vi, row, ri))}
      </section>
    )
  }

  protected renderRow(
    group: PaletteGroupDto,
    vi: number,
    row: PaletteCellDto[],
    ri: number,
  ): React.ReactNode {
    // Not a table name: the group header already names the table, and a row
    // can now legitimately draw from several (a background row's cols 2-7
    // are BackgroundPalettes, cols 8-15 are StatusBarColors) since every
    // cell carries its own source in its tooltip. The row index is what a
    // reader actually needs here.
    const cgramRow = group.cgRamRow !== null ? group.cgRamRow + ri : null
    const gutter = cgramRow !== null ? `CGRAM ${cgramRow}` : `Row ${ri}`
    return (
      <div key={ri} className="hb-palette-row">
        <span className="hb-palette-row-gutter">{gutter}</span>
        <div className="hb-palette-swatches">
          {row.map((cell, ci) => this.renderCell(group, vi, cell, ri, ci))}
        </div>
      </div>
    )
  }

  protected renderCell(
    group: PaletteGroupDto,
    vi: number,
    cell: PaletteCellDto,
    ri: number,
    ci: number,
  ): React.ReactNode {
    const sel = this.selection
    const isSelected =
      !!sel &&
      sel.groupId === group.id &&
      sel.variantIdx === vi &&
      sel.rowIdx === ri &&
      sel.colIdx === ci

    if (!cell.written) {
      return (
        <span
          key={ci}
          className="hb-palette-swatch hb-palette-swatch-unwritten"
          title={`Index ${ci}: not written by any table this view reads`}
        />
      )
    }

    const title = `Index ${ci} · ${cell.table} · ${formatBgr555(cell.color)} · RGB ${cell.color.r}, ${cell.color.g}, ${cell.color.b}`
    return (
      <span
        key={ci}
        className={'hb-palette-swatch' + (isSelected ? ' hb-palette-swatch-selected' : '')}
        style={{ background: cssColor(cell.color) }}
        title={title}
        onClick={() =>
          this.selectCell({ groupId: group.id, variantIdx: vi, rowIdx: ri, colIdx: ci })
        }
      />
    )
  }

  protected renderInspector(): React.ReactNode {
    const sel = this.selection
    const cell = this.selectedCell()
    if (!sel || !cell || !cell.written) {
      return (
        <div className="hb-palette-inspector hb-palette-inspector-empty">
          Click a swatch to inspect it
        </div>
      )
    }

    const c = cell.color
    const hex6 = [c.r, c.g, c.b].map(n => n.toString(16).toUpperCase().padStart(2, '0')).join('')
    const offset =
      cell.romAddr !== null && this.selectedVariantRomAddr() !== null
        ? cell.romAddr - (this.selectedVariantRomAddr() as number)
        : null

    return (
      <div className="hb-palette-inspector">
        <span className="hb-palette-inspector-chip" style={{ background: cssColor(c) }} />
        <div className="hb-palette-inspector-readout">
          <div>
            <span>Index</span>
            <span>{sel.colIdx}</span>
          </div>
          <div>
            <span>Value</span>
            <span>{formatBgr555(c)}</span>
          </div>
          <div>
            <span>RGB</span>
            <span>
              {c.r}, {c.g}, {c.b}
            </span>
          </div>
          <div>
            <span>Hex</span>
            <span>#{hex6}</span>
          </div>
        </div>
        <div className="hb-palette-inspector-from">
          {cell.table} {formatRomAddr(cell.romAddr)}
          {offset !== null && offset >= 0
            ? ` +$${offset.toString(16).toUpperCase().padStart(2, '0')}`
            : ''}
        </div>
      </div>
    )
  }

  protected selectedCell(): PaletteCellDto | undefined {
    const sel = this.selection
    if (!sel || this.result?.status !== 'ok') return undefined
    const group = this.result.palettes.groups.find(g => g.id === sel.groupId)
    return group?.variants[sel.variantIdx]?.rows[sel.rowIdx]?.[sel.colIdx]
  }

  protected selectedVariantRomAddr(): number | null {
    const sel = this.selection
    if (!sel || this.result?.status !== 'ok') return null
    const group = this.result.palettes.groups.find(g => g.id === sel.groupId)
    return group?.variants[sel.variantIdx]?.romAddr ?? null
  }
}
