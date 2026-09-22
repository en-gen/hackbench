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
import { loadLayers, appendLayer } from './OpsStore'

export interface WorkingRomEntry {
  working: WorkingRom
  romPath: string
  project: Project
}

export type WorkingRomResult =
  | ({ status: 'ok' } & WorkingRomEntry)
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
      appendLayer(project.directory, layer)
    } catch (err) {
      working.pop() // roll back: it never actually took effect
      return { status: 'io-error', reason: (err as Error).message }
    }

    return r
  }
}
