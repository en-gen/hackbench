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
 * Stored in the project manifest, merged onto what is on disk the same way
 * `updateProject` does, so fields written by a newer build survive a rename
 * made by an older one.
 *
 * No VS Code or Theia imports, same rule as the rest of src/project/.
 */
import * as fs from 'fs'
import { openProject, ProjectManifest } from './Project'

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
 * Long enough for a descriptive track name, short enough that the manifest
 * stays readable and a paste accident is refused rather than stored.
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
 * Tolerant on read because the manifest is a plain JSON file people edit by
 * hand: `$0B`, `0x0b`, `b` and `0B` are all the same track, and silently
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

/** The manifest's alias block, as it sits on disk. */
type AliasBlock = Partial<Record<AliasNamespace, Record<string, unknown>>>

interface ManifestWithAliases extends ProjectManifest {
  aliases?: AliasBlock
}

function readManifest(manifestPath: string): ManifestWithAliases {
  // Round-trips through openProject first so a manifest that is unreadable,
  // orphaned or from a future schema is refused BEFORE anything is written.
  openProject(manifestPath)
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestWithAliases
}

/**
 * Every name the project holds in one namespace.
 *
 * Entries whose value is not a string are dropped rather than coerced: a
 * hand-edited `42` is a mistake, and rendering it as a track name would
 * present that mistake as the user's own choice.
 */
export function readAliases(manifestPath: string, ns: AliasNamespace): AliasTable {
  const raw = readManifest(manifestPath).aliases?.[ns]
  if (!raw) return {}

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
 * Emptied namespaces and an emptied alias block are removed rather than
 * left as `{}`: a project that has named nothing should look like one, and
 * an empty husk in the manifest invites the question of what used to be
 * there.
 */
export function setAlias(
  manifestPath: string,
  ns: AliasNamespace,
  id: number,
  alias: string,
): AliasTable {
  const cleaned = cleanAlias(alias)
  const manifest = readManifest(manifestPath)

  const aliases: AliasBlock = { ...manifest.aliases }
  const table: Record<string, unknown> = { ...aliases[ns] }

  // Delete every spelling of this id, not just the canonical one, or a
  // hand-written `$05` would survive a clear and reappear on the next read.
  const key = aliasKey(id)
  for (const existing of Object.keys(table)) {
    if (normaliseKey(existing) === key) delete table[existing]
  }
  if (cleaned) table[key] = cleaned

  if (Object.keys(table).length > 0) aliases[ns] = table
  else delete aliases[ns]

  const merged: ManifestWithAliases = { ...manifest }
  if (Object.keys(aliases).length > 0) merged.aliases = aliases
  else delete merged.aliases

  fs.writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return readAliases(manifestPath, ns)
}
