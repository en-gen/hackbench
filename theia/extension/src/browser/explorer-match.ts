/**
 * What a typed query matches in an explorer row (#336). Pure: no Theia import,
 * so vitest loads it directly.
 *
 * A row matches when the query reads as its id, or is a case-insensitive
 * substring of any of its texts. A `$` or `0x` prefix says "this is an id", so
 * `$1` never matches a name that merely contains "1".
 */
import { parseHexId } from '../../../../src/project/HexId'

export interface SearchRow {
  /** The number the row shows (map slot, GFX file, track); absent on folders. */
  id?: number
  /** The names the row shows, plus any alias. */
  texts: readonly string[]
}

export interface ParsedQuery {
  text: string
  /** Null when the query is not an id. */
  id: number | null
  /** A `$` or `0x` prefix: match ids only. */
  idOnly: boolean
}

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim()
  return { text, id: parseHexId(text), idOnly: /^(\$|0x)/i.test(text) }
}

export function rowMatches(query: ParsedQuery, row: SearchRow): boolean {
  if (query.text === '') return false
  if (query.id !== null && row.id === query.id) return true
  if (query.idOnly) return false
  const needle = query.text.toLowerCase()
  return row.texts.some(t => t.toLowerCase().includes(needle))
}
