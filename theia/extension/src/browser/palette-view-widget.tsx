/**
 * The palette view: stock ROM palette tables, docked in the right sidebar
 * beside Outline. One widget, three regions - a thin group list, the
 * selected group's rows, and an inspector pinned above them for the
 * selected cell, which is also where a colour is edited.
 *
 * This shows the STOCK TABLES loadRomPalettes() reads, not the composed
 * runtime CGRAM a specific level or the overworld actually loads (that
 * needs a chosen context and Lunar Magic custom-palette detection first,
 * and is a follow-up: see palette-protocol.ts).
 *
 * Editing is deliberately simple: pick a colour (native picker or hex
 * field), click OK, one `edit` layer is recorded. There is no live preview
 * layer while picking - an earlier version tried that, and it was the
 * cause of a real bug: a preview layer left `old` unable to match the
 * cartridge's actual bytes by the time OK ran, so every commit refused.
 * With nothing written until OK, `old` is always "whatever is currently
 * committed", which is trivially still true. The "realtime" requirement
 * this satisfies is other views (GFX) re-rendering on the OWN change event
 * once OK commits - not a live-updating swatch while still choosing.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget, Message } from '@theia/core/lib/browser'
import {
  LoadPaletteResult,
  PaletteCellDto,
  PaletteColorDto,
  PaletteGroupDto,
  PaletteService,
  PaletteVariantDto,
  SetColorResult,
} from '../common/palette-protocol'
import { ProjectContext } from './project-context'
import { PaletteFrontendClient } from './palette-push-client'
import {
  bgr555HexToCssHex,
  cssHexToBgr555,
  formatBgr555,
  formatRomAddr,
  cssColor,
  normalizeBgr555Hex,
} from './palette-color-format'

export const PALETTE_VIEW_ID = 'hackbench.palette-view'

/** Which cell the inspector is showing. */
interface Selection {
  groupId: string
  variantIdx: number
  rowIdx: number
  colIdx: number
}

type WrittenCell = Extract<PaletteCellDto, { written: true }>

function writtenCell(cell: PaletteCellDto | undefined): WrittenCell | undefined {
  return cell?.written ? cell : undefined
}

@injectable()
export class PaletteViewWidget extends ReactWidget {
  @inject(PaletteService) protected readonly palettes!: PaletteService
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(PaletteFrontendClient) protected readonly pushClient!: PaletteFrontendClient

  /** Exposed for tests: the service's last answer for the open project. */
  result: LoadPaletteResult | undefined

  protected manifestPath: string | undefined
  /**
   * A FATAL condition: no palette data to show at all (the RPC to load it
   * threw). Replaces the whole view, because there is genuinely nothing
   * else to render. Never set for an edit refusal - see `editError`, which
   * is the opposite case: the grid is fine, one write declined.
   */
  protected error: string | undefined
  /**
   * One edit's refusal (a stale `setColor`, or a hex field value that will
   * not parse). Shown INSIDE the inspector, naming the address and the
   * values that disagreed, without hiding the swatch grid - a write that
   * declines and shows nothing is worse than one that throws. Cleared on
   * the next successful edit and on any selection change.
   */
  protected editError: string | undefined
  protected loading = false
  protected activeGroupId: string | undefined
  protected selection: Selection | undefined

  /**
   * A colour picked (native picker or hex field) but not yet committed.
   * Purely local: nothing is written to the working copy until OK. Cleared
   * by OK (which commits it), Cancel/Escape (which drops it), or by
   * switching the selection (an implicit abandon - the pick belonged to
   * the cell that is no longer selected).
   */
  protected pickedHex: string | undefined
  /**
   * The native colour `<input>`'s raw last-picked value (8 bits/channel),
   * kept separately from `pickedHex` (the quantized 5-bit BGR555 word) so
   * the inspector can tell "nothing picked" from "picked, but it rounded to
   * the colour already committed" - two neighbouring 8-bit picks routinely
   * quantize to the same 15-bit word, and without this OK just silently
   * never enabled, with no way to tell why.
   */
  protected pickedCssHex: string | undefined
  /** The hex field's in-progress text, while it differs from the shown value. */
  protected hexFieldDraft: string | undefined

  /**
   * Discards a response that is no longer the most recent request: without
   * it, opening project A then quickly B can have A's slower RPC resolve
   * after B's and overwrite what the user is now looking at.
   */
  protected requestToken = 0

  protected readonly onDocumentKeyDown = (e: KeyboardEvent): void => {
    // Escape abandons an unapplied pick. Purely local state, so this is
    // just clearing fields - no server round trip undoes anything, because
    // nothing was ever written. Listens on the document (not the input)
    // because a native colour picker popup does not reliably bubble its
    // own key events, and this must still work once that dialog has closed
    // and focus has moved.
    if (e.key !== 'Escape') return
    if (this.pickedHex !== undefined || this.hexFieldDraft !== undefined) this.cancelPick()
  }

  @postConstruct()
  protected init(): void {
    this.id = PALETTE_VIEW_ID
    this.title.label = 'Palettes'
    this.title.caption = 'Palettes'
    this.title.iconClass = 'codicon codicon-symbol-color'
    this.title.closable = true
    this.addClass('hb-palette-view')
    this.node.tabIndex = 0

    document.addEventListener('keydown', this.onDocumentKeyDown)
    this.toDispose.push({
      dispose: () => document.removeEventListener('keydown', this.onDocumentKeyDown),
    })

    this.toDispose.push(
      this.context.onChanged(project => {
        void this.load(project?.manifestPath)
      }),
    )

    // One-directional flow: a change to this project's working copy -
    // whichever service caused it - re-renders this view from a fresh
    // read, the same path `load` always uses. Reloading after the widget's
    // OWN edit (whose direct response already updated `result`) is a
    // harmless extra read of state that is already current, not a second,
    // divergent path: there is exactly one place `result` is ever set from.
    // `refresh`, not `load`: `load` resets which group/cell is selected,
    // which is right for OPENING a project and wrong for a same-project
    // push.
    this.toDispose.push(
      this.pushClient.onChanged(manifestPath => {
        if (manifestPath === this.manifestPath) void this.refresh(manifestPath)
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
    this.editError = undefined
    this.selection = undefined
    this.pickedHex = undefined
    this.pickedCssHex = undefined
    this.hexFieldDraft = undefined

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

  /**
   * Re-fetches the SAME project's data without resetting `activeGroupId` or
   * `selection` - the one-directional re-render a working-copy change
   * pushes, as opposed to `load`'s "a different project just opened".
   */
  protected async refresh(manifestPath: string): Promise<void> {
    const token = ++this.requestToken
    try {
      const result = await this.palettes.loadPalettes(manifestPath)
      if (token !== this.requestToken) return
      this.result = result
      this.error = undefined
    } catch (err) {
      if (token !== this.requestToken) return
      this.error = (err as Error).message
    }
    if (token !== this.requestToken) return
    this.update()
  }

  /**
   * Folds a `SetColorResult` into the widget's state and re-renders.
   * `stale` and `io-error` are EDIT refusals, not fatal ones: they go to
   * `editError` (shown inline in the inspector), and `result` - and the
   * rest of the view - is left exactly as it was.
   */
  protected applyResult(result: SetColorResult): void {
    if (result.status === 'stale' || result.status === 'io-error') {
      this.editError = result.reason
    } else {
      this.result = result
      this.editError = undefined
    }
    this.update()
  }

  /**
   * Commits one colour: `oldHex` is the currently committed word, `newHex`
   * is what OK (or hex Enter) chose.
   *
   * Wrapped in try/catch rather than left as a bare `void`-called promise:
   * `setColor` can reject (a manifest gone missing between load and edit,
   * for instance), and an unhandled rejection here previously meant the
   * click or keypress did visibly nothing at all - the exact symptom this
   * whole edit path exists to not have.
   */
  protected async applyColor(romAddr: number, oldHex: string, newHex: string): Promise<void> {
    const manifestPath = this.manifestPath
    if (!manifestPath) return
    try {
      const result = await this.palettes.setColor(manifestPath, romAddr, oldHex, newHex)
      if (this.manifestPath !== manifestPath) return // project switched mid-flight
      this.applyResult(result)
    } catch (err) {
      if (this.manifestPath !== manifestPath) return
      this.editError = (err as Error).message
      this.update()
    }
  }

  /** The colour `<input>`'s change: a plain React onChange, since nothing commits until OK. */
  protected onColorPick(value: string): void {
    this.pickedCssHex = value
    let hex: string
    try {
      hex = cssHexToBgr555(value)
    } catch {
      return
    }
    this.pickedHex = hex
    this.hexFieldDraft = undefined
    this.update()
  }

  /**
   * Keeps `pickedHex` live-synced to whatever currently parses, on every
   * keystroke - not just on Enter. `hasPick` (and so OK) reads `pickedHex`,
   * so without this, OK stayed disabled for the entire time the user was
   * typing: only Enter ever set it, which made Enter the sole way to commit
   * a typed value even though a separate OK button existed right next to
   * it. An unparseable in-progress string (a stray character, or a replace
   * that landed as an append) just leaves `pickedHex` unset - the draft
   * itself still shows exactly what was typed.
   */
  protected onHexFieldChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const value = e.currentTarget.value
    this.hexFieldDraft = value
    this.pickedCssHex = undefined // typing a hex word supersedes any prior colour-input pick
    try {
      this.pickedHex = normalizeBgr555Hex(value)
    } catch {
      this.pickedHex = undefined
    }
    this.update()
  }

  /** Enter is the keyboard accelerator for OK: it commits whatever `pickedHex` already is. Escape abandons it. */
  protected onHexFieldKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    romAddr: number,
    committedHex: string,
  ): void {
    if (e.key === 'Enter') {
      this.onOkClick(romAddr, committedHex)
    } else if (e.key === 'Escape') {
      this.cancelPick()
    }
  }

  /** OK: commits whatever is picked (native picker or hex field), against the currently committed value. */
  protected onOkClick(romAddr: number, committedHex: string): void {
    const newHex = this.pickedHex
    if (!newHex || newHex === committedHex) return // nothing picked, or it matches what is already there
    this.pickedHex = undefined
    this.pickedCssHex = undefined
    this.hexFieldDraft = undefined
    void this.applyColor(romAddr, committedHex, newHex)
  }

  /** Drops an in-progress pick without writing anything - nothing was ever sent to the server. */
  protected cancelPick(): void {
    this.pickedHex = undefined
    this.pickedCssHex = undefined
    this.hexFieldDraft = undefined
    this.editError = undefined
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

  /** Switching groups/cells silently abandons an unapplied pick: it belonged to the cell that is no longer selected. */
  protected selectGroup(id: string): void {
    this.activeGroupId = id
    this.selection = undefined
    this.pickedHex = undefined
    this.pickedCssHex = undefined
    this.hexFieldDraft = undefined
    this.editError = undefined
    this.update()
  }

  protected selectCell(sel: Selection): void {
    this.selection = sel
    this.pickedHex = undefined
    this.pickedCssHex = undefined
    this.hexFieldDraft = undefined
    this.editError = undefined
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

  /**
   * Always renders the SAME elements, populated or not - a chip, the four
   * readout fields, the edit controls, the source line - so the panel never
   * changes height on the first click (palette.css's own comment on
   * `.hb-palette-inspector`). Placeholders and disabled inputs stand in for
   * real values when nothing editable is selected.
   *
   * The readout (Index/Value/RGB/Hex) always shows the COMMITTED cell: OK
   * is the apply, so nothing there changes until it is clicked. The colour
   * chip and the colour `<input>` show the PICKED value while one is
   * in progress, which is the only "preview" this view has left - purely
   * a rendering choice, backed by no layer on the stack.
   */
  protected renderInspector(): React.ReactNode {
    const sel = this.selection
    const cell = writtenCell(this.selectedCell())
    const c: PaletteColorDto | undefined = cell?.color
    const active = !!sel && !!cell && cell.romAddr !== null

    const hex6 = c
      ? [c.r, c.g, c.b].map(n => n.toString(16).toUpperCase().padStart(2, '0')).join('')
      : '------'
    const committedHex = c ? formatBgr555(c) : '$----'
    const romAddr = active ? (cell!.romAddr as number) : null
    const variantRomAddr = this.selectedVariantRomAddr()
    const offset = romAddr !== null && variantRomAddr !== null ? romAddr - variantRomAddr : null
    const displayHex = this.pickedHex ?? committedHex
    const hexFieldValue = this.hexFieldDraft ?? (c ? displayHex.slice(1) : '')
    const hasPick = active && this.pickedHex !== undefined && this.pickedHex !== committedHex
    // The colour input is 8 bits/channel; BGR555 is 5. Two neighbouring
    // 8-bit picks routinely quantize to the SAME word already committed,
    // which without this would just leave OK disabled with no explanation.
    const quantizedToCommitted =
      active && this.pickedCssHex !== undefined && this.pickedHex === committedHex

    return (
      <div className={'hb-palette-inspector' + (active ? '' : ' hb-palette-inspector-empty')}>
        {/*
          Two FIXED rows, not one flex-wrap chain the browser reflows based
          on text length: the "from" line's text is a very different length
          empty ("Click a swatch...") vs populated ("PlayerColors $00B2C8
          +$06"), and letting it wrap into or out of the top row changed the
          inspector's total height between the two states - the exact jump
          palette.css's own comment on `.hb-palette-inspector` warns against.
          A structural second row makes the line count constant instead of
          relying on wrapping to happen to come out the same.
        */}
        <div className="hb-palette-inspector-main">
          <span
            className="hb-palette-inspector-chip"
            style={c ? { background: bgr555HexToCssHex(displayHex) } : undefined}
          />
          <div className="hb-palette-inspector-readout">
            <div>
              <span>Index</span>
              <span>{sel ? sel.colIdx : '-'}</span>
            </div>
            <div>
              <span>Value</span>
              <span>{committedHex}</span>
            </div>
            <div>
              <span>RGB</span>
              <span>{c ? `${c.r}, ${c.g}, ${c.b}` : '-, -, -'}</span>
            </div>
            <div>
              <span>Hex</span>
              <span>#{hex6}</span>
            </div>
          </div>
          <div className="hb-palette-inspector-edit">
            <input
              type="color"
              className="hb-palette-inspector-color"
              disabled={!active}
              value={c ? bgr555HexToCssHex(displayHex) : '#000000'}
              onChange={e => active && this.onColorPick(e.currentTarget.value)}
            />
            <input
              type="text"
              className="hb-palette-inspector-hex"
              disabled={!active}
              placeholder="$----"
              value={hexFieldValue}
              onChange={e => this.onHexFieldChange(e)}
              onKeyDown={e => active && this.onHexFieldKeyDown(e, romAddr as number, committedHex)}
              // Deliberately no onBlur handler: clearing the draft on blur used to
              // eat the typed value before a click on OK could read it, since a
              // mousedown on the button fires blur before its own click event.
              // The draft (and pickedHex, kept in sync by onHexFieldChange) now
              // persist until an explicit action resolves them - OK, Enter,
              // Cancel/Escape, or switching the selection.
            />
            <button
              type="button"
              className="hb-palette-inspector-ok"
              disabled={!hasPick}
              onClick={() => this.onOkClick(romAddr as number, committedHex)}
            >
              OK
            </button>
            <button
              type="button"
              className="hb-palette-inspector-cancel"
              disabled={!hasPick}
              onClick={() => this.cancelPick()}
            >
              Cancel
            </button>
          </div>
        </div>
        <div
          className={
            'hb-palette-inspector-from' + (this.editError ? ' hb-palette-inspector-from-error' : '')
          }
        >
          {this.editError
            ? this.editError
            : quantizedToCommitted
              ? 'That colour rounds to the same BGR555 word already here - nothing to apply. Try the hex field for an exact value.'
              : active
                ? `${cell!.table} ${formatRomAddr(romAddr)}${
                    offset !== null && offset >= 0
                      ? ` +$${offset.toString(16).toUpperCase().padStart(2, '0')}`
                      : ''
                  }`
                : 'Click a swatch to inspect and edit it'}
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
