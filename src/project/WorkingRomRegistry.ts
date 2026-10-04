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
import {
  loadLayers,
  appendLayer,
  popLayer,
  loadRedoLayers,
  pushRedoLayer,
  popRedoLayer,
  clearRedo,
  opsStamp,
} from './OpsStore'

/**
 * How long after a stamp is taken a file change may still be hidden from it.
 * Covers a coarse ctime clock (a few ms on Linux) and FAT's 2 s mtime, the
 * same "racy" window git applies to its index. Local filesystems only: a
 * network share with a skewed server clock is not covered.
 */
const RACY_MS = 2000

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

/**
 * One 16-bit word write against a project's working copy: originally a
 * CGRAM colour (hence the field names), now shared by Map16 subtile edits
 * too (see Map16.ts's decodeSubTileWord/encodeSubTileWord) - the write
 * mechanism this backs (WorkingRom.append, one `edit` layer) never cared
 * whether the word meant a colour or a tile attribute.
 */
export interface SetWordRequest {
  /** 24-bit SNES address of the word being changed. */
  romAddr: number
  /** Word currently committed there, hex string e.g. "$391F". */
  oldHex: string
  /** Word to write, hex string e.g. "$03E0". */
  newHex: string
  /**
   * Which bits are significant, forwarded to the op (see PaletteOp.ts's
   * `Op.mask`). Omitted keeps the original BGR555 behaviour (bit 15
   * ignored); pass `FULL_WORD_MASK` for a word where bit 15 is real data.
   */
  mask?: number
}

function addrHex(romAddr: number): string {
  return `$${romAddr.toString(16).toUpperCase().padStart(6, '0')}`
}

export class WorkingRomRegistry {
  private readonly cache = new Map<string, WorkingRomEntry>()
  /**
   * opsStamp of the last ops/ state the cached copy was checked against.
   * Not on WorkingRomEntry, which is spread into every result. Dropped when
   * setWord fails, whose in-memory redo clear can leave memory disagreeing
   * with a disk the failure never touched, so no stamp would move. Undo and
   * redo need no such drop: every partial state they leave changes a file.
   */
  private readonly stamps = new Map<string, { key: string; takenAt: number }>()

  constructor(private readonly registry: RomRegistry = new RomRegistry()) {}

  /**
   * Remember where a ROM lives on this machine. Here rather than in a
   * server so no server holds a RomRegistry, the precursor to reading the
   * base bytes behind the working copy's back (workingCopyGate.test.ts).
   */
  register(romPath: string): RomIdentity {
    return this.registry.register(romPath)
  }

  /**
   * The working copy for a project, loading and replaying its persisted
   * layers on first access. The point of this class is that in-memory state
   * (which services share it with) survives between calls in the same
   * backend process, so it is cached per manifest path for as long as the
   * manifest's base ROM sha256 is unchanged AND the layers in `ops/` and
   * `ops/redo/` are the ones it holds. Both are re-checked every call
   * because a `git pull` can repoint the manifest or rewrite the layers
   * under a running backend. Rebuilding strands every view subscribed to
   * the old instance, so it happens only when the layers really differ, not
   * whenever a file's mtime moves (the copy's own writes move it).
   */
  get(manifestPath: string): WorkingRomResult {
    // openProject throws on a missing/corrupt/orphaned manifest, same as
    // the ROM-loading try below throws on a bad cartridge - both are "we
    // could not stand this project up", so both fold into the one
    // `unreadable` result rather than one of them escaping as an unhandled
    // rejection. The cache entry is kept: a checkout can leave the manifest
    // briefly missing, and a rebuilt instance would strand every view
    // subscribed to the old one. A real base ROM change below does strand
    // them; nothing yet tells those views to re-fetch.
    let project: Project
    try {
      project = openProject(manifestPath)
    } catch (err) {
      return { status: 'unreadable', reason: (err as Error).message }
    }

    const cached = this.cache.get(manifestPath)
    if (cached && cached.project.baseRom.sha256 === project.baseRom.sha256) {
      cached.project = project
      try {
        if (this.opsMatch(manifestPath, cached.working, project.directory)) {
          return { status: 'ok', ...cached }
        }
      } catch (err) {
        return { status: 'unreadable', reason: (err as Error).message }
      }
    }

    let romPath: string
    let working: WorkingRom
    let stamp: { key: string; takenAt: number }
    try {
      // Taken BEFORE the layers are read: a write landing in between then
      // shows as a changed stamp next call, rather than being stamped as seen.
      stamp = { key: opsStamp(project.directory).key, takenAt: Date.now() }
      const resolved = this.registry.resolveVerified(project.baseRom.sha256)
      if (!resolved) return { status: 'rom-not-located', baseRom: project.baseRom }
      romPath = resolved.path
      const rom = RomFile.fromBytes(romPath, Buffer.from(resolved.bytes))
      working = new WorkingRom(rom.buffer, rom.hasHeader)
      const persisted = persistedOps(project.directory)
      working.restore(persisted.applied)
      // AFTER the replay: `restore` clears the redo future, so seeding first
      // would wipe the very stack this is restoring.
      working.restoreRedo(persisted.redo)
    } catch (err) {
      return { status: 'unreadable', reason: (err as Error).message }
    }

    const entry: WorkingRomEntry = { working, romPath, project }
    this.cache.set(manifestPath, entry)
    this.stamps.set(manifestPath, stamp)
    return { status: 'ok', ...entry }
  }

  /** Whether `ops/` on disk still holds exactly the layers `working` does. */
  private opsMatch(manifestPath: string, working: WorkingRom, directory: string): boolean {
    const takenAt = Date.now()
    const now = opsStamp(directory)
    const seen = this.stamps.get(manifestPath)
    // Trusted only once every file is older than the window around the last
    // look: a change inside it may not have moved the key.
    if (seen && seen.key === now.key && now.newest < seen.takenAt - RACY_MS) return true
    const persisted = persistedOps(directory)
    const same =
      sameLayers(persisted.applied, working.stack) && sameLayers(persisted.redo, working.redoStack)
    if (same) this.stamps.set(manifestPath, { key: now.key, takenAt })
    return same
  }

  /**
   * Applies one word edit: records and PERSISTS one `edit` layer - the
   * write-back that makes the change survive a reload. Originally
   * palette-only (`setColor`); now also the write path for Map16 subtile
   * edits, which is why this takes a `mask` rather than assuming BGR555.
   *
   * Returns `stale` rather than throwing when the address no longer holds
   * `oldHex` (WorkingRom.append's own refusal), so the caller can tell the
   * user their edit target moved instead of silently corrupting something
   * else. Since nothing writes to the working copy between the caller
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
  setWord(
    manifestPath: string,
    req: SetWordRequest,
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
      ops: [{ address: addrHex(req.romAddr), old: req.oldHex, new: req.newHex, mask: req.mask }],
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
      this.stamps.delete(manifestPath)
      return { status: 'io-error', reason: (err as Error).message }
    }

    return r
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

    let layer: Layer | undefined
    try {
      layer = working.undo() // refuses when the stack below cannot be built on its own
    } catch (err) {
      return { status: 'stale', reason: (err as Error).message }
    }
    if (!layer) return { status: 'ok', ...stateOf(working) }

    try {
      // Destination first: a failure part-way leaves the layer in both areas,
      // which the next get() sees and reloads, never in neither. The pop names
      // the layer, so a file pulled on top since get() is refused rather than
      // deleted in place of this one.
      pushRedoLayer(project.directory, layer)
      try {
        popLayer(project.directory, layer.id)
      } catch (err) {
        compensate(() => popRedoLayer(project.directory, layer.id))
        throw err
      }
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
      appendLayer(project.directory, layer) // destination first, as in undo
      try {
        popRedoLayer(project.directory, layer.id)
      } catch (err) {
        compensate(() => popLayer(project.directory, layer.id))
        throw err
      }
    } catch (err) {
      working.undo() // roll back, same reasoning as undo's own failure path
      return { status: 'io-error', reason: (err as Error).message }
    }

    return { status: 'ok', ...stateOf(working) }
  }
}

/**
 * Both areas as the working copy should hold them. A layer in BOTH is what a
 * half-done move leaves (undo and redo write the destination first); it is
 * applied, and its redo copy is dropped rather than offered as a redo that
 * would either refuse as stale or apply the layer twice.
 */
function persistedOps(directory: string): { applied: Layer[]; redo: Layer[] } {
  const applied = loadLayers(directory)
  const ids = new Set(applied.map(l => l.id))
  return { applied, redo: loadRedoLayers(directory).filter(l => !ids.has(l.id)) }
}

/**
 * Runs a compensating write whose own failure must not replace the error
 * that made it necessary: the layer is then left in both areas, which
 * persistedOps reads as applied.
 */
function compensate(undoWrite: () => void): void {
  try {
    undoWrite()
  } catch {
    // Reported through the original error; see persistedOps.
  }
}

/** Layer-for-layer equal, ignoring `scope`, which OpsStore does not persist. */
function sameLayers(a: readonly Layer[], b: readonly Layer[]): boolean {
  const key = (l: Layer): string =>
    JSON.stringify(
      l.kind === 'gfx'
        ? [l.id, l.label, l.kind, l.file, l.tile, l.pixels.map(p => [p.x, p.y, p.value])]
        : l.kind === 'unreadable'
          ? [l.id, l.label, l.kind, l.reason]
          : [l.id, l.label, l.ops],
    )
  return a.length === b.length && a.every((l, i) => key(l) === key(b[i]))
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
