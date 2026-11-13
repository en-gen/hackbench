/**
 * The Objects activity: build, name and save Object definitions
 * (docs/architecture/object-definitions.md). No map is read or written, and
 * neither is the ROM: a definition is project metadata.
 *
 * Step 1 is the tileset. Until one is picked there is no sheet, so no tile
 * can be tagged. Then a role (edge or fill) is chosen and tiles are clicked:
 * a click gives the tile that role and takes any other role away, and a click
 * on a tile that already has the role untags it. The preview colors change
 * how the sheet is drawn and are never saved.
 *
 * The sheet comes from Map16Service.loadMap16, the Map16 view's own decode.
 * Every control carries a `data-control` attribute and no DOM id, for the
 * reason map16-view-widget.tsx gives.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget } from '@theia/core/lib/browser'
import { ProjectContext } from './project-context'
import {
  MAP16_PALETTE_VARIANT_COUNT,
  MAP16_TILESET_COUNT,
  Map16Service,
  Map16SheetDto,
} from '../common/map16-protocol'
import { ObjectDefinitionDto, ObjectsService, SkippedObjectDto } from '../common/objects-protocol'
import { cropRegion, decodeRgba, paintScaled, TILE_PX } from './map16-pixels'
import {
  canTag,
  NO_TAGS,
  ObjectRole,
  roleOf,
  skippedNote,
  tagTile,
  TagState,
} from './objects-view-model'

export const OBJECTS_VIEW_ID = 'hackbench.objects'

const THUMB_SCALE = 2

@injectable()
export class ObjectsWidget extends ReactWidget {
  @inject(ObjectsService) protected readonly objects!: ObjectsService
  @inject(Map16Service) protected readonly map16!: Map16Service
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  protected manifestPath: string | undefined
  protected definitions: ObjectDefinitionDto[] = []
  protected skipped: SkippedObjectDto[] = []
  /** Why the list could not be loaded at all, in words. */
  protected listNote: string | undefined
  /** The saved definition being edited, or undefined for a new one. */
  protected editId: string | undefined
  protected name = ''
  protected tileset: number | undefined
  protected tags: TagState = NO_TAGS
  protected role: ObjectRole = 'edge'
  /** Preview colors: how the sheet is drawn, never saved. */
  protected bgVariant = 0
  protected fgVariant = 0
  protected sheet: Map16SheetDto | undefined
  protected pixels: Uint8ClampedArray | undefined
  protected sheetNote: string | undefined
  protected message: string | undefined
  protected confirmingDelete = false
  /** A stale sheet response is dropped rather than overwriting a newer pick. */
  protected sheetToken = 0

  @postConstruct()
  protected init(): void {
    this.id = OBJECTS_VIEW_ID
    this.title.label = 'Objects'
    this.title.caption = 'Objects'
    this.title.iconClass = 'codicon codicon-symbol-structure'
    this.title.closable = true
    this.addClass('hb-objects-view')

    if (this.projectContext.current) void this.open(this.projectContext.current.manifestPath)
    this.toDispose.push(
      this.projectContext.onChanged(project => {
        if (project) void this.open(project.manifestPath)
        else this.close0()
      }),
    )
    // Definitions do not depend on the ROM's bytes, but their limits and the sheet's pixels do.
    this.toDispose.push(
      this.projectContext.onRomChanged(manifestPath => {
        if (manifestPath === this.manifestPath) void this.refreshAll()
      }),
    )
    this.toDispose.push(
      this.projectContext.onEdit(event => {
        if (event.subject === this.manifestPath) void this.loadSheet()
      }),
    )
  }

  protected close0(): void {
    this.manifestPath = undefined
    this.definitions = []
    this.skipped = []
    this.listNote = undefined
    this.resetEditor()
    this.update()
  }

  protected resetEditor(): void {
    this.editId = undefined
    this.name = ''
    this.tileset = undefined
    this.tags = NO_TAGS
    this.sheet = undefined
    this.pixels = undefined
    this.sheetNote = undefined
    this.message = undefined
    this.confirmingDelete = false
    this.sheetToken++
  }

  protected async open(manifestPath: string): Promise<void> {
    this.manifestPath = manifestPath
    this.resetEditor()
    await this.refreshList()
  }

  protected async refreshAll(): Promise<void> {
    await this.refreshList()
    await this.loadSheet()
  }

  protected async refreshList(): Promise<void> {
    const manifestPath = this.manifestPath
    if (!manifestPath) return
    try {
      const r = await this.objects.listObjects(manifestPath)
      if (manifestPath !== this.manifestPath) return
      if (r.status === 'ok') {
        this.definitions = r.definitions
        this.skipped = r.skipped
        this.listNote = undefined
      } else {
        this.definitions = []
        this.skipped = []
        this.listNote = 'Locate the ROM for this project first. Objects are checked against it.'
      }
    } catch (err) {
      this.definitions = []
      this.skipped = []
      this.listNote = `Objects could not be loaded: ${err instanceof Error ? err.message : String(err)}`
    }
    this.update()
  }

  protected async loadSheet(): Promise<void> {
    const manifestPath = this.manifestPath
    const tileset = this.tileset
    const token = ++this.sheetToken
    if (!manifestPath || tileset === undefined) {
      this.sheet = undefined
      this.pixels = undefined
      this.update()
      return
    }
    try {
      const r = await this.map16.loadMap16(manifestPath, tileset, 'fg', {
        bg: this.bgVariant,
        fg: this.fgVariant,
      })
      if (token !== this.sheetToken) return
      if (r.status === 'ok') {
        this.sheet = r.sheet
        this.pixels = decodeRgba(r.sheet.rgbaBase64)
        this.sheetNote = undefined
      } else {
        this.sheet = undefined
        this.pixels = undefined
        this.sheetNote =
          r.status === 'unavailable'
            ? r.reason
            : 'Locate the ROM for this project first. The tiles come from it.'
      }
    } catch (err) {
      if (token !== this.sheetToken) return
      this.sheet = undefined
      this.pixels = undefined
      this.sheetNote = `The tiles could not be loaded: ${err instanceof Error ? err.message : String(err)}`
    }
    this.update()
  }

  protected newObject = (): void => {
    this.resetEditor()
    this.update()
  }

  protected selectDefinition(def: ObjectDefinitionDto): void {
    this.editId = def.id
    this.name = def.name
    this.tileset = def.tileset
    this.tags = { edge: def.edge, fill: def.fill }
    this.message = undefined
    this.confirmingDelete = false
    this.sheet = undefined
    this.pixels = undefined
    void this.loadSheet()
    this.update()
  }

  protected pickTileset = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value === '' ? undefined : Number(e.target.value)
    if (next === this.tileset) return
    this.tileset = next
    // The same number is a different tile on another tileset, so tags do not carry over.
    this.tags = NO_TAGS
    this.message = undefined
    this.sheet = undefined
    this.pixels = undefined
    void this.loadSheet()
    this.update()
  }

  protected pickVariant(which: 'bg' | 'fg', value: number): void {
    if (which === 'bg') this.bgVariant = value
    else this.fgVariant = value
    void this.loadSheet()
  }

  protected clickTile(tile: number): void {
    if (!canTag(this.tileset)) return
    this.tags = tagTile(this.tags, tile, this.role)
    this.message = undefined
    this.update()
  }

  protected async save(): Promise<void> {
    const manifestPath = this.manifestPath
    if (!manifestPath || this.tileset === undefined) return
    const r = await this.objects.saveObject(manifestPath, {
      id: this.editId,
      name: this.name,
      tileset: this.tileset,
      edge: [...this.tags.edge],
      fill: [...this.tags.fill],
    })
    if (r.status === 'ok') {
      this.editId = r.definition.id
      this.name = r.definition.name
      this.message = `Saved "${r.definition.name}".`
    } else {
      this.message = 'reason' in r ? r.reason : 'Locate the ROM for this project first.'
    }
    await this.refreshList()
  }

  protected async rename(): Promise<void> {
    const manifestPath = this.manifestPath
    if (!manifestPath || !this.editId) return
    const r = await this.objects.renameObject(manifestPath, this.editId, this.name)
    if (r.status === 'ok') {
      this.name = r.definition.name
      this.message = `Renamed to "${r.definition.name}".`
    } else {
      this.message = 'reason' in r ? r.reason : 'Locate the ROM for this project first.'
    }
    await this.refreshList()
  }

  protected async remove(id: string): Promise<void> {
    const manifestPath = this.manifestPath
    if (!manifestPath) return
    const r = await this.objects.deleteObject(manifestPath, id)
    if (r.status === 'ok') {
      if (id === this.editId) this.resetEditor()
      this.message = 'Deleted.'
    } else {
      this.confirmingDelete = false
      this.message = 'reason' in r ? r.reason : 'Locate the ROM for this project first.'
    }
    await this.refreshList()
  }

  protected deleteClick = (): void => {
    if (!this.editId) return
    if (!this.confirmingDelete) {
      this.confirmingDelete = true
      this.update()
      return
    }
    this.confirmingDelete = false
    void this.remove(this.editId)
  }

  protected paintSheet = (el: HTMLCanvasElement | null): void => {
    if (!el || !this.sheet || !this.pixels) return
    paintScaled(el, this.pixels, this.sheet.width, this.sheet.height, 1)
  }

  protected paintThumb(el: HTMLCanvasElement | null, tile: number): void {
    if (!el || !this.sheet || !this.pixels) return
    const perRow = this.sheet.tilesPerRow
    const x = (tile % perRow) * TILE_PX
    const y = Math.floor(tile / perRow) * TILE_PX
    paintScaled(
      el,
      cropRegion(this.pixels, this.sheet.width, x, y, TILE_PX, TILE_PX),
      TILE_PX,
      TILE_PX,
      THUMB_SCALE,
    )
  }

  protected renderTileList(role: ObjectRole, label: string): React.ReactNode {
    const tiles = this.tags[role]
    return (
      <section className="hb-objects-list" data-control={`${role}-list`} data-count={tiles.length}>
        <h4>{`${label} tiles (${tiles.length})`}</h4>
        {tiles.length === 0 ? (
          <div className="hb-objects-empty">None tagged yet.</div>
        ) : (
          <ul>
            {tiles.map(t => (
              <li key={t} data-control={`${role}-item`} data-tile={t}>
                <canvas ref={el => this.paintThumb(el, t)} className="hb-objects-thumb" />
                <span>{`Tile ${t}`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  protected renderSheet(): React.ReactNode {
    if (this.tileset === undefined) {
      return (
        <div className="hb-objects-empty" data-control="sheet-placeholder">
          Pick a tileset to see its tiles.
        </div>
      )
    }
    if (this.sheetNote) {
      return (
        <div className="hb-objects-error" data-control="sheet-note">
          {this.sheetNote}
        </div>
      )
    }
    const sheet = this.sheet
    if (!sheet) return <div className="hb-objects-empty">Loading tiles...</div>
    return (
      <div
        className="hb-objects-sheet"
        data-control="sheet"
        data-tileset={sheet.tileset}
        style={{ width: sheet.width, height: sheet.height }}
      >
        <canvas
          data-control="sheet-canvas"
          ref={this.paintSheet}
          style={{ width: sheet.width, height: sheet.height }}
        />
        <div
          className="hb-objects-grid"
          style={{ gridTemplateColumns: `repeat(${sheet.tilesPerRow}, ${TILE_PX}px)` }}
        >
          {sheet.tiles.map(t => (
            <div
              key={t.id}
              data-control="tile"
              data-tile={t.id}
              data-role={roleOf(this.tags, t.id) ?? 'none'}
              className={`hb-objects-tile hb-objects-${roleOf(this.tags, t.id) ?? 'none'}`}
              title={`Tile ${t.id}. Click to give it the ${this.role} role, or to take it away.`}
              onClick={() => this.clickTile(t.id)}
            />
          ))}
        </div>
      </div>
    )
  }

  protected renderVariantSelect(which: 'bg' | 'fg', label: string, tip: string): React.ReactNode {
    return (
      <label className="hb-objects-control" title={tip}>
        {label}
        <select
          data-control={`${which}-variant-select`}
          className="theia-select"
          value={which === 'bg' ? this.bgVariant : this.fgVariant}
          disabled={this.tileset === undefined}
          onChange={e => this.pickVariant(which, Number(e.target.value))}
        >
          {Array.from({ length: MAP16_PALETTE_VARIANT_COUNT }, (_, v) => (
            <option key={v} value={v}>{`Colors ${v}`}</option>
          ))}
        </select>
      </label>
    )
  }

  protected render(): React.ReactNode {
    if (!this.manifestPath) {
      return <div className="hb-objects-empty">Open a project to build Objects.</div>
    }
    const saved = this.editId !== undefined
    const canSave = this.tileset !== undefined && this.name.trim() !== ''
    return (
      <div className="hb-objects-body">
        <section className="hb-objects-definitions" data-control="definitions">
          <div className="hb-objects-row">
            <h4>Objects</h4>
            <button
              data-control="new"
              className="theia-button secondary"
              title="Start a new Object. Nothing is saved until you press Save."
              onClick={this.newObject}
            >
              New
            </button>
            <button
              data-control="rename"
              className="theia-button secondary"
              disabled={!saved}
              title="Change the name of the selected Object. Its tiles are left as saved."
              onClick={() => void this.rename()}
            >
              Rename
            </button>
            <button
              data-control={this.confirmingDelete ? 'delete-confirm' : 'delete'}
              className="theia-button secondary"
              disabled={!saved}
              title="Delete the selected Object from this project. The ROM is not touched."
              onClick={this.deleteClick}
            >
              {this.confirmingDelete ? 'Confirm delete' : 'Delete'}
            </button>
          </div>
          {this.listNote && (
            <div className="hb-objects-error" data-control="list-note">
              {this.listNote}
            </div>
          )}
          {this.definitions.length === 0 && !this.listNote && (
            <div className="hb-objects-empty">No Objects saved yet.</div>
          )}
          <ul>
            {this.definitions.map(d => (
              <li
                key={d.id}
                data-control="definition-row"
                data-id={d.id}
                className={d.id === this.editId ? 'hb-objects-selected' : undefined}
                title={`Open "${d.name}" to edit its tiles.`}
                onClick={() => this.selectDefinition(d)}
              >
                {`${d.name} (tileset ${d.tileset})`}
              </li>
            ))}
          </ul>
          {this.skipped.map(s => (
            <div key={s.file} className="hb-objects-error" data-control="skipped-note">
              {skippedNote(s)}
            </div>
          ))}
        </section>

        <section className="hb-objects-editor" data-control="editor">
          <label
            className="hb-objects-control"
            title="Which tileset's tiles this Object is made from."
          >
            Step 1: tileset
            <select
              data-control="tileset-select"
              className="theia-select"
              value={this.tileset ?? ''}
              onChange={this.pickTileset}
            >
              <option value="">Pick a tileset</option>
              {Array.from({ length: MAP16_TILESET_COUNT }, (_, t) => (
                <option key={t} value={t}>{`Tileset ${t}`}</option>
              ))}
            </select>
          </label>
          <div className="hb-objects-row" data-control="roles">
            <span>Tag as</span>
            {(['edge', 'fill'] as const).map(r => (
              <button
                key={r}
                data-control={`role-${r}`}
                data-pressed={this.role === r}
                aria-pressed={this.role === r}
                className={`theia-button ${this.role === r ? '' : 'secondary'}`}
                disabled={this.tileset === undefined}
                title={
                  r === 'edge'
                    ? 'Edge tiles sit on the outline of the Object: its ends, sides and top.'
                    : 'Fill tiles make up the inside of the Object.'
                }
                onClick={() => {
                  this.role = r
                  this.update()
                }}
              >
                {r === 'edge' ? 'Edge' : 'Fill'}
              </button>
            ))}
          </div>
          <div className="hb-objects-row">
            {this.renderVariantSelect(
              'fg',
              'Foreground preview',
              'Try the tiles in another foreground color set. Only the preview changes; it is not saved.',
            )}
            {this.renderVariantSelect(
              'bg',
              'Background preview',
              'Try the tiles in another background color set. Only the preview changes; it is not saved.',
            )}
          </div>
          {this.renderSheet()}
          {this.renderTileList('edge', 'Edge')}
          {this.renderTileList('fill', 'Fill')}
          <div className="hb-objects-row">
            <input
              data-control="name-input"
              className="theia-input"
              type="text"
              placeholder="Name this Object"
              value={this.name}
              title="The name this Object has in this project."
              onChange={e => {
                this.name = e.target.value
                this.update()
              }}
            />
            <button
              data-control="save"
              className="theia-button"
              disabled={!canSave}
              title="Save this Object in the project. The ROM is not touched."
              onClick={() => void this.save()}
            >
              Save
            </button>
          </div>
          {this.message && (
            <div className="hb-objects-message" data-control="message">
              {this.message}
            </div>
          )}
        </section>
      </div>
    )
  }
}
