/**
 * Ordered ROM patch layers.
 *
 * An edit never mutates the ROM. It produces a LAYER: a named set of byte
 * writes. Layers stack in order onto the base ROM the way image layers stack
 * onto a base image, later layers winning where they overlap. Nothing here
 * knows about SMW; it is byte arithmetic over an immutable base.
 *
 * Why layers rather than in-place edits:
 *
 * - The base ROM stays byte-identical, so the emulator's cached machine state
 *   stays valid (EmulatorPreviewProvider keys that cache on ROM content).
 * - Undo is dropping a layer, not replaying an inverse operation.
 * - `upTo` gives history: rebuild the ROM as it stood at any past edit.
 * - `squash` gives a commit: collapse a run of layers into one.
 *
 * Everything is pure. `applyPatches` returns a new array and never writes to
 * its input, because the base ROM is shared with the parser, the map editor
 * and the emulator, and an in-place write would corrupt all three at once.
 */

/** One byte write. `offset` is a FILE offset, not a SNES address. */
export interface Patch {
  offset: number
  value: number
}

/**
 * `edit` layers are the user's own changes: they belong to the level, they are
 * what an exported patch contains, and they persist.
 *
 * `preview` layers exist only while running: freeze the demo, stop the timer,
 * whatever makes a level convenient to test. They must never reach an export,
 * because a hack that ships with its timer disabled is a broken hack.
 */
export type LayerScope = 'edit' | 'preview'

export interface PatchLayer {
  /** Stable identity, used by `upTo` and by undo. */
  id: string
  /** Human-facing, e.g. "move object 3 right". */
  label: string
  /** Defaults to 'edit' where omitted, because that is the safer mistake:
   *  an export containing one layer too many is visible, one missing is not. */
  scope?: LayerScope
  patches: Patch[]
}

/** The layers that belong in an exported patch. */
export function exportable(layers: readonly PatchLayer[]): PatchLayer[] {
  return layers.filter(l => (l.scope ?? 'edit') === 'edit')
}

/**
 * Collapse layers to one write per offset, later layers winning.
 *
 * Returned in ascending offset order so two equivalent stacks produce
 * identical output, which is what makes `squash` testable against `flatten`.
 */
export function flatten(layers: readonly PatchLayer[]): Patch[] {
  const byOffset = new Map<number, number>()
  for (const layer of layers) {
    for (const p of layer.patches) byOffset.set(p.offset, p.value)
  }
  return [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, value]) => ({ offset, value }))
}

/**
 * Apply patches to a copy of `rom`.
 *
 * Throws on an out-of-range offset or a value outside a byte rather than
 * silently truncating: a patch that lands nowhere is a defect in whatever
 * computed it, and a ROM that quietly ignores it is the worst outcome here,
 * because the preview would render the unedited level and look correct.
 */
export function applyPatches(rom: Uint8Array, patches: readonly Patch[]): Uint8Array {
  const out = new Uint8Array(rom)
  for (const p of patches) {
    if (!Number.isInteger(p.offset) || p.offset < 0 || p.offset >= out.length) {
      throw new RangeError(`patch offset ${p.offset} outside ROM of ${out.length} bytes`)
    }
    if (!Number.isInteger(p.value) || p.value < 0 || p.value > 0xff) {
      throw new RangeError(`patch value ${p.value} at offset ${p.offset} is not a byte`)
    }
    out[p.offset] = p.value
  }
  return out
}

/** Convenience: base ROM with the whole stack applied. */
export function build(rom: Uint8Array, layers: readonly PatchLayer[]): Uint8Array {
  return applyPatches(rom, flatten(layers))
}

/**
 * The layer that undoes `layer`, built from the bytes actually under it.
 *
 * `under` must be the ROM as it stood BEFORE this layer was applied, which for
 * a single layer on the base is the base itself. Inverting against the wrong
 * state produces a layer that restores the wrong bytes, so callers that keep a
 * stack should prefer dropping the layer and rebuilding.
 */
export function invertLayer(under: Uint8Array, layer: PatchLayer): PatchLayer {
  return {
    id: `${layer.id}~undo`,
    label: `undo ${layer.label}`,
    patches: layer.patches.map(p => {
      if (p.offset < 0 || p.offset >= under.length) {
        throw new RangeError(`cannot invert patch at ${p.offset}: outside ROM`)
      }
      return { offset: p.offset, value: under[p.offset] }
    }),
  }
}

/**
 * History: the stack as it stood immediately after `id` was applied.
 * Throws on an unknown id rather than returning the whole stack, which would
 * silently mean "no time travel happened".
 */
export function upTo(layers: readonly PatchLayer[], id: string): PatchLayer[] {
  const i = layers.findIndex(l => l.id === id)
  if (i < 0) throw new Error(`no layer with id "${id}"`)
  return layers.slice(0, i + 1)
}

/** Commit: one layer doing what the run did, with no intermediate steps. */
export function squash(layers: readonly PatchLayer[], id: string, label: string): PatchLayer {
  return { id, label, patches: flatten(layers) }
}
