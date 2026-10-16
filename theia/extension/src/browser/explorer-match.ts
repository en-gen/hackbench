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
  /**
   * A number the row shows in DECIMAL (a palette group's CGRAM row). Matched by
   * bare digits only, read as decimal; `$`/`0x` stay hex ids.
   */
  decId?: number
  /** The names the row shows, plus any alias. */
  texts: readonly string[]
  /** False for a row that opens nothing (loop, truncated, no-pointer markers). */
  openable?: boolean
  /** A pure grouping row: not where select-first or Enter lands while a leaf matches. */
  folder?: boolean
}

export interface ParsedQuery {
  text: string
  /** Null when the query is not an id. */
  id: number | null
  /** A `$` or `0x` prefix: match ids only. */
  idOnly: boolean
  /** A bare `$` or `0x`: the user is still typing an id, so nothing filters yet. */
  incomplete: boolean
}

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim()
  return {
    text,
    id: parseHexId(text),
    idOnly: /^(\$|0x)/i.test(text),
    incomplete: /^(\$|0x)$/i.test(text),
  }
}

export function rowMatches(query: ParsedQuery, row: SearchRow): boolean {
  if (query.text === '' || query.incomplete) return false
  if (query.id !== null && row.id === query.id) return true
  if (row.decId !== undefined && /^\d+$/.test(query.text) && Number(query.text) === row.decId) {
    return true
  }
  if (query.idOnly) return false
  const needle = query.text.toLowerCase()
  return row.texts.some(t => t.toLowerCase().includes(needle))
}

interface Walkable {
  id: string
  children?: readonly Walkable[]
  parent?: Walkable
}

/**
 * The rows a query matches, in tree order, and the ids that stay drawn: each
 * match, its ancestors, and everything under a matching folder (its own name
 * matching says "this group", so its contents are the answer). `searchable` is
 * false for a root of messages only, which has nothing to filter.
 */
export function filterTree<T extends { id: string }>(
  root: T | undefined,
  query: ParsedQuery,
  rowOf: (node: T) => SearchRow | undefined,
): { matches: T[]; shown: Set<string>; searchable: boolean } {
  let searchable = false
  const matches: T[] = []
  const shown = new Set<string>()
  const showAll = (n: Walkable): void => {
    shown.add(n.id)
    n.children?.forEach(showAll)
  }
  const walk = (n: Walkable): void => {
    // The root is invisible scaffolding, never a row: a widget's rowOf may
    // classify it (music: a folder, maps: a map), which made a message-only
    // tree look searchable.
    const row = n === root ? undefined : rowOf(n as unknown as T)
    if (row) searchable = true
    if (row && rowMatches(query, row)) {
      matches.push(n as unknown as T)
      for (let p: Walkable | undefined = n; p; p = p.parent) shown.add(p.id)
      if (row.folder) showAll(n)
    }
    n.children?.forEach(walk)
  }
  if (root) walk(root as unknown as Walkable)
  return { matches, shown, searchable }
}

/**
 * Select-first target: an openable leaf, else any leaf, else the first match
 * (a folder). Enter acts on the selection, so a marker row must not win it.
 */
export function pickSelectTarget<T>(
  matches: readonly T[],
  rowOf: (n: T) => SearchRow | undefined,
): T | undefined {
  const leaf = (m: T) => !rowOf(m)?.folder
  return (
    matches.find(m => leaf(m) && rowOf(m)?.openable !== false) ?? matches.find(leaf) ?? matches[0]
  )
}

/** The palette explorer's rows. A variant's id is the number ending its label only. */
export function paletteSearchRow(n: {
  kind: string
  name?: string
  row?: number
}): SearchRow | undefined {
  const name = n.name ?? ''
  if (n.kind === 'group') return { decId: n.row, texts: [name] }
  if (n.kind !== 'variant') return undefined
  const trailing = /(\d+)$/.exec(name)
  return { id: trailing ? Number(trailing[1]) : undefined, texts: [name] }
}

interface Expandable {
  id: string
  expanded?: boolean
  children?: readonly Expandable[]
}

/**
 * What to flip so every expandable node is back to its snapshot state. Walks
 * ALL nodes, collapsed ones included: the filter opens folders under a folder
 * the user had closed, and stopping at the closed one leaves those open.
 */
export function restorePlan<T extends { id: string }>(
  root: T | undefined,
  before: ReadonlySet<string>,
): { node: T; expand: boolean }[] {
  const out: { node: T; expand: boolean }[] = []
  const walk = (n: Expandable): void => {
    if ('expanded' in n && Boolean(n.expanded) !== before.has(n.id)) {
      out.push({ node: n as unknown as T, expand: before.has(n.id) })
    }
    n.children?.forEach(walk)
  }
  if (root) walk(root as unknown as Expandable)
  return out
}
