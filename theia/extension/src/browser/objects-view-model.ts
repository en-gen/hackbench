/**
 * The Objects activity's pure decisions, kept out of the .tsx so they can be
 * unit-tested without React (same split as map16-view-model.ts).
 */
import type {
  ObjectDefinitionDto,
  ObjectDraftDto,
  SkippedObjectDto,
} from '../common/objects-protocol'
import { formatCharNum } from './map16-view-model'

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

/** The editor's own state, kept pure so the stale-reply and tileset rules can be tested. */
export interface EditorState {
  /** The saved definition being edited, or undefined for one not saved yet. */
  editId: string | undefined
  name: string
  tileset: number | undefined
  tags: TagState
  /**
   * Bumped whenever the editor stops being the thing a request was sent for
   * (another row, New, a tileset change, another project). A reply carries the
   * token it was sent with and is dropped when it no longer matches.
   */
  token: number
}

export const EMPTY_EDITOR: EditorState = {
  editId: undefined,
  name: '',
  tileset: undefined,
  tags: NO_TAGS,
  token: 0,
}

/** A blank, unsaved definition; also what a project change resets to. */
export function newObjectState(s: EditorState): EditorState {
  return { ...EMPTY_EDITOR, token: s.token + 1 }
}

export function openDefinition(s: EditorState, def: ObjectDefinitionDto): EditorState {
  return {
    editId: def.id,
    name: def.name,
    tileset: def.tileset,
    tags: { edge: def.edge, fill: def.fill },
    token: s.token + 1,
  }
}

/**
 * Another tileset makes the same numbers other tiles, so the tags go, and the
 * editor becomes a new, unsaved definition: Save must not overwrite the saved
 * one that was open. The name stays, so renaming-by-retarget is one step.
 */
export function changeTileset(s: EditorState, tileset: number | undefined): EditorState {
  if (tileset === s.tileset) return s
  return { editId: undefined, name: s.name, tileset, tags: NO_TAGS, token: s.token + 1 }
}

export function tagEditor(s: EditorState, tile: number, role: ObjectRole): EditorState {
  return canTag(s.tileset) ? { ...s, tags: tagTile(s.tags, tile, role) } : s
}

/** What Save sends, or undefined while there is no tileset to save against. */
export function draftOf(s: EditorState): ObjectDraftDto | undefined {
  if (s.tileset === undefined) return undefined
  return {
    id: s.editId,
    name: s.name,
    tileset: s.tileset,
    edge: [...s.tags.edge],
    fill: [...s.tags.fill],
  }
}

/** A save or rename reply: it names the definition only if the editor is still the one it was sent for. */
export function applyWriteReply(
  s: EditorState,
  sentToken: number,
  def: ObjectDefinitionDto,
): EditorState {
  return sentToken === s.token ? { ...s, editId: def.id, name: def.name } : s
}

/** Tile numbers as the Map16 editor writes them. */
export function formatTileLabel(tile: number): string {
  return `Tile ${formatCharNum(tile)}`
}

/** The id a skipped file can be removed by, or undefined when its name is not a usable id. */
export function removableId(file: string): string | undefined {
  if (!file.endsWith('.json')) return undefined
  const stem = file.slice(0, -'.json'.length)
  return stem.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem) ? stem : undefined
}
