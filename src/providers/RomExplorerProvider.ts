import * as vscode from 'vscode'
import { RomSession } from '../RomSession'
import { GFX_FILE_COUNT } from '../rom/GfxLoader'
import { loadRomPalettes } from '../rom/PaletteLoader'
import { buildLevelSubtree, LevelTreeNode } from '../rom/LevelTree'
import { roomRow, roomRowForNode, RoomRow } from './levelTreeRows'
import { loadOverworldAreas, OwArea } from '../rom/OverworldLoader'
import { hex2, hex3 } from '../rom/hex'

// ── Shared tree item types ─────────────────────────────────────────────────────

type MapsTreeItem = RomInfoItem | LevelFolder | RoomItem | OverworldFolder | OverworldAreaItem
type ResourcesTreeItem =
  | StatsItem
  | GraphItem
  | TileCompItem
  | RomMapItem
  | SectionFolder
  | RoomItem
  | PaletteGroupItem
  | GfxFileItem
  | PlaceholderItem

/** Collapsible header item showing ROM identity; levels nest under it. */
class RomInfoItem extends vscode.TreeItem {
  constructor(summary: { internalName: string; romSizeKb: number; isVanilla: boolean }) {
    super(summary.internalName.trim(), vscode.TreeItemCollapsibleState.Expanded)
    this.description = `${summary.romSizeKb} KB`
    this.tooltip = summary.isVanilla ? 'Vanilla SMW ROM' : 'Modified ROM'
    this.iconPath = new vscode.ThemeIcon(
      summary.isVanilla ? 'verified' : 'warning',
      summary.isVanilla ? undefined : new vscode.ThemeColor('problemsWarningIcon.foreground'),
    )
    this.contextValue = 'smwRomInfo'
  }
}

/** Top-level section folder. */
class SectionFolder extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sectionId: string,
    icon: string,
    public readonly children: ResourcesTreeItem[],
    collapsed = true,
  ) {
    super(
      label,
      collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    )
    this.iconPath = new vscode.ThemeIcon(icon)
    this.contextValue = `smwSection_${sectionId}`
  }
}

/**
 * A named Level: the overworld-linked entrance room plus the rooms reachable
 * from it via screen exits, nested the way they are entered.  A room reachable
 * by two routes is rendered under both; each row is a reference to the same
 * underlying virtual file.
 */
class LevelFolder extends vscode.TreeItem {
  constructor(
    public readonly index: number,
    public readonly slug: string,
    /** The entrance room's expansion; its `children` are the first-tier sub-rooms. */
    public readonly subtree: LevelTreeNode,
    displayName?: string,
  ) {
    const hex = hex3(index)
    // The folder IS the entrance room, so it opens on click rather than making
    // the user expand it and click a duplicate row. VS Code fires `command` on
    // select and toggles expansion independently, so one click does both.
    super(
      displayName ?? `$${hex}`,
      subtree.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    )
    this.description = displayName ? `$${hex}` : undefined
    this.iconPath = new vscode.ThemeIcon('symbol-method')
    this.contextValue = 'smwLevelFolder'
    this.command = {
      command: 'vscode.open',
      title: 'Open Map',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/maps/${hex}.smwmap`)],
    }
  }
}

/** A single map/room inside a LevelFolder or a Resources section. */
class RoomItem extends vscode.TreeItem {
  constructor(
    row: RoomRow,
    public readonly slug: string,
    /** Sub-rooms entered from this one. Empty for leaves, markers and Resources rows. */
    public readonly subNodes: LevelTreeNode[] = [],
  ) {
    super(
      row.label,
      row.collapsible
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    )
    this.description = row.description
    this.tooltip = row.tooltip
    this.iconPath = new vscode.ThemeIcon(row.icon)
    this.contextValue = row.contextValue
    this.command = {
      command: 'vscode.open',
      title: 'Open Room',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/${row.resourcePath}`)],
    }
  }
}

/** A single palette group (e.g. "Layer 2 Background") that opens its own palette view. */
class PaletteGroupItem extends vscode.TreeItem {
  constructor(label: string, slug: string, groupId: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('symbol-color')
    this.description = description
    this.command = {
      command: 'vscode.open',
      title: 'Open Palette Group',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/palettes/${groupId}.smwpalette`)],
    }
    this.contextValue = 'smwPalette'
  }
}

class GfxFileItem extends vscode.TreeItem {
  constructor(index: number, slug: string) {
    const hex = hex2(index)
    super(`GFX ${hex}`, vscode.TreeItemCollapsibleState.None)
    this.description = `File ${index}`
    this.iconPath = new vscode.ThemeIcon('file-media')
    this.command = {
      command: 'vscode.open',
      title: 'Open GFX File',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/gfx/GFX${hex}.smwgfx`)],
    }
    this.contextValue = 'smwGfxFile'
  }
}

/** Top-level Overworld folder under the ROM-info root in the Maps tree.
 *  Always placed first, before per-level entries. */
class OverworldFolder extends vscode.TreeItem {
  constructor(public readonly slug: string) {
    super('Overworld', vscode.TreeItemCollapsibleState.Collapsed)
    this.iconPath = new vscode.ThemeIcon('globe')
    this.contextValue = 'smwOverworldFolder'
  }
}

/** A single overworld area entry, generically named (no submap names). */
class OverworldAreaItem extends vscode.TreeItem {
  constructor(slug: string, area: OwArea) {
    super(
      `Area ${area.index} (${area.widthTiles}×${area.heightTiles})`,
      vscode.TreeItemCollapsibleState.None,
    )
    this.iconPath = new vscode.ThemeIcon('map')
    this.command = {
      command: 'vscode.open',
      title: 'Open Overworld Area',
      arguments: [
        vscode.Uri.parse(
          `smwrom:/${slug}/overworld/${area.index}-${area.widthTiles}x${area.heightTiles}.smwoverworld`,
        ),
      ],
    }
    this.contextValue = 'smwOverworldArea'
  }
}

/** ROM statistics dashboard opener. */
class StatsItem extends vscode.TreeItem {
  constructor(slug: string) {
    super('ROM Info', vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('info')
    this.command = {
      command: 'vscode.open',
      title: 'ROM Statistics',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/info.smwinfo`)],
    }
    this.contextValue = 'smwRomStats'
  }
}

/** Tileset comparison view opener. */
class TileCompItem extends vscode.TreeItem {
  constructor(slug: string) {
    super('Tileset Compare', vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('diff')
    this.command = {
      command: 'vscode.open',
      title: 'Open Tileset Comparison',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/compare.smwtilecomp`)],
    }
    this.contextValue = 'smwTileComp'
  }
}

/** Level interconnection graph opener. */
class GraphItem extends vscode.TreeItem {
  constructor(slug: string) {
    super('Level Graph', vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('type-hierarchy')
    this.command = {
      command: 'vscode.open',
      title: 'Open Level Graph',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/graph.smwgraph`)],
    }
    this.contextValue = 'smwLevelGraph'
  }
}

/** ROM memory-map viewer opener. */
class RomMapItem extends vscode.TreeItem {
  constructor(slug: string) {
    super('ROM Map', vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('map')
    this.command = {
      command: 'vscode.open',
      title: 'Open ROM Map',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/rom.smwrommap`)],
    }
    this.contextValue = 'smwRomMap'
  }
}

class PlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('ellipsis')
    this.description = 'coming soon'
  }
}

// ── Levels provider ────────────────────────────────────────────────────────────

/**
 * Top tree view: one LevelFolder per overworld-accessible room.
 * Expands to show the entrance map plus the sub-maps reachable from it, nested
 * under whichever room leads into them.  A sub-map reachable by more than one
 * route appears on every route; a route that loops back onto itself ends in a
 * non-expandable loop marker.  Every row opens the same virtual file.
 *
 * Level names are decoded from ROM data (no hardcoded lookup table).
 */
export class MapsProvider implements vscode.TreeDataProvider<MapsTreeItem> {
  private session: RomSession | undefined
  private _emitter = new vscode.EventEmitter<MapsTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._emitter.event

  refresh(session: RomSession | undefined): void {
    this.session = session
    this._emitter.fire()
  }

  getTreeItem(element: MapsTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: MapsTreeItem): MapsTreeItem[] {
    if (!this.session) return []
    const { slug, rom } = this.session

    if (!element) {
      // Root: ROM info (levels nest under it)
      return [new RomInfoItem(this.session.summary)]
    }

    if (element instanceof RomInfoItem) {
      // Under ROM: Overworld folder first, then one LevelFolder per overworld level.
      const { overworld } = rom.classifyLevels()
      const exitGraph = rom.buildLevelExitGraph()

      const folders = overworld.map(
        index =>
          new LevelFolder(
            index,
            slug,
            buildLevelSubtree(index, exitGraph),
            rom.getLevelName(index) ?? undefined,
          ),
      )
      return [new OverworldFolder(slug), ...folders]
    }

    if (element instanceof OverworldFolder) {
      return loadOverworldAreas(rom.rom).map(a => new OverworldAreaItem(slug, a))
    }

    if (element instanceof LevelFolder) {
      // No entrance row: the folder opens the entrance itself, so a duplicate
      // child would just be a second way to click the same map.
      return this.roomsFor(element.subtree.children, element.slug)
    }

    if (element instanceof RoomItem) {
      return this.roomsFor(element.subNodes, element.slug)
    }

    return []
  }

  private roomsFor(nodes: LevelTreeNode[], slug: string): RoomItem[] {
    const rom = this.session!.rom
    return nodes.map(
      n => new RoomItem(roomRowForNode(n, rom.getLevelName(n.index)), slug, n.children),
    )
  }
}

// ── Resources provider ─────────────────────────────────────────────────────────

/**
 * Bottom tree view: every room in the ROM, palettes, GFX files, etc.
 * The Maps section shows all 512 pointer table entries with valid data.
 * Overworld rooms display their ROM-decoded name; others show only $XXX.
 */
export class ResourcesProvider implements vscode.TreeDataProvider<ResourcesTreeItem> {
  private session: RomSession | undefined
  private _emitter = new vscode.EventEmitter<ResourcesTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._emitter.event

  refresh(session: RomSession | undefined): void {
    this.session = session
    this._emitter.fire()
  }

  getTreeItem(element: ResourcesTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: ResourcesTreeItem): ResourcesTreeItem[] {
    if (!this.session) return []
    const { slug, rom } = this.session

    if (!element) {
      // Build the Maps section from ALL 512 pointer table entries
      const allSlots = rom.enumerateAllLevels()
      const validRooms = allSlots.filter(s => s.hasData)

      const roomItems: RoomItem[] = validRooms.map(
        s => new RoomItem(roomRow(s.index, s.name, 'resource', 0), slug),
      )

      const roomsSection = new SectionFolder(
        `Maps  (${validRooms.length})`,
        'rooms',
        'file-code',
        roomItems,
        true,
      )
      const romPalettes = loadRomPalettes(rom.rom)
      const paletteItems: PaletteGroupItem[] = romPalettes.groups.map(g => {
        const variantCount = g.variants.length
        const desc = variantCount > 1 ? `${variantCount} variants` : undefined
        return new PaletteGroupItem(g.label, slug, g.id, desc)
      })
      const palettesSection = new SectionFolder(
        `Palettes  (${paletteItems.length})`,
        'palettes',
        'symbol-color',
        paletteItems,
        true,
      )
      const gfxSection = new SectionFolder(
        `GFX Files  (${GFX_FILE_COUNT})`,
        'gfx',
        'file-media',
        Array.from({ length: GFX_FILE_COUNT }, (_, i) => new GfxFileItem(i, slug)),
        true,
      )
      const asmSection = new SectionFolder(
        'ASM',
        'asm',
        'symbol-function',
        [new PlaceholderItem('ROM Code')],
        true,
      )
      return [
        new StatsItem(slug),
        new GraphItem(slug),
        new TileCompItem(slug),
        new RomMapItem(slug),
        roomsSection,
        palettesSection,
        gfxSection,
        asmSection,
      ]
    }

    if (element instanceof SectionFolder) return element.children
    return []
  }
}
