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
 * COST. A gfx fold decodes all 50 files, so nothing here replays the stack
 * for an ordinary edit. A new layer is applied onto a copy of the cached
 * bytes, and each application keeps the bytes it overwrote, so undo is a
 * revert. The one fold an undo can need is inside a run `restore` folded as
 * a whole: reverting that run and refolding all but its top layer.
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
import { GfxBase, GfxCharEdit, Overwritten, foldGfxRun, readGfxBase } from '../rom/GfxLayer'
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

/**
 * What applying the stack layers `from..k` replaced, recorded against layer
 * `k`. `from` is `k` itself except for a gfx run `restore` folded as a whole,
 * whose one record sits on its top layer.
 */
interface Applied {
  from: number
  replaced: Overwritten[]
}

export class WorkingRom {
  private readonly romSize: number
  private readonly layerStack: Layer[] = []
  /** Layers taken off by `undo`, kept so `redo` can put them back. */
  private readonly redoLayers: Layer[] = []
  /** Never mutated once set: every change builds a new array. */
  private cached: Uint8Array | null = null
  private readonly listeners = new Set<(change: WorkingRomChange) => void>()
  private gfxBase: GfxBase | null = null
  /** Keyed by stack index; see `Applied`. */
  private readonly applied = new Map<number, Applied>()

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

  /**
   * File offsets of the words a word layer writes (a copier header counts),
   * in op order; an op outside the cartridge is skipped. A gfx layer has
   * none: it is addressed by file and character, not by ROM offset.
   */
  wordOffsets(layer: Layer): number[] {
    if (layer.kind !== undefined) return []
    return layer.ops
      .map(op => opFileOffset(op, this.romSize, this.hasHeader))
      .filter((o): o is number => o !== null)
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
    if (!this.cached) {
      // Every change sets the cache, so this is the untouched copy.
      const out = new Uint8Array(this.base)
      this.replay(out, this.layerStack, 0, this.layerStack.length, false)
      this.cached = out
    }
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
   * by one would fold each layer separately. Throws, leaving the stack
   * empty, if any layer would refuse. Fires no change: nothing can be
   * watching a copy that is still being opened.
   */
  restore(layers: readonly Layer[]): void {
    if (this.layerStack.length > 0) throw new Error('restore needs an empty stack')
    const out = new Uint8Array(this.base)
    this.replay(out, layers, 0, layers.length, true)
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
    const layer = this.layerStack[this.layerStack.length - 1]
    if (!layer) return undefined
    const next = this.withoutTop()
    this.layerStack.pop()
    this.invalidate({ kind: 'pop', layer }, next)
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
   *
   * Throws, with the layer left in place, when the stack below cannot be
   * built on its own: `restore` accepts a run as a whole, so a run whose
   * lower layers overflow the arena without the top one is possible.
   */
  undo(): Layer | undefined {
    const layer = this.layerStack[this.layerStack.length - 1]
    if (!layer) return undefined
    const next = this.withoutTop()
    this.layerStack.pop()
    this.redoLayers.push(layer)
    this.invalidate({ kind: 'pop', layer }, next)
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

  private invalidate(change: WorkingRomChange, next: Uint8Array): void {
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

  /**
   * The bytes with `layer` on top of the current stack, recording what it
   * replaced against the index it will take. Throws if it refuses.
   */
  private applyOnTop(layer: Layer): Uint8Array {
    const next = new Uint8Array(this.bytes())
    const replaced =
      layer.kind === 'gfx' ? this.fold(next, [layer]) : this.applyWords(next, layer, true)
    this.applied.set(this.layerStack.length, { from: this.layerStack.length, replaced })
    return next
  }

  /**
   * The bytes without the top layer: its record reverted, and for the top of
   * a run `restore` folded whole, the rest of that run refolded. Throws, with
   * nothing changed, when that refold refuses.
   */
  private withoutTop(): Uint8Array {
    const k = this.layerStack.length - 1
    const top = this.applied.get(k)!
    const next = new Uint8Array(this.bytes())
    revert(next, top.replaced)
    if (top.from < k) {
      const rest = this.layerStack.slice(top.from, k) as GfxLayer[]
      this.applied.set(k - 1, { from: top.from, replaced: this.fold(next, rest) })
    }
    this.applied.delete(k)
    return next
  }

  /** Bytes after the first `n` stack layers: records reverted from the top down. */
  private prefix(n: number): Uint8Array {
    const out = new Uint8Array(this.bytes())
    let k = this.layerStack.length
    while (k > n) {
      const top = this.applied.get(k - 1)!
      revert(out, top.replaced)
      k = top.from
    }
    this.replay(out, this.layerStack, k, n, false) // what remains of a restored run
    return out
  }

  /**
   * Replay `layers[from, to)` onto `out`. A run of consecutive gfx layers
   * folds into ONE pass. With `record`, the indices are stack indices, word
   * layers are validated as `append` would, and what each layer or run
   * replaced is recorded.
   */
  private replay(
    out: Uint8Array,
    layers: readonly Layer[],
    from: number,
    to: number,
    record: boolean,
  ): void {
    let run: GfxCharEdit[] = []
    let runFrom = from
    const flush = (end: number): void => {
      if (run.length === 0) return
      const replaced = this.fold(out, run)
      if (record) this.applied.set(end - 1, { from: runFrom, replaced })
      run = []
    }
    for (let i = from; i < to; i++) {
      const layer = layers[i]!
      if (layer.kind === 'gfx') {
        if (run.length === 0) runFrom = i
        run.push(layer)
        continue
      }
      flush(i)
      const replaced = this.applyWords(out, layer, record)
      if (record) this.applied.set(i, { from: i, replaced })
    }
    flush(to)
  }

  private gfx(): GfxBase {
    return (this.gfxBase ??= readGfxBase(this.base))
  }

  private fold(out: Uint8Array, run: readonly GfxCharEdit[]): Overwritten[] {
    return foldGfxRun(out, this.hasHeader, this.gfx(), run, this.options.gfxEncoder ?? encode)
  }

  /**
   * Apply a word layer and return what it overwrote. With `check`, it first
   * throws unless every op still matches `out` and lands outside the bytes a
   * gfx layer rewrites.
   */
  private applyWords(out: Uint8Array, layer: Layer, check: boolean): Overwritten[] {
    if (layer.kind === 'unreadable') throw new Error(layer.reason)
    if (layer.kind === 'gfx') throw new Error('a gfx layer is not a word layer')
    const offsets = layer.ops.map(op => {
      const offset = opFileOffset(op, this.romSize, this.hasHeader)
      if (offset === null) throw new Error(`address ${op.address} is outside the ROM`)
      if (!check) return offset
      if (this.gfx().guarded.some(([s, e]) => offset < e && offset + 2 > s)) {
        throw new Error(
          `${op.address} is in the GFX arena or its pointer tables, which the next gfx layer rewrites`,
        )
      }
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
    return layer.ops.map((op, i) => {
      const at = offsets[i]!
      const old = out.slice(at, at + 2)
      applyOp(out, op, this.romSize, this.hasHeader)
      return { at, old }
    })
  }
}

/** Undo `replaced`, last write first: two writes to one address must unwind in order. */
function revert(out: Uint8Array, replaced: readonly Overwritten[]): void {
  for (let i = replaced.length - 1; i >= 0; i--) out.set(replaced[i]!.old, replaced[i]!.at)
}
