/**
 * Map groups: named virtual folders over the map explorer, stored in
 * meta/groups.json (see ProjectMeta.ts).
 *
 * No VS Code or Theia imports, same rule as the rest of src/project/.
 */
import { readMeta, writeMeta } from './ProjectMeta'
import type { MapNode, MapTree } from '../rom/MapTree'

export interface MapGroup {
  name: string
  slots: number[]
}

const MAX_SLOT = 0x1ff

/** Sha256 of the vanilla cart (copier header stripped), per romIdentity(). Never the title. */
export const VANILLA_SHA256 = '0838e531fe22c077528febe14cb3ff7c492f1f5fa8de354192bdff7137c27f5b'

/**
 * Stock area groups, read from the vanilla ROM's overworld name table, not
 * from a published list: of 77 slots in the list the owner started from, 52
 * named a different map than the ROM does. See the spec for the citation.
 *
 * Names carry their area number ("1. Yoshi's Island") so the default,
 * alphabetic-by-name sort lands them in world order instead of alphabetical
 * order (Chocolate Island before Donut Plains, etc).
 */
export const VANILLA_SEED: MapGroup[] = [
  { name: "1. Yoshi's Island", slots: [0x104, 0x105, 0x106, 0x103, 0x102, 0x101, 0x014] },
  {
    name: '2. Donut Plains',
    slots: [0x015, 0x009, 0x005, 0x006, 0x007, 0x00a, 0x10b, 0x004, 0x013, 0x003, 0x008],
  },
  {
    name: '3. Vanilla Dome',
    slots: [0x11a, 0x118, 0x10a, 0x119, 0x11c, 0x109, 0x001, 0x002, 0x107, 0x00b, 0x11b],
  },
  { name: '4. Twin Bridges', slots: [0x00f, 0x010, 0x00c, 0x00d, 0x011, 0x00e] },
  {
    name: '5. Forest of Illusion',
    slots: [0x11e, 0x120, 0x123, 0x11f, 0x020, 0x11d, 0x122, 0x01f, 0x121],
  },
  {
    name: '6. Chocolate Island',
    slots: [0x022, 0x024, 0x023, 0x01d, 0x01c, 0x01a, 0x021, 0x01b, 0x117],
  },
  {
    name: '7. Valley of Bowser',
    slots: [0x116, 0x115, 0x113, 0x10f, 0x110, 0x114, 0x111, 0x10d, 0x10e, 0x018],
  },
  { name: '8. Star World', slots: [0x134, 0x130, 0x132, 0x135, 0x136] },
  { name: '9. Special Zone', slots: [0x12a, 0x12b, 0x12c, 0x12d, 0x128, 0x127, 0x126, 0x125] },
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGroupShape(value: unknown): value is MapGroup {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.slots) &&
    value.slots.every(s => typeof s === 'number')
  )
}

/**
 * Every refusal a bad write must report. Checked as a whole list, because a
 * clash or an out-of-range slot can only be seen across entries.
 */
export function validateGroups(groups: MapGroup[]): void {
  const seenNames = new Set<string>()
  const seenSlots = new Set<number>()

  for (const g of groups) {
    const trimmed = g.name.trim()
    if (!trimmed) throw new Error('A group name cannot be empty')

    const lower = trimmed.toLowerCase()
    if (seenNames.has(lower)) throw new Error(`Duplicate group name: ${trimmed}`)
    seenNames.add(lower)

    for (const slot of g.slots) {
      if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
        throw new Error(`Slot out of range: ${slot}`)
      }
      if (seenSlots.has(slot)) {
        throw new Error(`Slot $${slot.toString(16).toUpperCase()} is in more than one group`)
      }
      seenSlots.add(slot)
    }
  }
}

/**
 * Read groups.json. Throws on a malformed shape or a content violation
 * (validateGroups), never repairs. Absent file reads as `undefined`, distinct
 * from `[]`, so a caller can tell "never seeded" from "seeded, then emptied".
 */
export function readGroups(manifestPath: string): MapGroup[] | undefined {
  const raw = readMeta(manifestPath, 'groups')
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || !raw.every(isGroupShape)) {
    throw new Error(`meta/groups.json is not a { name, slots }[] array: ${manifestPath}`)
  }
  validateGroups(raw)
  return raw
}

/** Validates before writing, so a bad list never reaches disk. */
export function writeGroups(manifestPath: string, groups: MapGroup[]): void {
  validateGroups(groups)
  writeMeta(manifestPath, 'groups', groups)
}

/**
 * Seed the stock areas once, on a vanilla project that has never had a
 * groups file. `[]` (every group deleted by the user) is left alone: the
 * groups belong to the user from their first write onward. Keyed on the
 * hash alone; `title` is carried so the gate stays plantable in a test
 * (swap the comparison to `title`) without changing every call site.
 */
export function seedIfVanilla(
  manifestPath: string,
  baseRom: { sha256: string; title: string },
): MapGroup[] {
  const existing = readGroups(manifestPath)
  if (existing !== undefined) return existing
  if (baseRom.sha256 !== VANILLA_SHA256) return []

  writeGroups(manifestPath, VANILLA_SEED)
  return VANILLA_SEED
}

export interface UserGroup {
  name: string
  maps: (MapNode & { orphan: boolean })[]
}

/**
 * The map tree after groups.json has pulled some top-level maps out of it.
 *
 * There is no separate Overworld folder: every top-level map not in a user
 * group (entry map or orphan alike) is Unassigned, sorted by slot. `orphan`
 * carries the reachability marking a grouped map keeps regardless of where
 * it sits, same as on a group's own members.
 */
export interface GroupedMapTree {
  groups: UserGroup[]
  unassigned: (MapNode & { orphan: boolean })[]
}

/**
 * Move grouped top-level maps out of the top level into their group,
 * carrying their sub-area subtree as is. Pure: no ROM or filesystem access.
 *
 * Stale slots (named by a group but no longer a top-level map) are skipped,
 * not errored: the caller owns whether to keep them in the file.
 */
export function applyGroups(tree: MapTree, groups: MapGroup[]): GroupedMapTree {
  const overworldByIndex = new Map(tree.overworld.map(n => [n.index, n]))
  const unassignedByIndex = new Map(tree.unassigned.map(n => [n.index, n]))
  const claimed = new Set<number>()

  const userGroups: UserGroup[] = groups
    .map(g => {
      const maps: (MapNode & { orphan: boolean })[] = []
      for (const slot of g.slots) {
        if (claimed.has(slot)) continue
        const entry = overworldByIndex.get(slot)
        if (entry) {
          maps.push({ ...entry, orphan: false })
          claimed.add(slot)
          continue
        }
        const orphan = unassignedByIndex.get(slot)
        if (orphan) {
          maps.push({ ...orphan, orphan: true })
          claimed.add(slot)
        }
      }
      return { name: g.name, maps }
    })
    // Numeric so a user's own "10. ..." sorts after "9. ...", not before it.
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const unassigned = [
    ...tree.overworld.filter(n => !claimed.has(n.index)).map(n => ({ ...n, orphan: false })),
    ...tree.unassigned.filter(n => !claimed.has(n.index)).map(n => ({ ...n, orphan: true })),
  ].sort((a, b) => a.index - b.index)

  return { groups: userGroups, unassigned }
}

/** Every slot that currently names a top-level map (entry or orphan). */
export function topLevelSlots(tree: MapTree): Set<number> {
  return new Set([...tree.overworld, ...tree.unassigned].map(n => n.index))
}

/** Slots a group list names that `applyGroups` could not resolve against a tree. */
export function staleSlots(tree: MapTree, groups: MapGroup[]): number[] {
  const known = topLevelSlots(tree)
  return groups.flatMap(g => g.slots).filter(slot => !known.has(slot))
}

/** The result of reading meta/groups.json, kept separate from the read itself so admission is pure. */
export type GroupsRead =
  { status: 'ok'; groups: MapGroup[] | undefined } | { status: 'invalid'; reason: string }

export type AdmitResult = { status: 'ok' } | { status: 'invalid'; reason: string }

/**
 * Whether `next` may be written, given what is already on disk and which
 * slots are currently top-level maps. Pure: takes the OUTCOME of reading the
 * file and the ROM's tree, never touches either itself, so it is testable
 * with synthetic fixtures alone.
 *
 * Two rules: never write over a file that is already broken (`previous`
 * failed to read), and a slot may only be added if it currently names a
 * top-level map UNLESS it was already on disk (a stale slot from a ROM swap
 * survives an unrelated edit rather than blocking it).
 */
export function admitGroups(
  next: MapGroup[],
  previous: GroupsRead,
  topLevel: Set<number>,
): AdmitResult {
  if (previous.status === 'invalid') return previous

  const previousSlots = new Set((previous.groups ?? []).flatMap(g => g.slots))
  for (const g of next) {
    for (const slot of g.slots) {
      if (!topLevel.has(slot) && !previousSlots.has(slot)) {
        return {
          status: 'invalid',
          reason: `Slot $${slot.toString(16).toUpperCase()} is not a top-level map`,
        }
      }
    }
  }
  return { status: 'ok' }
}

/** What `loadMaps` should use as the project's groups, and whether that came from seeding. */
export type GroupsDecision =
  | { action: 'use'; groups: MapGroup[] }
  | { action: 'seed'; groups: MapGroup[] }
  | { action: 'error'; groupsError: string }

/**
 * Decide what groups.json means for this load, without reading or writing
 * anything: `read` is the file's own outcome, `isVanilla` is whether the
 * project's base ROM hash is the exact vanilla one. A bad file always wins
 * over seeding (a broken file must be reported, not silently replaced by a
 * fresh seed). Seeding itself (the write) is the caller's job; this only
 * says whether one is called for.
 */
export function resolveGroups(read: GroupsRead, isVanilla: boolean): GroupsDecision {
  if (read.status === 'invalid') return { action: 'error', groupsError: read.reason }
  if (read.groups !== undefined) return { action: 'use', groups: read.groups }
  if (isVanilla) return { action: 'seed', groups: VANILLA_SEED }
  return { action: 'use', groups: [] }
}
