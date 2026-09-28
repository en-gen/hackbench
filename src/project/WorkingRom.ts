/**
 * The working copy: the base cartridge with every edit layer applied.
 *
 * This is the STORE in this app's flux shape: an op is the action, appending
 * a layer is the dispatch, this class is the store, and the palette/GFX
 * widgets are views that re-render on its change event. Every view that
 * shows the cart to the user must read `bytes()`, not the base bytes, or an
 * edit in one view (a palette colour) never shows up in another (the GFX
 * sheet using that palette). See docs/glossary.md, "Working copy".
 *
 * The actual byte mutation is src/rom/PaletteOp.ts's `applyOp`, or for a gfx
 * layer src/rom/GfxLayer.ts's `foldGfxRun` - pure reducers, no I/O, no
 * project, no ROM on disk. This class is the orchestration around them: the
 * layer stack, the cache, and change notification. Views dispatch
 * (append/pop); they never call a reducer themselves or write bytes any
 * other way.
 *
 * Layers apply ONE AT A TIME, in stack order, onto the running result -
 * never flattened to "last write per offset wins" the way
 * src/rom/PatchLayer.ts does. The one grouping is a run of consecutive gfx
 * layers, which folds into one re-encode per file; the fold is built so the
 * result equals applying the run's characters one at a time.
 *
 * COST. A gfx fold decodes all 50 files, so nothing here replays the whole
 * stack for an ordinary edit: a new layer is applied onto a copy of the
 * cached bytes, undoing a word write restores the bytes it overwrote, and
 * undoing a gfx layer replays from a snapshot taken where its run began.
 * That costs one ROM-sized snapshot per gfx run, kept while the run is on
 * the stack.
 *
 * Pure orchestration: no fs, no Theia, no VS Code. Persisting layers to disk
 * is a separate concern (src/project/OpsStore.ts).
 */
import {
  applyOp,
  opFileOffset,
  parseBgr555Word,
  readBgr555Word,
  BGR555_MASK,
  Op,
} from '../rom/PaletteOp'
import { COPIER_HEADER_SIZE } from '../rom/addressing'
import { GfxBase, GfxCharEdit, foldGfxRun, readGfxBase } from '../rom/GfxLayer'
import { GfxEncoder } from '../rom/GfxTable'
import { encode } from '../rom/LcLz2'

export type { Op } from '../rom/PaletteOp'

export type LayerScope = 'edit' | 'preview'

interface LayerBase {
  /** Stable identity; used to persist and to report which layer failed. */
  id: string
  label: string
  /** Defaults to 'edit'. 'preview' layers never persist and never export. */
  scope?: LayerScope
}

/** Word writes: palette and Map16. Applied immediately, one per gesture. */
export interface OpsLayer extends LayerBase {
  kind?: undefined
  ops: Op[]
}

/**
 * One 8x8 character's new pixels in one GFX file: the STAGED kind of
 * docs/layer-previews.md. Consecutive gfx layers replay as one re-encode per
 * file (src/rom/GfxLayer.ts), so the layer follows the user's edit and not
 * the compressor's.
 */
export interface GfxLayer extends LayerBase, GfxCharEdit {
  kind: 'gfx'
}

/**
 * A persisted layer this build could not read. Only ever held for redo, where
 * it refuses with `reason`: the same policy as a stale word layer there, which
 * opens fine and refuses when it is asked for.
 */
export interface UnreadableLayer extends LayerBase {
  kind: 'unreadable'
  reason: string
}

export type Layer = OpsLayer | GfxLayer | UnreadableLayer

export interface WorkingRomOptions {
  /** Swappable only so a test can count re-encodes. */
  gfxEncoder?: GfxEncoder
}

/**
 * What changed. Carries the layer itself (not just "something changed") so
 * a subscriber can inspect its ops' addresses and decide for itself whether
 * it cares - gfx-server.ts uses this to tell a palette edit (recolour) from
 * something that would need a full re-decode, once that fast path exists.
 */
export interface WorkingRomChange {
  kind: 'append' | 'pop'
  layer: Layer
}

/** A byte offset and the two bytes a word write found there. */
type Overwritten = [offset: number, lo: number, hi: number]

export class WorkingRom {
  private readonly romSize: number
  private readonly layerStack: Layer[] = []
  /** Layers taken off by `undo`, kept so `redo` can put them back. */
  private readonly redoLayers: Layer[] = []
  /** Never mutated once set, so it may also be held as a snapshot. */
  private cached: Uint8Array | null = null
  private readonly listeners = new Set<(change: WorkingRomChange) => void>()
  private gfxBase: GfxBase | null = null
  /** Bytes after the first `k` layers, for each `k` where a gfx run begins. */
  private readonly snapshots = new Map<number, Uint8Array>()
  /** For the word layer at stack index `k`, what its writes overwrote. */
  private readonly overwritten = new Map<number, Overwritten[]>()

  /**
   * @param base        Cartridge file bytes exactly as loaded from disk
   *                     (copier header included if the file has one).
   * @param hasHeader   Whether `base` starts with a 512-byte copier header.
   */
  constructor(
    private readonly base: Uint8Array,
    private readonly hasHeader: boolean,
    private readonly options: WorkingRomOptions = {},
  ) {
    this.romSize = base.length - (hasHeader ? COPIER_HEADER_SIZE : 0)
  }

  /** The unedited cartridge, never mutated by anything in this class. */
  baseBytes(): Uint8Array {
    return this.base
  }

  /** Whether the base file carries a 512-byte copier header. */
  get hasCopierHeader(): boolean {
    return this.hasHeader
  }

  /**
   * The base cartridge with every layer applied, in stack order.
   *
   * Returns the CACHED array BY REFERENCE, not a copy: recomputing a
   * multi-megabyte cartridge on every call (this can be called once per RPC
   * response) is the exact cost this cache exists to avoid. That means the
   * returned array is live and shared - mutating it directly corrupts this
   * store's own state, silently, for every other reader. Every current
   * caller already copies before using it (e.g. `Buffer.from(working.
   * bytes())` in the *-server.ts files); treat that as the required
   * contract, not an accident of how they happen to be written.
   */
  bytes(): Uint8Array {
    if (!this.cached) this.cached = this.prefix(this.layerStack.length)
    return this.cached
  }

  /** Same as `bytes()` but skips 'preview' layers: what an export should ship. */
  exportableBytes(): Uint8Array {
    const edits = this.layerStack.filter(l => (l.scope ?? 'edit') === 'edit')
    if (edits.length === this.layerStack.length) return new Uint8Array(this.bytes())
    const out = new Uint8Array(this.base)
    this.replay(out, edits, 0, edits.length, false)
    return out
  }

  /** The stack as it stands, oldest first. Read-only: use append/pop to change it. */
  get stack(): readonly Layer[] {
    return this.layerStack
  }

  /**
   * Push a new layer on top.
   *
   * Refuses (throws, does not partially apply) if any op's `old` no longer
   * matches what is actually at that address in the CURRENT working copy:
   * a stale op would silently overwrite something other than what the user
   * looked at when they made the edit. A gfx layer the ROM cannot take
   * (src/rom/GfxLayer.ts GfxRefusal) refuses the same way.
   */
  append(layer: Layer): void {
    const next = this.applyOnTop(layer)
    this.layerStack.push(layer)
    // A new edit ends the redo future. Standard editor behaviour, and also
    // the only thing keeping a held layer's `old` meaningful: redoing across
    // a divergent edit would write over bytes the user never looked at.
    this.redoLayers.length = 0
    this.invalidate({ kind: 'append', layer }, next)
  }

  /**
   * Replace an EMPTY stack with `layers` in one validated pass: what opening
   * a project does. Every gfx run folds once, where appending the layers one
   * by one would refold the stack below each. Throws, leaving the stack
   * empty, if any layer would refuse. Fires no change: nothing can be
   * watching a copy that is still being opened.
   */
  restore(layers: readonly Layer[]): void {
    if (this.layerStack.length > 0) throw new Error('restore needs an empty stack')
    const out = new Uint8Array(this.base)
    try {
      this.replay(out, layers, 0, layers.length, true)
    } catch (err) {
      this.forgetFrom(0)
      throw err
    }
    this.layerStack.push(...layers)
    this.redoLayers.length = 0
    this.cached = out
  }

  /**
   * Removes and returns the top layer, DISCARDING it.
   *
   * This is the ROLLBACK primitive, not undo: WorkingRomRegistry calls it
   * when a layer validated in memory but failed to reach disk. That edit
   * never happened, so it must not join the redo stack - offering it back
   * would put a layer the user never made one keystroke from applying.
   * User-facing undo is `undo()`.
   */
  pop(): Layer | undefined {
    const layer = this.layerStack.pop()
    if (layer) this.invalidate({ kind: 'pop', layer }, this.afterPop())
    return layer
  }

  /** The undone layers, oldest-undone first; the LAST is what `redo` applies. */
  get redoStack(): readonly Layer[] {
    return this.redoLayers
  }

  /**
   * Undo: move the top layer onto the redo stack.
   *
   * Reported as a `pop` change, because that is what happened to the working
   * copy - a subscriber re-reading `bytes()` cannot tell, and should not
   * have to care, whether the layer was kept.
   */
  undo(): Layer | undefined {
    const layer = this.layerStack.pop()
    if (!layer) return undefined
    this.redoLayers.push(layer)
    this.invalidate({ kind: 'pop', layer }, this.afterPop())
    return layer
  }

  /**
   * Redo: re-apply the most recently undone layer.
   *
   * Validated exactly as `append` validates, and BEFORE anything moves, so a
   * layer whose `old` no longer matches (a hand-edited `ops/redo/` file, or
   * one belonging to a different base cartridge) refuses with the stack
   * untouched rather than writing over bytes nobody looked at.
   */
  redo(): Layer | undefined {
    const layer = this.redoLayers[this.redoLayers.length - 1]
    if (!layer) return undefined
    const next = this.applyOnTop(layer)
    this.redoLayers.pop()
    this.layerStack.push(layer)
    this.invalidate({ kind: 'append', layer }, next)
    return layer
  }

  /**
   * Seed the redo stack from persisted `ops/redo/`, oldest-undone first.
   *
   * Deliberately NOT validated here: a stale entry would otherwise make the
   * whole project fail to open, when the honest outcome is a project that
   * opens fine and one redo that refuses when it is actually asked for.
   */
  restoreRedo(layers: readonly Layer[]): void {
    this.redoLayers.length = 0
    this.redoLayers.push(...layers)
  }

  /**
   * Notified after every append/pop, with the layer that changed. Returns an
   * unsubscribe function.
   *
   * A handler that calls `bytes()` sees the POST-change value: the cache is
   * set before listeners fire, and `bytes()` only ever recomputes (never
   * re-invalidates), so calling it from inside a handler cannot trigger a
   * second round of notifications.
   */
  onDidChange(fn: (change: WorkingRomChange) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** `next` is the post-change bytes when they are already known. */
  private invalidate(change: WorkingRomChange, next: Uint8Array | null): void {
    this.cached = next // set BEFORE fan-out: a handler's bytes() call recomputes, not re-enters
    for (const fn of this.listeners) fn(change)
  }

  /**
   * How many ROM bytes the layer at `index` changed, against the snapshot
   * directly below it. For a gfx layer that is the whole arena shift, which
   * is the user's real budget, not the character's 64 pixels.
   */
  bytesChangedBy(index: number): number {
    const before = this.prefix(index)
    const after = this.prefix(index + 1)
    let n = 0
    for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) n++
    return n
  }

  /** The preview's scope line (docs/layer-previews.md): required for gfx,
   *  none for a word write. */
  scopeLine(index: number): string | null {
    if (this.layerStack[index]?.kind !== 'gfx') return null
    const n = this.bytesChangedBy(index)
    return `Re-encodes the GFX arena: ${n} ${n === 1 ? 'byte' : 'bytes'} of the ROM changed, not just this character.`
  }

  /** The bytes with `layer` on top of the current stack; throws if it refuses. */
  private applyOnTop(layer: Layer): Uint8Array {
    const k = this.layerStack.length
    const before = this.bytes()
    const next = new Uint8Array(before)
    if (layer.kind === 'gfx') {
      this.fold(next, [layer])
      if (this.layerStack[k - 1]?.kind !== 'gfx') this.snapshots.set(k, before)
    } else {
      this.applyWords(next, layer, k, true)
    }
    return next
  }

  /** After a pop to the current length: the bytes, when cheaply known. */
  private afterPop(): Uint8Array | null {
    const k = this.layerStack.length
    const undone = this.overwritten.get(k)
    let next: Uint8Array | null = this.snapshots.get(k) ?? null
    if (!next && undone && this.cached) {
      next = new Uint8Array(this.cached)
      for (const [o, lo, hi] of [...undone].reverse()) {
        next[o] = lo
        next[o + 1] = hi
      }
    }
    this.forgetFrom(k)
    return next
  }

  /** Drop what was recorded for stack indices above `k` layers. */
  private forgetFrom(k: number): void {
    for (const i of this.snapshots.keys()) if (i > k) this.snapshots.delete(i)
    for (const i of this.overwritten.keys()) if (i >= k) this.overwritten.delete(i)
  }

  /** Bytes after the first `n` stack layers, replayed from the nearest snapshot. */
  private prefix(n: number): Uint8Array {
    let from = 0
    for (const k of this.snapshots.keys()) if (k <= n && k > from) from = k
    const out = new Uint8Array(this.snapshots.get(from) ?? this.base)
    this.replay(out, this.layerStack, from, n, true)
    return out
  }

  /**
   * Replay `layers[from, to)` onto `out`. A run of consecutive gfx layers
   * folds into ONE pass. With `record`, the indices are stack indices: a
   * snapshot is kept where each run begins, and what each word layer
   * overwrote, and word layers are validated as `append` would.
   */
  private replay(
    out: Uint8Array,
    layers: readonly Layer[],
    from: number,
    to: number,
    record: boolean,
  ): void {
    let run: GfxCharEdit[] = []
    const flush = (): void => {
      if (run.length > 0) this.fold(out, run)
      run = []
    }
    for (let i = from; i < to; i++) {
      const layer = layers[i]!
      if (layer.kind === 'gfx') {
        if (record && run.length === 0 && !this.snapshots.has(i)) {
          this.snapshots.set(i, new Uint8Array(out))
        }
        run.push(layer)
        continue
      }
      flush()
      this.applyWords(out, layer, i, record)
    }
    flush()
  }

  private fold(out: Uint8Array, run: readonly GfxCharEdit[]): void {
    this.gfxBase ??= readGfxBase(this.base)
    foldGfxRun(out, this.hasHeader, this.gfxBase, run, this.options.gfxEncoder ?? encode)
  }

  /**
   * Apply a word layer at stack index `k`. With `check`, it first throws
   * unless every op still matches `out`, and records what it overwrites so
   * an undo can put it back without a replay.
   */
  private applyWords(out: Uint8Array, layer: Layer, k: number, check: boolean): void {
    if (layer.kind === 'unreadable') throw new Error(layer.reason)
    if (layer.kind === 'gfx') throw new Error('a gfx layer is not a word layer')
    const offsets = layer.ops.map(op => {
      const offset = opFileOffset(op, this.romSize, this.hasHeader)
      if (offset === null) throw new Error(`address ${op.address} is outside the ROM`)
      if (!check) return offset
      const mask = op.mask ?? BGR555_MASK
      const current = readBgr555Word(out, offset) & mask
      const expected = parseBgr555Word(op.old) & mask
      if (current !== expected) {
        throw new Error(
          `stale op at ${op.address}: ROM holds $${current.toString(16).toUpperCase()}, ` +
            `expected $${expected.toString(16).toUpperCase()}`,
        )
      }
      parseBgr555Word(op.new) // validated eagerly so a bad layer never reaches the stack
      return offset
    })
    const overwritten: Overwritten[] = []
    layer.ops.forEach((op, i) => {
      overwritten.push([offsets[i]!, out[offsets[i]!]!, out[offsets[i]! + 1]!])
      applyOp(out, op, this.romSize, this.hasHeader)
    })
    if (check) this.overwritten.set(k, overwritten)
  }
}
