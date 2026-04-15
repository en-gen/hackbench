import * as vscode from 'vscode'
import { RomSession } from '../RomSession'
import { GFX_FILE_COUNT } from '../rom/GfxLoader'
import { getVanillaLevelName } from '../rom/SmwLevelNames'

// ── Tree item types ───────────────────────────────────────────────────────────

type TreeItem = RomInfoItem | SectionFolder | LevelFolder | LevelItem | RoomItem | PaletteItem | GfxFileItem | PlaceholderItem

/** Non-interactive header item showing ROM identity. */
class RomInfoItem extends vscode.TreeItem {
  constructor(summary: { internalName: string; romSizeKb: number; isVanilla: boolean }) {
    super(summary.internalName.trim(), vscode.TreeItemCollapsibleState.None)
    this.description = `${summary.romSizeKb} KB`
    this.tooltip = summary.isVanilla ? 'Vanilla SMW ROM' : 'Modified ROM'
    this.iconPath = new vscode.ThemeIcon(
      summary.isVanilla ? 'verified' : 'warning',
      summary.isVanilla ? undefined : new vscode.ThemeColor('problemsWarningIcon.foreground')
    )
    this.contextValue = 'smwRomInfo'
  }
}

/** Top-level section folder (Levels, Objects, Sprites, ASM, Music). */
class SectionFolder extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sectionId: string,
    icon: string,
    public readonly children: TreeItem[],
    collapsed = false,
  ) {
    super(label, collapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded)
    this.iconPath = new vscode.ThemeIcon(icon)
    this.contextValue = `smwSection_${sectionId}`
  }
}

type LevelGroup = 'overworld' | 'sub-area'

class LevelItem extends vscode.TreeItem {
  constructor(
    public readonly index: number,
    slug: string,
    displayName?: string,
    group: LevelGroup = 'overworld',
  ) {
    const hex = index.toString(16).toUpperCase().padStart(3, '0')
    super(displayName ?? `$${hex}`, vscode.TreeItemCollapsibleState.None)
    this.description = displayName ? `$${hex}` : undefined

    this.iconPath = new vscode.ThemeIcon(group === 'sub-area' ? 'symbol-namespace' : 'symbol-field')
    this.command = {
      command: 'vscode.open',
      title: 'Open Level',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/levels/${hex}.smwlevel`)]
    }
    this.contextValue = `smwLevel_${group}`
  }
}

/**
 * Collapsible folder for a named level.  Expands to show the entrance room
 * plus any sub-rooms reached via screen-exit objects.
 */
class LevelFolder extends vscode.TreeItem {
  readonly childIndices: number[]

  constructor(
    public readonly index: number,
    public readonly slug: string,
    displayName?: string,
    childIndices: number[] = [],
    group: LevelGroup = 'overworld',
  ) {
    const hex = index.toString(16).toUpperCase().padStart(3, '0')
    super(
      displayName ?? `$${hex}`,
      childIndices.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Collapsed,  // always collapsible (has entrance)
    )
    this.description    = displayName ? `$${hex}` : undefined
    this.iconPath       = new vscode.ThemeIcon(group === 'sub-area' ? 'symbol-namespace' : 'symbol-field')
    this.contextValue   = `smwLevelFolder_${group}`
    this.childIndices   = childIndices
  }
}

/** Leaf node representing a single room/area inside a level folder. */
class RoomItem extends vscode.TreeItem {
  constructor(
    index: number,
    slug: string,
    label: string,
    role: 'entrance' | 'sub',
  ) {
    const hex = index.toString(16).toUpperCase().padStart(3, '0')
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description  = `$${hex}`
    this.iconPath     = new vscode.ThemeIcon(role === 'entrance' ? 'home' : 'symbol-namespace')
    this.command      = {
      command: 'vscode.open',
      title:   'Open Room',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/levels/${hex}.smwlevel`)]
    }
    this.contextValue = `smwRoom_${role}`
  }
}

class PaletteItem extends vscode.TreeItem {
  constructor(slug: string) {
    super('Color Palettes', vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('symbol-color')
    this.command = {
      command: 'vscode.open',
      title: 'Open Palettes',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/palettes/global.smwpalette`)]
    }
    this.contextValue = 'smwPalette'
  }
}

class GfxFileItem extends vscode.TreeItem {
  constructor(index: number, slug: string) {
    const hex = index.toString(16).toUpperCase().padStart(2, '0')
    super(`GFX ${hex}`, vscode.TreeItemCollapsibleState.None)
    this.description = `File ${index}`
    this.iconPath = new vscode.ThemeIcon('file-media')
    this.command = {
      command: 'vscode.open',
      title: 'Open GFX File',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/gfx/GFX${hex}.smwgfx`)]
    }
    this.contextValue = 'smwGfxFile'
  }
}

/** Stub item for sections not yet implemented. */
class PlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('ellipsis')
    this.description = 'coming soon'
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class RomExplorerProvider implements vscode.TreeDataProvider<TreeItem> {
  private session: RomSession | undefined

  private _emitter = new vscode.EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._emitter.event

  refresh(session: RomSession | undefined): void {
    this.session = session
    this._emitter.fire()
  }

  getTreeItem(element: TreeItem): vscode.TreeItem { return element }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!this.session) return []
    const { slug } = this.session

    // Root — return info item + section folders
    if (!element) {
      return this._buildRoot(slug)
    }

    if (element instanceof SectionFolder) return element.children
    if (element instanceof LevelFolder) {
      const entrance = new RoomItem(element.index, element.slug, 'Entrance', 'entrance')
      const subRooms = element.childIndices.map((ci) => {
        const hex  = ci.toString(16).toUpperCase().padStart(3, '0')
        const name = getVanillaLevelName(ci) ?? `$${hex}`
        return new RoomItem(ci, element.slug, name, 'sub')
      })
      return [entrance, ...subRooms]
    }
    return []
  }

  private _buildRoot(slug: string): TreeItem[] {
    const rom = this.session!.rom

    // ── Build exit graph and classify levels ─────────────────────────────────
    const exitGraph = rom.buildLevelExitGraph()

    // BFS from all valid levels to find what's transitively claimed as a child
    const { overworld: overworldIndices, subarea: subareaIndices } = rom.classifyLevels()

    // BFS: find all levels transitively reachable from any overworld level via exits
    const claimed = new Set<number>()
    const queue = [...overworldIndices]
    const visitedBfs = new Set<number>(queue)
    while (queue.length > 0) {
      const lvl = queue.shift()!
      const children = exitGraph.get(lvl) ?? []
      for (const child of children) {
        if (!visitedBfs.has(child)) {
          visitedBfs.add(child)
          claimed.add(child)
          queue.push(child)
        }
      }
    }

    const overworldItems = overworldIndices.map(index =>
      new LevelFolder(
        index, slug,
        getVanillaLevelName(index),
        exitGraph.get(index) ?? [],
        'overworld',
      )
    )

    // Sub-areas folder: only levels NOT claimed as children of any overworld level
    const subareaItems = subareaIndices
      .filter(index => !claimed.has(index))
      .map(index => new LevelItem(index, slug, getVanillaLevelName(index), 'sub-area'))

    const levelsFolder = new SectionFolder(
      `Levels  (${overworldItems.length})`,
      'levels', 'symbol-field', overworldItems,
      false,  // expanded by default
    )

    const subareasFolder = new SectionFolder(
      `Sub-areas  (${subareaItems.length})`,
      'subareas', 'symbol-namespace', subareaItems,
      true,   // collapsed by default
    )

    // ── Palettes ──────────────────────────────────────────────────────────────
    const palettesFolder = new SectionFolder(
      'Palettes', 'palettes', 'symbol-color',
      [new PaletteItem(slug)],
      false,
    )

    // ── GFX Files ─────────────────────────────────────────────────────────────
    const gfxItems = Array.from({ length: GFX_FILE_COUNT }, (_, i) => new GfxFileItem(i, slug))
    const gfxFolder = new SectionFolder(
      `GFX Files  (${GFX_FILE_COUNT})`, 'gfx', 'file-media', gfxItems,
      true,
    )

    // ── ASM ───────────────────────────────────────────────────────────────────
    const asmFolder = new SectionFolder(
      'ASM', 'asm', 'symbol-function',
      [new PlaceholderItem('ROM Code')],
      true,
    )

    // ── Music ─────────────────────────────────────────────────────────────────
    const musicFolder = new SectionFolder(
      'Music', 'music', 'music',
      [new PlaceholderItem('SPC tracks')],
      true,
    )

    const infoItem = new RomInfoItem(this.session!.summary)
    return [infoItem, levelsFolder, subareasFolder, palettesFolder, gfxFolder, asmFolder, musicFolder]
  }
}
