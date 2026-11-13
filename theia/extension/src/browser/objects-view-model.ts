/**
 * The Objects activity's pure decisions, kept out of the .tsx so they can be
 * unit-tested without React (same split as map16-view-model.ts).
 */
import type { SkippedObjectDto } from '../common/objects-protocol'

export type ObjectRole = 'edge' | 'fill'

export interface TagState {
  edge: readonly number[]
  fill: readonly number[]
}

export const NO_TAGS: TagState = { edge: [], fill: [] }

export function roleOf(tags: TagState, tile: number): ObjectRole | undefined {
  if (tags.edge.includes(tile)) return 'edge'
  if (tags.fill.includes(tile)) return 'fill'
  return undefined
}

/**
 * Clicking a tile with the current role: a tile already holding that role is
 * untagged; any other tile takes it and loses whatever role it had, so a tile
 * is never in both lists. Lists stay sorted.
 */
export function tagTile(tags: TagState, tile: number, role: ObjectRole): TagState {
  const other: ObjectRole = role === 'edge' ? 'fill' : 'edge'
  const mine = tags[role].includes(tile)
    ? tags[role].filter(t => t !== tile)
    : [...tags[role], tile].sort((a, b) => a - b)
  const theirs = tags[other].filter(t => t !== tile)
  return role === 'edge' ? { edge: mine, fill: theirs } : { edge: theirs, fill: mine }
}

/** No tile can be tagged until a tileset is picked: its tiles are what a tag names. */
export function canTag(tileset: number | undefined): boolean {
  return tileset !== undefined
}

/** The note for a file in meta/objects/ that was not loaded. */
export function skippedNote(s: SkippedObjectDto): string {
  return `This Object file could not be read: ${s.reason} (${s.file})`
}
