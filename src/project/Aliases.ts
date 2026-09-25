/**
 * User-supplied names for things the cartridge does not name.
 *
 * A music track has no name anywhere in a ROM. The disassembly's
 * constants.asm carries names (ATHLETIC, CASTLE, BOWSERPHASE2, ...) but
 * those describe a STOCK cartridge: all three AddmusicK carts in this
 * repo's corpus point their eight level-music slots at BGM $0A-$12, which
 * under stock naming reads GAMEOVER, KEYHOLE, BOSSCLEAR, SPOTLIGHT,
 * KEYHOLE2, LEVELCLEAR, PSWITCH, BONUSGAME. Labelling a hack's tracks from
 * that table is the confidently-wrong output this project keeps having to
 * design against, so the names come from the user instead.
 *
 * NAMESPACED, because the same problem applies to more than music. A
 * translevel id is no more memorable than a BGM command, and issue #396
 * lists map aliases as project metadata. Adding maps needs no format
 * change: a new namespace string is the whole of it.
 *
 * The three music banks are separate namespaces rather than one, because a
 * BGM command means a different song in each. Command $02 is OVERWORLD in
 * the level bank and DONUTPLAINS in the overworld bank; with one flat table
 * naming either would rename both.
 *
 * Stored in meta/aliases.json (see ProjectMeta.ts), not the manifest: it is
 * user metadata, not project identity.
 *
 * No VS Code or Theia imports, same rule as the rest of src/project/.
 */
import { readMeta, writeMeta } from './ProjectMeta'

/**
 * Which kind of thing is being named.
 *
 * A union rather than a bare string so a typo becomes a compile error
 * instead of a second, silently empty namespace.
 */
export type AliasNamespace = 'music.level' | 'music.overworld' | 'music.credits' | 'map'

/** Canonical hex key to the name the user gave it. */
export type AliasTable = Record<string, string>

/**
 * Long enough for a descriptive track name, short enough that the alias
 * file stays readable and a paste accident is refused rather than stored.
 */
export const ALIAS_MAX_LENGTH = 64

/**
 * The canonical key for an id: uppercase hex, at least two digits.
 *
 * Two digits is the natural width of a BGM command; a wider id (a map's
 * three-digit translevel) keeps its own width rather than being truncated.
 * Fixed here rather than at each call site so a key written by the music
 * panel is the same string the map tree would write.
 */
export function aliasKey(id: number): string {
  return id.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * Normalise a key as it was found on disk.
 *
 * Tolerant on read because the alias file is a plain JSON file people edit
 * by hand: `$0B`, `0x0b`, `b` and `0B` are all the same track, and silently
 * dropping three of those spellings would look like the name was lost.
 */
function normaliseKey(raw: string): string | null {
  const stripped = raw.trim().replace(/^\$/, '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(stripped)) return null
  return aliasKey(parseInt(stripped, 16))
}

/**
 * A name fit to store: trimmed, with control characters removed.
 *
 * Control characters are stripped rather than refused because they arrive
 * by paste rather than by intent, and a name that merely loses a stray
 * newline is a better outcome than a rejected rename. Length is refused,
 * not truncated: a silently shortened name is one the user did not choose.
 */
function cleanAlias(alias: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = alias.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (cleaned.length > ALIAS_MAX_LENGTH) {
    throw new Error(`Name is too long: ${cleaned.length} characters, limit is ${ALIAS_MAX_LENGTH}`)
  }
  return cleaned
}

/** The alias file's shape, as it sits on disk. */
type AliasBlock = Partial<Record<AliasNamespace, Record<string, unknown>>>

/** `Object.entries` on a string or array walks its indices, which is not a namespace's table. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAliasBlock(manifestPath: string): AliasBlock {
  const raw = readMeta(manifestPath, 'aliases')
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) {
    throw new Error(`meta/aliases.json is not an object of namespaces: ${manifestPath}`)
  }
  return raw as AliasBlock
}

/**
 * Every name the project holds in one namespace.
 *
 * Entries whose value is not a string are dropped rather than coerced: a
 * hand-edited `42` is a mistake, and rendering it as a track name would
 * present that mistake as the user's own choice. A namespace whose own
 * value is not an object (a hand-edited `"oops"`) is treated the same way,
 * emptied rather than iterated: a string's character indices are not names.
 */
export function readAliases(manifestPath: string, ns: AliasNamespace): AliasTable {
  const raw = readAliasBlock(manifestPath)[ns]
  if (!isPlainObject(raw)) return {}

  const table: AliasTable = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const normalised = normaliseKey(key)
    if (normalised !== null) table[normalised] = value
  }
  return table
}

/**
 * Name one thing, or clear its name by passing an empty one.
 *
 * Returns the namespace as it now stands, so a caller can re-render without
 * a second read.
 *
 * Emptied namespaces are removed rather than left as `{}`: a project that
 * has named nothing in a namespace should look like one.
 */
export function setAlias(
  manifestPath: string,
  ns: AliasNamespace,
  id: number,
  alias: string,
): AliasTable {
  const cleaned = cleanAlias(alias)
  const aliases = readAliasBlock(manifestPath)

  // A hand-edited non-object namespace (`"oops"`) is replaced, not spread:
  // spreading a string copies its character indices in as fake entries.
  const existingNs = aliases[ns]
  const table: Record<string, unknown> = isPlainObject(existingNs) ? { ...existingNs } : {}

  // Delete every spelling of this id, not just the canonical one, or a
  // hand-written `$05` would survive a clear and reappear on the next read.
  const key = aliasKey(id)
  for (const existing of Object.keys(table)) {
    if (normaliseKey(existing) === key) delete table[existing]
  }
  if (cleaned) table[key] = cleaned

  if (Object.keys(table).length > 0) aliases[ns] = table
  else delete aliases[ns]

  writeMeta(manifestPath, 'aliases', aliases)
  return readAliases(manifestPath, ns)
}
