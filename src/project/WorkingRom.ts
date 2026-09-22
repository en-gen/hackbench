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
 * The actual byte mutation is src/rom/PaletteOp.ts's `applyOp` - a pure
 * reducer, no I/O, no project, no cartridge on disk. This class is the
 * orchestration around it: the layer stack, the cache, and change
 * notification. Views dispatch (append/pop); they never call `applyOp`
 * themselves or write bytes any other way.
 *
 * Layers apply ONE AT A TIME, in stack order, onto the running result -
 * never flattened to "last write per offset wins" the way
 * src/rom/PatchLayer.ts does. That distinction matters the moment two layers
 * touch overlapping ranges through different addressing (a future layer
 * type that moves data), where only sequential replay reproduces what
 * actually happened. Palette ops never exhibit that today (each is an
 * isolated 2-byte word write), but the resolution order is a
 * WorkingRom-wide contract, not a per-op decision.
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

export type { Op } from '../rom/PaletteOp'

export type LayerScope = 'edit' | 'preview'

export interface Layer {
  /** Stable identity; used to persist and to report which layer failed. */
  id: string
  label: string
  /** Defaults to 'edit'. 'preview' layers never persist and never export. */
  scope?: LayerScope
  ops: Op[]
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

export class WorkingRom {
  private readonly romSize: number
  private readonly layerStack: Layer[] = []
  /** Layers taken off by `undo`, kept so `redo` can put them back. */
  private readonly redoLayers: Layer[] = []
  private cached: Uint8Array | null = null
  private readonly listeners = new Set<(change: WorkingRomChange) => void>()

  /**
   * @param base        Cartridge file bytes exactly as loaded from disk
   *                     (copier header included if the file has one).
   * @param hasHeader   Whether `base` starts with a 512-byte copier header.
   */
  constructor(
    private readonly base: Uint8Array,
    private readonly hasHeader: boolean,
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
    if (!this.cached) this.cached = this.computeBytes(this.layerStack)
    return this.cached
  }

  /** Same as `bytes()` but skips 'preview' layers: what an export should ship. */
  exportableBytes(): Uint8Array {
    return this.computeBytes(this.layerStack.filter(l => (l.scope ?? 'edit') === 'edit'))
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
   * looked at when they made the edit.
   */
  append(layer: Layer): void {
    this.validate(layer)
    this.layerStack.push(layer)
    // A new edit ends the redo future. Standard editor behaviour, and also
    // the only thing keeping a held layer's `old` meaningful: redoing across
    // a divergent edit would write over bytes the user never looked at.
    this.redoLayers.length = 0
    this.invalidate({ kind: 'append', layer })
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
    if (layer) this.invalidate({ kind: 'pop', layer })
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
    this.invalidate({ kind: 'pop', layer })
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
    this.validate(layer)
    this.redoLayers.pop()
    this.layerStack.push(layer)
    this.invalidate({ kind: 'append', layer })
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

  /** Throws unless every op still matches the working copy it would apply to. */
  private validate(layer: Layer): void {
    const before = this.bytes()
    for (const op of layer.ops) {
      const offset = opFileOffset(op, this.romSize, this.hasHeader)
      if (offset === null) {
        throw new Error(`address ${op.address} is outside the cart`)
      }
      const current = readBgr555Word(before, offset) & BGR555_MASK
      const expected = parseBgr555Word(op.old) & BGR555_MASK
      if (current !== expected) {
        throw new Error(
          `stale op at ${op.address}: cart holds $${current.toString(16).toUpperCase()}, ` +
            `expected $${expected.toString(16).toUpperCase()}`,
        )
      }
      parseBgr555Word(op.new) // validated eagerly so a bad layer never reaches the stack
    }
  }

  /**
   * Notified after every append/pop, with the layer that changed. Returns an
   * unsubscribe function.
   *
   * A handler that calls `bytes()` sees the POST-change value: the cache is
   * cleared before listeners fire, and `bytes()` only ever recomputes (never
   * re-invalidates), so calling it from inside a handler cannot trigger a
   * second round of notifications.
   */
  onDidChange(fn: (change: WorkingRomChange) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private invalidate(change: WorkingRomChange): void {
    this.cached = null // cleared BEFORE fan-out: a handler's bytes() call recomputes, not re-enters
    for (const fn of this.listeners) fn(change)
  }

  private computeBytes(layers: readonly Layer[]): Uint8Array {
    const out = new Uint8Array(this.base)
    for (const layer of layers) {
      for (const op of layer.ops) applyOp(out, op, this.romSize, this.hasHeader)
    }
    return out
  }
}
