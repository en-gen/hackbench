/**
 * One WorkingRom per open project, keyed by manifest path.
 *
 * Shared across every backend service that needs to read or edit the
 * project's cartridge (palette, GFX, ...), so an edit made through one view
 * is visible to all of them without re-reading the base ROM from disk each
 * time. See docs/glossary.md, "Working copy".
 *
 * No Theia import: this is plain TypeScript, bound into the DI container by
 * the Theia module as a constant, the same way RomRegistry is used directly
 * by each `*ServiceImpl` today.
 */
import { openProject, Project, RomIdentity } from './Project'
import { RomRegistry } from './RomRegistry'
import { RomFile } from '../rom/RomFile'
import { Layer, WorkingRom } from './WorkingRom'
import { COPIER_HEADER_SIZE } from '../rom/addressing'
import { ArenaResult, arenaLayerOps } from '../rom/GfxArena'
import { GfxPixelOp, GfxTable, planGfxSave } from '../rom/GfxTable'
import { hasGfxOps, loadGfxOps, saveGfxOps } from './GfxOpsStore'
import {
  loadLayers,
  appendLayer,
  popLayer,
  loadRedoLayers,
  pushRedoLayer,
  popRedoLayer,
  clearRedo,
} from './OpsStore'

export interface WorkingRomEntry {
  working: WorkingRom
  romPath: string
  project: Project
}

export type WorkingRomResult =
  | ({ status: 'ok' } & WorkingRomEntry)
  | { status: 'rom-not-located'; baseRom: RomIdentity }
  | { status: 'unreadable'; reason: string }

/**
 * What undo/redo can do right now, and what each would be called.
 *
 * The labels are the layers' own, so the caller can say "Undo set $00B2CE to
 * $03E0" rather than a bare "Undo": which edit is about to disappear is the
 * one thing a user needs before pressing it.
 */
export interface EditStackState {
  canUndo: boolean
  canRedo: boolean
  /** Label of the layer undo would take off, or null when there is none. */
  undoLabel: string | null
  /** Label of the layer redo would put back, or null when there is none. */
  redoLabel: string | null
}

export type EditStackResult =
  | ({ status: 'ok' } & EditStackState)
  | { status: 'rom-not-located'; baseRom: RomIdentity }
  | { status: 'unreadable'; reason: string }
  | { status: 'stale'; reason: string }
  | { status: 'io-error'; reason: string }

/** The one derived layer: rebuilt on every save, never persisted. */
export const GFX_ARENA_LAYER_ID = 'gfx-arena'

interface GfxState {
  table: GfxTable
  ops: GfxPixelOp[]
  /** Ops the table would not take, e.g. a tile a re-imported cart no longer
   *  has. Skipped rather than fatal, the same way EditStack.toLayers treats
   *  a stale level edit. */
  skipped: GfxPixelOp[]
  lastSave: ArenaResult | null
  bytesChanged: number
}

export type GfxTableResult =
  | { status: 'ok'; table: GfxTable; skipped: GfxPixelOp[]; lastSave: ArenaResult | null }
  | { status: 'rom-not-located'; baseRom: RomIdentity }
  | { status: 'unreadable'; reason: string }

export type SetGfxPixelResult =
  | { status: 'ok' }
  | { status: 'refused'; reason: string }
  | { status: 'rom-not-located'; baseRom: RomIdentity }
  | { status: 'unreadable'; reason: string }
  | { status: 'io-error'; reason: string }

export type SaveGfxResult =
  | { status: 'ok'; bytesChanged: number }
  | ArenaResult
  | { status: 'rom-not-located'; baseRom: RomIdentity }
  | { status: 'unreadable'; reason: string }

export interface SetColorRequest {
  /** 24-bit SNES address of the CGRAM word being changed. */
  romAddr: number
  /** BGR555 word currently committed there, hex string e.g. "$391F". */
  oldHex: string
  /** BGR555 word to write, hex string e.g. "$03E0". */
  newHex: string
}

function addrHex(romAddr: number): string {
  return `$${romAddr.toString(16).toUpperCase().padStart(6, '0')}`
}

export class WorkingRomRegistry {
  private readonly cache = new Map<string, WorkingRomEntry>()
  private readonly gfx = new Map<string, GfxState>()

  constructor(private readonly registry: RomRegistry = new RomRegistry()) {}

  /**
   * The working copy for a project, loading and replaying its persisted
   * layers on first access. Cached after that: the point of this class is
   * that in-memory state (which services share it with) survives between
   * calls in the same backend process.
   */
  get(manifestPath: string): WorkingRomResult {
    const cached = this.cache.get(manifestPath)
    if (cached) return { status: 'ok', ...cached }

    // openProject throws on a missing/corrupt/orphaned manifest, same as
    // the block below throws on a bad cartridge - both are "we could not
    // stand this project up", so both fold into the one `unreadable`
    // result rather than one of them escaping as an unhandled rejection.
    let project: Project
    let romPath: string
    let working: WorkingRom
    try {
      project = openProject(manifestPath)
      const resolved = this.registry.resolve(project.baseRom.sha256)
      if (!resolved) return { status: 'rom-not-located', baseRom: project.baseRom }
      romPath = resolved
      const rom = RomFile.load(romPath)
      working = new WorkingRom(rom.buffer, rom.hasHeader)
      for (const layer of loadLayers(project.directory)) {
        working.append(layer)
      }
    } catch (err) {
      return { status: 'unreadable', reason: (err as Error).message }
    }

    const entry: WorkingRomEntry = { working, romPath, project }
    this.cache.set(manifestPath, entry)

    // The arena rewrite is derived, not persisted, so a project that HAS
    // painted pixels has to rebuild it here or an export made before the
    // next save would ship the unedited graphics. A project with none pays
    // nothing: decoding 50 GFX files on every open, for a session that may
    // never look at them, is work nobody asked for. A cartridge that cannot
    // take the repack (no room, non-stock compression) opens anyway with
    // the reason on `lastSave`, because refusing to open the project would
    // be a far worse answer than opening it and saying so.
    if (hasGfxOps(project.directory)) this.rebuildGfx(entry, manifestPath)

    // AFTER everything that appends: `append` clears the redo future, so
    // seeding first would wipe the very stack this is restoring.
    working.restoreRedo(loadRedoLayers(project.directory))
    return { status: 'ok', ...entry }
  }

  /**
   * Applies one colour edit: records and PERSISTS one `edit` layer - the
   * write-back that makes the change survive a reload.
   *
   * Returns `stale` rather than throwing when the address no longer holds
   * `oldHex` (WorkingRom.append's own refusal), so the caller can tell the
   * user their edit target moved instead of silently corrupting a different
   * colour. Since nothing writes to the working copy between the caller
   * reading the committed value and calling this, `oldHex` should always
   * match - a `stale` result here means a genuine race (another edit landed
   * first), not routine drift.
   *
   * `working.append` runs BEFORE `appendLayer`'s disk write on purpose:
   * `append` is what validates `old`, and validating requires the layer to
   * already exist so `WorkingRom` can check it against the state below it -
   * there is no separate "just validate, do not apply" step to call first.
   * If the disk write then fails (a read-only `ops/`, a full disk, the file
   * locked by another process), the in-memory layer is popped straight back
   * off before this returns: an edit that stayed live in memory but never
   * reached disk would render as committed to every view watching the
   * working copy, then be gone the next time the project opens - worse than
   * refusing it.
   */
  setColor(
    manifestPath: string,
    req: SetColorRequest,
  ):
    | WorkingRomResult
    | { status: 'stale'; reason: string }
    | { status: 'io-error'; reason: string } {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const { working, project } = r

    const layer: Layer = {
      id: `edit-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`,
      label: `set ${addrHex(req.romAddr)} to ${req.newHex}`,
      scope: 'edit',
      ops: [{ address: addrHex(req.romAddr), old: req.oldHex, new: req.newHex }],
    }

    try {
      working.append(layer)
    } catch (err) {
      return { status: 'stale', reason: (err as Error).message }
    }

    try {
      // `append` has already ended the redo future in memory; this is the
      // same decision on disk. Done BEFORE the write so a failure leaves the
      // two agreeing - a disk redo the working copy no longer knows about
      // would come back, applicable, on the next launch.
      clearRedo(project.directory)
      appendLayer(project.directory, layer)
    } catch (err) {
      working.pop() // roll back: it never actually took effect
      return { status: 'io-error', reason: (err as Error).message }
    }

    return r
  }

  // ── Graphics ──────────────────────────────────────────────────────────
  //
  // Pixel ops are held DECODED in a GfxTable and only turned into cartridge
  // bytes on save: re-compressing 50 files on every brush stroke is not
  // viable, and the consequence, that the cartridge does not reflect an edit
  // until save, is a tradeoff the UI has to state rather than hide.

  /** The decoded sheets for a project, with the ops replayed into them. */
  gfxTable(manifestPath: string): GfxTableResult {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const state = this.gfx.get(manifestPath) ?? this.rebuildGfx(r, manifestPath)
    return { status: 'ok', table: state.table, skipped: state.skipped, lastSave: state.lastSave }
  }

  /**
   * Paint one pixel: apply it to the table and PERSIST the op.
   *
   * The op reaches disk before this returns, the same contract `setColor`
   * has, so a stroke the user saw take effect cannot be lost by closing the
   * window. What does NOT happen here is the encode: that is `saveGfx`.
   */
  setGfxPixel(manifestPath: string, op: GfxPixelOp): SetGfxPixelResult {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const state = this.gfx.get(manifestPath) ?? this.rebuildGfx(r, manifestPath)

    const applied = state.table.setPixel(op)
    if (applied.status !== 'ok') return { status: 'refused', reason: applied.reason }

    state.ops.push(op)
    try {
      saveGfxOps(r.project.directory, state.ops)
    } catch (err) {
      state.ops.pop()
      // Undoing the pixel means putting back what was under it, and the op
      // did not record that. Rebuilding the table from the ops that DID
      // reach disk is the honest recovery: what the user sees next matches
      // what would come back on reopen.
      this.rebuildGfx(r, manifestPath)
      return { status: 'io-error', reason: (err as Error).message }
    }
    return { status: 'ok' }
  }

  /**
   * Encode every file, lay the arena out, and put the result on the working
   * copy as one derived layer.
   *
   * Derived, not persisted: the pixel ops are the record, and the layer is
   * recomputed from them. It is removed before it is rebuilt so a second
   * save supersedes the first rather than stacking another copy of the
   * region on top of it.
   */
  saveGfx(manifestPath: string): SaveGfxResult {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const state = this.gfx.get(manifestPath) ?? this.rebuildGfx(r, manifestPath)

    const outcome = this.deriveGfxLayer(r, state)
    state.lastSave = outcome
    if (outcome.status !== 'ok') return outcome
    return { status: 'ok', bytesChanged: state.bytesChanged }
  }

  /**
   * Rebuild the table from the cartridge as it stands WITHOUT the derived
   * layer, then replay the ops into it.
   *
   * Without the removal the templates would be the relaid streams from the
   * last save rather than the cartridge's own, and each save would re-encode
   * against its own previous output.
   */
  private rebuildGfx(entry: WorkingRomEntry, key: string): GfxState {
    entry.working.removeById(GFX_ARENA_LAYER_ID)
    const rom = RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes()))
    const table = GfxTable.load(rom)
    let ops: GfxPixelOp[]
    try {
      ops = loadGfxOps(entry.project.directory)
    } catch {
      ops = []
    }
    const skipped: GfxPixelOp[] = []
    for (const op of ops) {
      if (table.setPixel(op).status !== 'ok') skipped.push(op)
    }
    const state: GfxState = { table, ops, skipped, lastSave: null, bytesChanged: 0 }
    this.gfx.set(key, state)
    // Re-derive here, not only in `saveGfx`: the removal above took the
    // previous repack off the working copy, and leaving it off would drop
    // an already-saved edit from anything that reads `bytes()` next.
    if (ops.length > 0) state.lastSave = this.deriveGfxLayer(entry, state)
    return state
  }

  private deriveGfxLayer(entry: WorkingRomEntry, state: GfxState): ArenaResult {
    entry.working.removeById(GFX_ARENA_LAYER_ID)
    const before = entry.working.bytes()
    const rom = RomFile.fromBytes(entry.romPath, Buffer.from(before))
    const result = planGfxSave(rom, state.table)
    if (result.status !== 'ok') return result

    const ops = arenaLayerOps(
      rom.buffer.subarray(rom.hasHeader ? COPIER_HEADER_SIZE : 0),
      result.plan.writes,
    )
    state.bytesChanged = ops.reduce((n, o) => n + o.newBytes.length / 2, 0)
    if (ops.length === 0) return result
    entry.working.append({
      id: GFX_ARENA_LAYER_ID,
      label: `repack graphics (${state.bytesChanged} bytes)`,
      scope: 'edit',
      ops,
    })
    return result
  }

  /** What undo/redo can do for this project right now. */
  editStack(manifestPath: string): EditStackResult {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    return { status: 'ok', ...stateOf(r.working) }
  }

  /**
   * Undo: take the top layer off and KEEP it, on disk, so redo survives the
   * project being closed.
   *
   * Nothing to undo is an `ok` no-op rather than a failure: a user pressing
   * Ctrl+Z on an untouched project has not done anything wrong, and the
   * returned state already says `canUndo: false`.
   */
  undo(manifestPath: string): EditStackResult {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const { working, project } = r

    const layer = working.undo()
    if (!layer) return { status: 'ok', ...stateOf(working) }

    try {
      popLayer(project.directory)
      pushRedoLayer(project.directory, layer)
    } catch (err) {
      // Put it back: an undo live in memory but not on disk would come back
      // from the dead on the next launch, which is the same failure mode
      // setColor's own rollback exists to prevent.
      working.redo()
      return { status: 'io-error', reason: (err as Error).message }
    }

    return { status: 'ok', ...stateOf(working) }
  }

  /**
   * Redo: put the most recently undone layer back.
   *
   * `stale` is WorkingRom.redo's refusal, reachable here for a persisted
   * redo whose address no longer holds what it expects - a hand-edited
   * `ops/redo/`, or one belonging to a different base cartridge. Nothing is
   * written in that case, and the layer stays redoable.
   */
  redo(manifestPath: string): EditStackResult {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const { working, project } = r

    let layer: Layer | undefined
    try {
      layer = working.redo()
    } catch (err) {
      return { status: 'stale', reason: (err as Error).message }
    }
    if (!layer) return { status: 'ok', ...stateOf(working) }

    try {
      popRedoLayer(project.directory)
      appendLayer(project.directory, layer)
    } catch (err) {
      working.undo() // roll back, same reasoning as undo's own failure path
      return { status: 'io-error', reason: (err as Error).message }
    }

    return { status: 'ok', ...stateOf(working) }
  }
}

function stateOf(working: WorkingRom): EditStackState {
  const top = working.stack[working.stack.length - 1]
  const next = working.redoStack[working.redoStack.length - 1]
  return {
    canUndo: !!top,
    canRedo: !!next,
    undoLabel: top?.label ?? null,
    redoLabel: next?.label ?? null,
  }
}
