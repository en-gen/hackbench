/**
 * MapsProvider: the wiring between the pure row/subtree logic and VS Code's
 * TreeItem, driven through a vitest `vscode` stub (../support/vscodeStub.ts)
 * rather than an extension host.
 *
 * The subtree shapes below are already covered by LevelSubtree.test.ts and the
 * row fields by levelTreeRows.test.ts. Only four things are decided in the
 * provider itself, and they are what this file is for:
 *   - the Overworld folder sorts ahead of every Level folder;
 *   - a Level folder opens with an entrance row for its own index;
 *   - RoomItem.subNodes carries the node's children, so the `instanceof
 *     RoomItem` branch keeps descending on re-expansion;
 *   - a RoomRow becomes a TreeItem with the right command and URI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { MapsProvider } from '../../../src/providers/RomExplorerProvider'
import { RomSession } from '../../../src/RomSession'
import * as stub from '../support/vscodeStub'
import { writeSyntheticRom } from '../support/syntheticRom'

type Item = ReturnType<MapsProvider['getChildren']>[number]

/**
 * Exit graph built into the synthetic ROM. Two roots, one from each range
 * isOverworldLevel accepts: $005 is main-overworld (submap flag 0) and $110 is
 * a submap (flag 1). A screen exit carries only the destination's low byte, so
 * $110's sub-room resolves to $1C0, not $0C0 - the one dimension of the graph
 * builder a single main-overworld root cannot reach.
 *
 *   $005 -> $030 -> $032 -> $033      $032 has two parents: a diamond, which
 *        -> $031 -> $032 -> $033      expands in full under both.
 *        -> $034 -> $035 -> $034      a back edge: one loop marker, no recursion.
 *   $110 -> $1C0
 */
const ROOMS = new Map<number, number[]>([
  [0x005, [0x030, 0x031, 0x034]],
  [0x030, [0x032]],
  [0x031, [0x032]],
  [0x032, [0x033]],
  [0x033, []],
  [0x034, [0x035]],
  [0x035, [0x034]],
  [0x110, [0x1C0]],
  [0x1C0, []],
])

interface Row {
  uri: string | undefined
  command: string | undefined
  state: vscode.TreeItemCollapsibleState
  context: string | undefined
  icon: string | undefined
  description: string | undefined
}

function row(item: Item): Row {
  const target = item.command?.arguments?.[0] as vscode.Uri | undefined
  return {
    // The whole URI, not just its path: `smwrom:/slug/...` and
    // `smwrom://slug/...` differ only in authority, and the second form opens
    // nothing while leaving every `.path` comparison identical.
    uri: target?.toString(),
    command: item.command?.command,
    state: item.collapsibleState ?? vscode.TreeItemCollapsibleState.None,
    context: item.contextValue,
    icon: (item.iconPath as vscode.ThemeIcon | undefined)?.id,
    description: item.description as string | undefined,
  }
}

const mapUri = (hex: string): string => `smwrom:/synthetic/maps/${hex}.smwmap`
const urisOf = (items: Item[]): Array<string | undefined> => items.map(i => row(i).uri)

const subRow = (hex: string, collapsible: boolean): Row => ({
  uri: mapUri(hex),
  command: 'vscode.open',
  state: collapsible
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None,
  context: 'smwRoom_sub',
  icon: 'group-by-ref-type',
  description: undefined,
})

describe('MapsProvider tree wiring (synthetic ROM)', () => {
  let tmpDir: string | undefined
  let session: RomSession | undefined
  let provider: MapsProvider

  /** The Level folders under the ROM root, in the order the provider returns them. */
  const levelFolders = (): Item[] => provider.getChildren(provider.getChildren()[0]).slice(1)

  /** Expands the named root's Level folder, then each listed row in turn. */
  function descend(rootHex: string, ...hexes: string[]): Item[] {
    const folder = levelFolders().find(f => f.label === `$${rootHex}`)
    expect(folder, `no Level folder for $${rootHex}`).toBeDefined()
    let items = provider.getChildren(folder)
    for (const hex of hexes) {
      const next = items.find(i => row(i).uri === mapUri(hex))
      expect(next, `no row for $${hex} in ${JSON.stringify(urisOf(items))}`).toBeDefined()
      items = provider.getChildren(next)
    }
    return items
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackbench-tree-'))
    session = new RomSession(writeSyntheticRom(tmpDir, ROOMS))
    provider = new MapsProvider()
    provider.refresh(session)
  })

  // Guarded: if beforeAll throws, an unguarded teardown raises its own error
  // on top and buries the one that actually explains the run.
  afterAll(() => {
    session?.dispose()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs against the stub, not some other module named vscode', () => {
    // An alias that stops matching makes `vscode` unresolvable and this file
    // fails to import, which is loud. An alias pointing somewhere else is
    // silent, and every assertion below would then describe a shape nothing
    // under src/ ever constructs.
    expect(vscode.TreeItem as unknown).toBe(stub.TreeItem)
    expect(vscode.Uri as unknown).toBe(stub.Uri)
  })

  it('with no session the tree is empty rather than throwing', () => {
    expect(new MapsProvider().getChildren()).toEqual([])
  })

  it('puts the Overworld folder ahead of one Level folder per overworld root', () => {
    const roots = provider.getChildren()
    expect(roots).toHaveLength(1)
    expect(roots[0].label).toBe('HACKBENCH SYNTHETIC')
    expect(roots[0].collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded)

    const under = provider.getChildren(roots[0])
    expect(under.map(i => i.label)).toEqual(['Overworld', '$005', '$110'])
    expect(under[0].contextValue).toBe('smwOverworldFolder')
    // The folder shows a decoded level name when the ROM has one; this ROM has
    // no name table, so the hex is the label and nothing repeats it.
    expect(under[1].description).toBeUndefined()
    expect(under[1].collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed)
  })

  it('opens a Level folder with its entrance row, then its first-tier sub-rooms', () => {
    expect(descend('005').map(row)).toEqual([
      {
        uri: mapUri('005'),
        command: 'vscode.open',
        state: vscode.TreeItemCollapsibleState.None,
        context: 'smwRoom_entrance',
        icon: 'home',
        description: undefined,
      },
      subRow('030', true),
      subRow('031', true),
      subRow('034', true),
    ])
  })

  it('addresses a room by the single-slash smwrom URI the filesystem is mounted at', () => {
    const target = descend('005')[0].command?.arguments?.[0] as vscode.Uri
    // `smwrom://synthetic/...` would parse to authority 'synthetic' and path
    // '/maps/005.smwmap', which resolves to no file. Both halves are asserted
    // because either alone lets that rewrite through.
    expect({ scheme: target.scheme, authority: target.authority, path: target.path })
      .toEqual({ scheme: 'smwrom', authority: '', path: '/synthetic/maps/005.smwmap' })
  })

  it('carries a room node children into its RoomItem so re-expansion descends', () => {
    // LevelSubtree.test.ts already proves $032 expands in full under both
    // parents. The new fact here is that the provider hands those children to
    // the RoomItem, so expanding the row a second time still descends.
    for (const parent of ['030', '031']) {
      expect(descend('005', parent).map(row)).toEqual([subRow('032', true)])
      expect(descend('005', parent, '032').map(row)).toEqual([subRow('033', false)])
    }
  })

  it('stops at a loop marker instead of recursing into the back edge', () => {
    const rows = descend('005', '034', '035')
    expect(rows.map(row)).toEqual([{
      uri: mapUri('034'),
      command: 'vscode.open',
      state: vscode.TreeItemCollapsibleState.None,
      context: 'smwRoom_loop',
      icon: 'issue-reopened',
      description: '(loops back)',
    }])
    expect(rows[0].tooltip)
      .toBe('$034 is already open higher in this branch; expansion stops here.')
    // The new fact: a marker carries no subNodes, so the recursion ends here.
    expect(provider.getChildren(rows[0])).toEqual([])
  })

  it('keeps a submap root in its own $1xx range', () => {
    expect(urisOf(descend('110'))).toEqual([mapUri('110'), mapUri('1C0')])
    expect(descend('110', '1C0')).toEqual([])
  })
})
