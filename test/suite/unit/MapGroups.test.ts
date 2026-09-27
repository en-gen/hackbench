/**
 * Map groups: validation, persistence and applyGroups, all synthetic (no ROM).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createProject } from '../../../src/project/Project'
import {
  admitGroups,
  applyGroups,
  readGroups,
  resolveGroups,
  seedIfVanilla,
  staleSlots,
  topLevelSlots,
  validateGroups,
  writeGroups,
  VANILLA_SEED,
  VANILLA_SHA256,
  MapGroup,
} from '../../../src/project/MapGroups'
import type { MapNode, MapTree } from '../../../src/rom/MapTree'

const COPIER_HEADER_SIZE = 512
const VANILLA_TITLE = 'SUPER MARIOWORLD'

let tmp: string
let manifestPath: string

function fakeRom(): Buffer {
  const bytes = Buffer.alloc(COPIER_HEADER_SIZE + 0x8000)
  const title = 'FAKE CART'.padEnd(21, ' ')
  bytes.write(title, COPIER_HEADER_SIZE + 0x7fc0, 'ascii')
  return bytes
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-groups-'))
  fs.writeFileSync(path.join(tmp, 'fake.sfc'), fakeRom())
  const project = createProject({
    romPath: path.join(tmp, 'fake.sfc'),
    name: 'Hack',
    directory: path.join(tmp, 'Hack'),
  })
  manifestPath = project.manifestPath
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function mapNode(index: number, children: MapNode[] = []): MapNode {
  return { index, name: null, kind: 'map', l1Aliases: [], children }
}

function fakeTree(overworld: MapNode[], unassigned: MapNode[], bonus: MapNode[] = []): MapTree {
  return {
    special: [],
    bonus: bonus.map(n => ({ ...n, role: 'bonus-game' as const, foundAt: '$05DBA9' })),
    overworld,
    unassigned,
    mapCount: overworld.length + unassigned.length + bonus.length,
    counts: { entrances: overworld.length, unassigned: unassigned.length },
    notes: [],
  }
}

/** Writes an on-disk groups.json that bypasses writeGroups's own validation. */
function writeRawGroupsFile(value: unknown): void {
  const file = path.join(tmp, 'Hack', 'meta', 'groups.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

describe('validateGroups', () => {
  it('rejects an empty name', () => {
    expect(() => validateGroups([{ name: '   ', slots: [] }])).toThrow(/empty/)
  })

  it('rejects duplicate names differing only in case', () => {
    const groups: MapGroup[] = [
      { name: 'Star World', slots: [1] },
      { name: 'star world', slots: [2] },
    ]
    expect(() => validateGroups(groups)).toThrow(/duplicate/i)
  })

  it('rejects an out-of-range slot', () => {
    expect(() => validateGroups([{ name: 'A', slots: [0x200] }])).toThrow(/range/)
    expect(() => validateGroups([{ name: 'A', slots: [-1] }])).toThrow(/range/)
  })

  it('rejects one slot claimed by two groups', () => {
    const groups: MapGroup[] = [
      { name: 'A', slots: [5] },
      { name: 'B', slots: [5] },
    ]
    expect(() => validateGroups(groups)).toThrow(/more than one group/)
  })

  it('accepts a well-formed list', () => {
    expect(() =>
      validateGroups([
        { name: 'A', slots: [1, 2] },
        { name: 'B', slots: [3] },
      ]),
    ).not.toThrow()
  })
})

describe('readGroups', () => {
  it('throws on unparsable JSON, and a bad write attempt leaves it byte-identical', () => {
    const file = path.join(tmp, 'Hack', 'meta', 'groups.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not valid json')
    const before = fs.readFileSync(file, 'utf8')

    expect(() => readGroups(manifestPath)).toThrow(/not readable JSON/)
    // A write attempt with a BAD list must not touch the file: validation
    // runs before writeMeta is ever called.
    expect(() => writeGroups(manifestPath, [{ name: '', slots: [] }])).toThrow(/empty/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('throws on a well-shaped file with duplicate names ignoring case', () => {
    writeRawGroupsFile([
      { name: 'Star World', slots: [1] },
      { name: 'star world', slots: [2] },
    ])
    expect(() => readGroups(manifestPath)).toThrow(/duplicate/i)
  })

  it('throws on a well-shaped file with an empty name', () => {
    writeRawGroupsFile([{ name: '   ', slots: [] }])
    expect(() => readGroups(manifestPath)).toThrow(/empty/)
  })

  it('throws on a well-shaped file with a slot in two groups', () => {
    writeRawGroupsFile([
      { name: 'A', slots: [5] },
      { name: 'B', slots: [5] },
    ])
    expect(() => readGroups(manifestPath)).toThrow(/more than one group/)
  })

  it('throws on a well-shaped file with an out-of-range slot', () => {
    writeRawGroupsFile([{ name: 'A', slots: [0x200] }])
    expect(() => readGroups(manifestPath)).toThrow(/range/)
  })

  it('round-trips a valid list', () => {
    writeGroups(manifestPath, [{ name: 'Star World', slots: [1, 2, 3] }])
    expect(readGroups(manifestPath)).toEqual([{ name: 'Star World', slots: [1, 2, 3] }])
  })
})

describe('applyGroups', () => {
  it('moves an entry map out of the top level, with its sub-area subtree', () => {
    const sub = mapNode(0x1ff)
    const entry = mapNode(0x105, [sub])
    const tree = fakeTree([entry], [])

    const result = applyGroups(tree, [{ name: 'Yoshi', slots: [0x105] }])

    expect(result.unassigned).toEqual([])
    expect(result.groups).toEqual([{ name: 'Yoshi', maps: [{ ...entry, orphan: false }] }])
  })

  it('keeps the orphan marking on a grouped unassigned map', () => {
    const orphan = mapNode(0x0d3)
    const tree = fakeTree([], [orphan])

    const result = applyGroups(tree, [{ name: 'Misc', slots: [0x0d3] }])

    expect(result.unassigned).toEqual([])
    expect(result.groups[0]!.maps[0]!.orphan).toBe(true)
  })

  it('merges entry maps and orphans into one Unassigned list, sorted by slot', () => {
    const tree = fakeTree([mapNode(0x105), mapNode(0x001)], [mapNode(0x050), mapNode(0x002)])

    const result = applyGroups(tree, [])

    expect(result.unassigned.map(n => n.index)).toEqual([0x001, 0x002, 0x050, 0x105])
    expect(result.unassigned.map(n => n.orphan)).toEqual([false, true, true, false])
  })

  it('skips a stale slot (named by a group but not a top-level map), and leaves the caller to keep it', () => {
    const tree = fakeTree([mapNode(0x105)], [])
    const groups: MapGroup[] = [{ name: 'Ghost', slots: [0x199] }]

    const result = applyGroups(tree, groups)

    expect(result.groups[0]!.maps).toEqual([])
    expect(result.unassigned).toHaveLength(1)
    expect(result.unassigned[0]).toMatchObject({ index: 0x105, orphan: false })
  })

  it('refuses a sub area: a slot that only exists as a child is not a groupable top-level map', () => {
    const sub = mapNode(0x0c5)
    const entry = mapNode(0x105, [sub])
    const tree = fakeTree([entry], [])

    const result = applyGroups(tree, [{ name: 'Bad', slots: [0x0c5] }])

    expect(result.groups[0]!.maps).toEqual([])
    expect(result.unassigned).toHaveLength(1)
    expect(result.unassigned[0]!.children).toEqual([sub])
  })

  it('sorts groups by name', () => {
    const tree = fakeTree([mapNode(1), mapNode(2)], [])
    const result = applyGroups(tree, [
      { name: 'Zeta', slots: [2] },
      { name: 'Alpha', slots: [1] },
    ])
    expect(result.groups.map(g => g.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('sorts numeric name prefixes naturally, not lexically', () => {
    // A plain string sort puts '10. ...' before '9. ...' (the character '1'
    // sorts before '9'); the seed table's numbered names must not do that.
    const tree = fakeTree([mapNode(1), mapNode(2), mapNode(3)], [])
    const result = applyGroups(tree, [
      { name: '10. Ten', slots: [3] },
      { name: '2. Two', slots: [2] },
      { name: '9. Nine', slots: [1] },
    ])
    expect(result.groups.map(g => g.name)).toEqual(['2. Two', '9. Nine', '10. Ten'])
  })

  it('groups a bonus map like any other, and never marks it orphaned, in a group or out', () => {
    const tree = fakeTree([], [mapNode(0x0d3)], [mapNode(0x000), mapNode(0x0c8)])

    const result = applyGroups(tree, [{ name: 'Bonus Games', slots: [0x000] }])

    expect(result.groups[0]!.maps).toMatchObject([
      { index: 0x000, orphan: false, role: 'bonus-game' },
    ])
    expect(result.unassigned.map(n => [n.index, n.orphan, n.role])).toEqual([
      [0x0c8, false, 'bonus-game'],
      [0x0d3, true, undefined],
    ])
  })
})

describe('VANILLA_SEED', () => {
  it('sorts both after the nine numbered areas', () => {
    const slots = VANILLA_SEED.flatMap(g => g.slots)
    const tree = fakeTree(
      slots.map(s => mapNode(s)),
      [],
    )
    const names = applyGroups(tree, VANILLA_SEED).groups.map(g => g.name)
    expect(names.slice(-3)).toEqual(['9. Special Zone', 'Bonus Games', 'Yoshi Heaven'])
  })
})

describe('topLevelSlots', () => {
  it('is every overworld, bonus and unassigned index, not sub areas', () => {
    const tree = fakeTree([mapNode(0x105, [mapNode(0x0c5)])], [mapNode(0x0d3)], [mapNode(0x100)])
    expect(topLevelSlots(tree)).toEqual(new Set([0x105, 0x0d3, 0x100]))
  })
})

describe('staleSlots', () => {
  it('is every grouped slot that applyGroups could not resolve to a top-level map', () => {
    const tree = fakeTree([mapNode(0x105)], [])
    const groups: MapGroup[] = [{ name: 'Yoshi', slots: [0x105, 0x199] }]
    expect(staleSlots(tree, groups)).toEqual([0x199])
  })
})

describe('admitGroups', () => {
  const topLevel = new Set([0x105])

  it('accepts a slot that currently names a top-level map', () => {
    const result = admitGroups(
      [{ name: 'A', slots: [0x105] }],
      { status: 'ok', groups: [] },
      topLevel,
    )
    expect(result).toEqual({ status: 'ok' })
  })

  it('refuses a new slot that is not currently a top-level map', () => {
    const result = admitGroups(
      [{ name: 'A', slots: [0x199] }],
      { status: 'ok', groups: [] },
      topLevel,
    )
    expect(result.status).toBe('invalid')
  })

  it('grandfathers a slot already present in the file on disk, even though it is not top-level now', () => {
    // This is the real, product-level replacement for a slot surviving a ROM
    // change: $199 was written when it was a top-level map; the ROM this
    // load resolves against no longer agrees, but an unrelated edit that
    // still lists $199 must not be blocked by it.
    const result = admitGroups(
      [{ name: 'Yoshi', slots: [0x199, 0x105] }],
      { status: 'ok', groups: [{ name: 'Yoshi', slots: [0x199] }] },
      topLevel,
    )
    expect(result).toEqual({ status: 'ok' })
  })

  it('never admits a write when the file already on disk failed to read', () => {
    const result = admitGroups(
      [{ name: 'A', slots: [0x105] }],
      { status: 'invalid', reason: 'meta/groups.json is broken' },
      topLevel,
    )
    expect(result).toEqual({ status: 'invalid', reason: 'meta/groups.json is broken' })
  })
})

describe('resolveGroups', () => {
  it('uses the file as read when it has groups', () => {
    const groups: MapGroup[] = [{ name: 'A', slots: [1] }]
    expect(resolveGroups({ status: 'ok', groups }, true)).toEqual({ action: 'use', groups })
    expect(resolveGroups({ status: 'ok', groups }, false)).toEqual({ action: 'use', groups })
  })

  it('seeds only when the file is absent AND the ROM is vanilla', () => {
    expect(resolveGroups({ status: 'ok', groups: undefined }, true)).toEqual({
      action: 'seed',
      groups: VANILLA_SEED,
    })
    expect(resolveGroups({ status: 'ok', groups: undefined }, false)).toEqual({
      action: 'use',
      groups: [],
    })
  })

  it('a bad file always reports the error, seeding or not', () => {
    const read = { status: 'invalid' as const, reason: 'broken' }
    expect(resolveGroups(read, true)).toEqual({ action: 'error', groupsError: 'broken' })
    expect(resolveGroups(read, false)).toEqual({ action: 'error', groupsError: 'broken' })
  })
})

describe('seedIfVanilla', () => {
  it('seeds when the hash is vanilla and no groups.json exists', () => {
    const result = seedIfVanilla(manifestPath, { sha256: VANILLA_SHA256, title: VANILLA_TITLE })
    expect(result).toEqual(VANILLA_SEED)
    expect(readGroups(manifestPath)).toEqual(VANILLA_SEED)
  })

  it('does not reseed a vanilla project whose groups.json is already []', () => {
    writeGroups(manifestPath, [])
    const result = seedIfVanilla(manifestPath, { sha256: VANILLA_SHA256, title: VANILLA_TITLE })
    expect(result).toEqual([])
    expect(readGroups(manifestPath)).toEqual([])
  })

  it('does not seed a non-vanilla hash, even with the stock title', () => {
    const result = seedIfVanilla(manifestPath, { sha256: 'f'.repeat(64), title: VANILLA_TITLE })
    expect(result).toEqual([])
    expect(readGroups(manifestPath)).toBeUndefined()
  })
})
