/**
 * Can the engine vouch for this sprite's appearance on the open cart?
 *
 * A descriptor is a trace of ONE piece of 65816 code. If the cart no longer
 * points the sprite at that code, the trace describes something that is not
 * running, and every appearance claim derived from it is void. This is the
 * query a caller asks BEFORE asserting anything about a sprite.
 *
 * Deliberately separate from `resolveIdentity` in `SpriteDrawEngine`, which
 * answers a different question ("which descriptor should the engine use")
 * and folds an alias onto another traced handler into a renderable answer.
 * This one does not fold anything: it reports what moved and in which table,
 * because a caller that only gets a boolean cannot tell a relocated draw
 * routine from a retuned init routine.
 *
 * SCOPE. This says what the engine CAN VERIFY. It is not a licence to
 * override a display choice the user made: declining to assert something
 * unverified and hiding something the user asked for are different acts.
 * Nothing here may be wired to suppress a user-enabled annotation.
 * See `docs/sprites/sprite-engine-wiring.md`.
 *
 * Pure and plain-data: no vscode, no webview, no canvas. The result is
 * structurally clonable, so it survives the extension-host to webview hop.
 *
 * Evidence scope: the pointer-table bases are the ones verified in
 * `docs/sprites/sprite-engine-divergence.md` against the 6 ROM files in `test/roms/`.
 * Static reads only; no emulator was run.
 */

import type { RomFile } from '../../../RomFile'
import { SPRITE_DRAW_DESCRIPTORS, type SpriteDrawDescriptor } from './SpriteDrawDescriptor'
import { readHandlerPointers } from './SpriteDrawEngine'

/** One pointer that no longer matches the descriptor's traced handler. */
export interface HandlerDivergence {
  /** `main` is the DRAW handler. `init` runs once at spawn and never draws,
   *  but it can still establish palette or attribute state the draw reads
   *  (see the `initTableByX` palette source). */
  table: 'main' | 'init'
  /** The handler the descriptor was traced from. */
  expected: number
  /** What the open cart points at now. */
  found: number
}

export type HandlerProvenance =
  /** Both pointers match the traced handlers. The engine can vouch for it. */
  | { kind: 'vanilla'; spriteId: number; main: number; init: number }
  /** At least one pointer moved. `divergences` is never empty and is ordered
   *  main first, so a caller that only cares about the draw handler can read
   *  `divergences[0].table === 'main'`. */
  | {
      kind: 'diverged'
      spriteId: number
      main: number
      init: number
      divergences: HandlerDivergence[]
    }
  /** No descriptor has been traced for this sprite, so there is nothing to
   *  compare against. Distinct from divergence: nobody has looked yet. */
  | { kind: 'untraced'; spriteId: number }
  /** The pointer tables could not be read (out of range id, truncated cart). */
  | { kind: 'unreadable'; spriteId: number }

/**
 * Compare the cart's MAIN and INIT pointers for `spriteId` against the
 * handlers its descriptor was traced from.
 */
export function describeHandlerProvenance(
  rom: RomFile,
  spriteId: number,
  descriptors: readonly SpriteDrawDescriptor[] = SPRITE_DRAW_DESCRIPTORS,
): HandlerProvenance {
  const d = descriptors.find(x => x.spriteId === spriteId)
  if (!d) return { kind: 'untraced', spriteId }
  const ptrs = readHandlerPointers(rom, spriteId)
  if (!ptrs) return { kind: 'unreadable', spriteId }

  const divergences: HandlerDivergence[] = []
  if (ptrs.main !== d.vanillaMainHandler) {
    divergences.push({ table: 'main', expected: d.vanillaMainHandler, found: ptrs.main })
  }
  if (ptrs.init !== d.vanillaInitHandler) {
    divergences.push({ table: 'init', expected: d.vanillaInitHandler, found: ptrs.init })
  }
  return divergences.length === 0
    ? { kind: 'vanilla', spriteId, main: ptrs.main, init: ptrs.init }
    : { kind: 'diverged', spriteId, main: ptrs.main, init: ptrs.init, divergences }
}

/** One line for an editor tooltip or a console warning. */
export function provenanceMessage(p: HandlerProvenance): string {
  const id = `$${p.spriteId.toString(16).toUpperCase().padStart(2, '0')}`
  switch (p.kind) {
    case 'vanilla':
      return `${id}: vanilla handlers`
    case 'untraced':
      return `${id}: no descriptor traced`
    case 'unreadable':
      return `${id}: handler pointers unreadable`
    case 'diverged': {
      const where = p.divergences
        .map(
          v =>
            `${v.table} $${v.expected.toString(16).toUpperCase()} -> $${v.found.toString(16).toUpperCase()}`,
        )
        .join(', ')
      return `${id}: custom handler, appearance unverified (${where})`
    }
  }
}
