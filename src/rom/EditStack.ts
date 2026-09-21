/**
 * The ordered list of edits a user has made, and how it becomes patch layers.
 *
 * WHAT IS STORED IS THE EDIT, NOT THE BYTES.
 *
 * An EditOp says "move sprite 2 in level $001 three tiles right". It carries
 * no ROM bytes at all, and that is the point:
 *
 * - A patch VALUE is a byte copied out of the cart. A file full of them is
 *   ROM-derived output, which this repo refuses to commit (see
 *   tools/scripts/check-staged-content.sh). An edit history nobody can commit
 *   or share is worth much less. An op is just intent, so it travels freely.
 * - Ops survive the base ROM changing underneath them, because the byte to
 *   patch is located by re-reading the level's streams. A stored raw offset
 *   would silently rot the moment anything moved.
 * - Undo is dropping an op and recomputing, so there is no inverse-layer
 *   bookkeeping to get out of step with reality.
 *
 * Layers are therefore DERIVED, every time, from the ROM in front of us. That
 * is the same rule this project applies to ROM data generally: read the cart,
 * do not hardcode what you read from it last time.
 */
import { PatchLayer } from './PatchLayer'

/** A level edit, expressed as intent. Serializable, contains no ROM bytes. */
export type EditOp =
  | { kind: 'moveObjectX'; level: number; index: number; dx: number }
  | { kind: 'moveSpriteX'; level: number; index: number; dx: number }
  | { kind: 'deleteSprite'; level: number; index: number }

export interface EditDocument {
  /** Bumped when the on-disk shape changes, so an old file is rejected loudly. */
  version: 1
  ops: EditOp[]
}

export function emptyDocument(): EditDocument {
  return { version: 1, ops: [] }
}

/**
 * Parse a stored edit document.
 *
 * Returns null for anything unrecognised rather than guessing. A half-understood
 * edit history is worse than none: it would silently drop the ops it could not
 * read, and the user would see some of their edits apply and not know why the
 * rest vanished.
 */
export function parseDocument(text: string): EditDocument | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return null
    const doc = raw as Partial<EditDocument>
    if (doc.version !== 1 || !Array.isArray(doc.ops)) return null
    if (!doc.ops.every(isEditOp)) return null
    return { version: 1, ops: doc.ops }
  } catch {
    return null
  }
}

function isEditOp(v: unknown): v is EditOp {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!Number.isInteger(o.level) || !Number.isInteger(o.index)) return false
  if (o.kind === 'deleteSprite') return true
  return (o.kind === 'moveObjectX' || o.kind === 'moveSpriteX') && Number.isInteger(o.dx)
}

export function serializeDocument(doc: EditDocument): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

/** Ops affecting one level, in order. */
export function opsForLevel(doc: EditDocument, level: number): EditOp[] {
  return doc.ops.filter(o => o.level === level)
}

/**
 * Turn ops into layers, using `toLayer` to do the ROM reading.
 *
 * An op that cannot be applied is SKIPPED and reported, not thrown: one stale
 * edit (a sprite that no longer exists, a move that would now leave its screen)
 * must not stop the rest of a user's history from loading. The caller decides
 * how loudly to complain.
 */
export function toLayers(
  ops: readonly EditOp[],
  toLayer: (op: EditOp, seq: number) => PatchLayer,
): { layers: PatchLayer[]; skipped: { op: EditOp; reason: string }[] } {
  const layers: PatchLayer[] = []
  const skipped: { op: EditOp; reason: string }[] = []
  ops.forEach((op, seq) => {
    try {
      layers.push(toLayer(op, seq))
    } catch (err) {
      skipped.push({ op, reason: (err as Error).message })
    }
  })
  return { layers, skipped }
}
