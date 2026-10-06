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
import * as path from 'path'
import { openProject, Project, RomIdentity, romIdentity } from './Project'
import { readRomBounded } from './BoundedRead'
import { RomRegistry } from './RomRegistry'
import { RomFile } from '../rom/RomFile'
import { GfxCharEdit, GfxRefusal } from '../rom/GfxLayer'
import { Layer, WorkingRom } from './WorkingRom'
import {
  loadLayers,
  appendLayer,
  isGfxCharEdit,
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

/** `mismatch` names both hashes in full so a caller can shorten them for display. */
export type RomCheck = { status: 'ok' } | { status: 'mismatch'; picked: string; expected: string }

interface CopyListener {
  built: (manifestPath: string, working: WorkingRom) => void
  release?: (working: WorkingRom) => void
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

  private readonly romListeners = new Set<(manifestPath: string) => void>()
  private readonly copyListeners = new Set<CopyListener>()
  /**
   * Projects whose `get` answered `rom-not-located`, with the ROM they wait
   * for: the only ones a later registration can newly serve. They have no
   * cache entry, so nothing else remembers them.
   */
  private readonly waiting = new Map<string, string>()

  constructor(private readonly registry: RomRegistry = new RomRegistry()) {}

  /**
   * Fires, once per project, when the ROM behind a project's working copy
   * changes: `relocate`, a `register` that serves a project that was waiting
   * for its ROM, a `get` that finds a waiting project's ROM again, or a rebuild
   * that replaces a cached entry. NOT on the first build (a view asking for the
   * project is already loading it) and NOT on edits (the edit event covers
   * those).
   */
  onRomChanged(fn: (manifestPath: string) => void): () => void {
    this.romListeners.add(fn)
    return () => this.romListeners.delete(fn)
  }

  /**
   * Called with every working copy this registry holds, now and as each one
   * is built or rebuilt, so a subscriber (a connection's edit notifier) never
   * has to wait for a request to learn a copy exists. `release` is called with
   * a copy the registry stops holding (replaced, evicted, dropped), so the
   * subscriber can let go of it too.
   */
  onWorkingCopy(
    built: (manifestPath: string, working: WorkingRom) => void,
    release?: (working: WorkingRom) => void,
  ): () => void {
    const listener = { built, release }
    this.copyListeners.add(listener)
    for (const [manifestPath, entry] of this.cache) built(manifestPath, entry.working)
    return () => this.copyListeners.delete(listener)
  }

  private releaseCopy(working: WorkingRom): void {
    for (const l of this.copyListeners) l.release?.(working)
  }

  private fireRomChanged(manifestPath: string): void {
    for (const fn of this.romListeners) fn(manifestPath)
  }

  /**
   * Remember where a ROM lives on this machine. Here rather than in a
   * server so no server holds a RomRegistry, the precursor to reading the
   * base bytes behind the working copy's back (workingCopyGate.test.ts).
   */
  register(romPath: string): RomIdentity {
    const identity = this.registry.register(romPath)
    for (const manifest of this.takeWaiting(identity.sha256)) this.fireRomChanged(manifest)
    return identity
  }

  /** Projects that were waiting for the ROM `sha256`; they wait no longer. */
  private takeWaiting(sha256: string): string[] {
    const served = [...this.waiting].filter(([, sha]) => sha === sha256).map(([m]) => m)
    for (const manifest of served) this.waiting.delete(manifest)
    return served
  }

  /**
   * Where this machine keeps the project's base ROM, re-verified, or null.
   * Only for the Local workstation display; views read `get()`, never a path.
   */
  workstationRomPath(manifestPath: string): string | null {
    return this.registry.resolve(openProject(manifestPath).baseRom.sha256)
  }

  /** Whether the ROM at `romPath` is this project's base ROM. Registers nothing. */
  checkRom(manifestPath: string, romPath: string): RomCheck {
    const expected = openProject(manifestPath).baseRom.sha256
    const picked = romIdentity(readRomBounded(romPath)).sha256
    return picked === expected ? { status: 'ok' } : { status: 'mismatch', picked, expected }
  }

  /**
   * Point this machine at another copy of the project's own ROM (#527). A
   * different ROM is refused: retargeting a project is out of scope.
   *
   * The file is read ONCE: hashed, then registered and header-checked from
   * those same bytes, so a file swapped mid-call can neither land in the
   * registry under its own hash nor give a header state for other bytes.
   * Every cached project on this ROM learns the new path; one whose
   * copier-header state changed is dropped, so the next `get` rebuilds it
   * (Export Patch depends on that state). Announces the swap through
   * `onRomChanged`, once per project, so callers push nothing themselves.
   */
  relocate(manifestPath: string, romPath: string): RomCheck {
    const expected = openProject(manifestPath).baseRom.sha256
    const absolute = path.resolve(romPath)
    const bytes = readRomBounded(absolute)
    const picked = romIdentity(bytes).sha256
    if (picked !== expected) return { status: 'mismatch', picked, expected }
    this.registry.registerBytes(absolute, bytes)
    const headered = RomFile.fromBytes(absolute, Buffer.from(bytes)).hasHeader
    // The caller's project may have no cache entry yet (it was waiting on a
    // missing ROM), so it is announced whether or not the loop meets it.
    const moved = new Set([manifestPath, ...this.takeWaiting(expected)])
    for (const [manifest, entry] of [...this.cache]) {
      if (entry.project.baseRom.sha256 !== expected) continue
      if (entry.working.hasCopierHeader !== headered) {
        this.cache.delete(manifest)
        this.stamps.delete(manifest)
        this.releaseCopy(entry.working)
      } else {
        entry.romPath = absolute
      }
      moved.add(manifest)
    }
    for (const manifest of moved) this.fireRomChanged(manifest)
    return { status: 'ok' }
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
    // them, which is why it announces `onRomChanged`.
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
    let wasWaiting: boolean
    try {
      // Taken BEFORE the layers are read: a write landing in between then
      // shows as a changed stamp next call, rather than being stamped as seen.
      stamp = { key: opsStamp(project.directory).key, takenAt: Date.now() }
      const resolved = this.registry.resolveVerified(project.baseRom.sha256)
      if (!resolved) {
        this.waiting.set(manifestPath, project.baseRom.sha256)
        // A stale entry must not outlive the answer: when the ROM is found, the
        // later build would look like a second swap after register announced it.
        if (cached) {
          this.cache.delete(manifestPath)
          this.stamps.delete(manifestPath)
          this.releaseCopy(cached.working)
        }
        return { status: 'rom-not-located', baseRom: project.baseRom }
      }
      wasWaiting = this.waiting.delete(manifestPath)
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
    // A rebuild strands every view holding the old instance (see above).
    if (cached) this.releaseCopy(cached.working)
    for (const l of this.copyListeners) l.built(manifestPath, working)
    // A waiting project served here (the ROM reappeared without register or
    // relocate) is announced too: a view stuck on "Locate" has no other cue.
    if (cached || wasWaiting) this.fireRomChanged(manifestPath)
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
    const { working } = r

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

    const failed = this.persist(manifestPath, r, layer)
    if (failed) return failed
    return r
  }

  /**
   * The disk half of an edit whose layer `append` has already put on the
   * stack. `append` ended the redo future in memory; this does the same on
   * disk BEFORE the write, so a failure leaves the two agreeing (a disk redo
   * the working copy no longer knows about would come back on the next
   * launch). On failure the layer is popped straight back off: an edit live
   * in memory but never on disk would show as committed, then be gone on
   * reopen.
   */
  private persist(
    manifestPath: string,
    r: Extract<WorkingRomResult, { status: 'ok' }>,
    layer: Layer,
  ): { status: 'io-error'; reason: string } | null {
    try {
      clearRedo(r.project.directory)
      appendLayer(r.project.directory, layer)
      return null
    } catch (err) {
      r.working.pop()
      this.stamps.delete(manifestPath)
      return { status: 'io-error', reason: (err as Error).message }
    }
  }

  /**
   * Append ONE gfx layer holding `chars`: what the GFX view's Save sends.
   * Same order as setWord (append validates, then clearRedo, then the disk
   * write, popped back if the write fails). A GfxRefusal (the arena would
   * overflow, a character the file lacks) comes back as `refused` with the
   * stack untouched.
   */
  setGfx(
    manifestPath: string,
    chars: readonly GfxCharEdit[],
  ):
    | WorkingRomResult
    | { status: 'refused'; reason: string; overage?: number }
    | { status: 'io-error'; reason: string } {
    const r = this.get(manifestPath)
    if (r.status !== 'ok') return r
    const { working } = r
    if (chars.length === 0) return { status: 'refused', reason: 'There is nothing to save.' }
    const bad = chars.findIndex(c => !isGfxCharEdit(c))
    if (bad >= 0) {
      return {
        status: 'refused',
        reason: `Character ${bad} is malformed: it needs a whole-number file and tile, and one or more pixels with whole-number x, y and value.`,
      }
    }
    const n = chars.length
    const layer: Layer = {
      id: `gfx-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`,
      label: `paint ${n} ${n === 1 ? 'character' : 'characters'}`,
      kind: 'gfx',
      // Copied: the stack must not alias objects the caller may reuse.
      chars: chars.map(c => ({
        file: c.file,
        tile: c.tile,
        pixels: c.pixels.map(p => ({ x: p.x, y: p.y, value: p.value })),
      })),
    }
    try {
      working.append(layer)
    } catch (err) {
      const overage = err instanceof GfxRefusal ? err.overage : undefined
      return { status: 'refused', reason: (err as Error).message, overage }
    }
    const failed = this.persist(manifestPath, r, layer)
    if (failed) return failed
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
        ? [
            l.id,
            l.label,
            l.kind,
            l.chars.map(c => [c.file, c.tile, c.pixels.map(p => [p.x, p.y, p.value])]),
          ]
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
