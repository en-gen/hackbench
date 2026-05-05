import * as vscode from 'vscode'
import { RomSession } from '../RomSession'
import { GFX_FILE_COUNT } from '../rom/GfxLoader'
import { loadRomPalettes } from '../rom/PaletteLoader'
import { buildTransitiveLevelMap } from '../rom/LevelTree'
import { loadOverworldAreas, OwArea } from '../rom/OverworldLoader'

// ── Shared tree item types ─────────────────────────────────────────────────────

type MapsTreeItem = RomInfoItem | LevelFolder | RoomItem | OverworldFolder | OverworldAreaItem
type ResourcesTreeItem = StatsItem | GraphItem | TileCompItem | RomMapItem | SectionFolder | RoomItem | PaletteGroupItem | GfxFileItem | PlaceholderItem

/** Collapsible header item showing ROM identity; levels nest under it. */
class RomInfoItem extends vscode.TreeItem {
  constructor(summary: { internalName: string; romSizeKb: number; isVanilla: boolean }) {
    super(summary.internalName.trim(), vscode.TreeItemCollapsibleState.Expanded)
    this.description = `${summary.romSizeKb} KB`
    this.tooltip = summary.isVanilla ? 'Vanilla SMW ROM' : 'Modified ROM'
    this.iconPath = new vscode.ThemeIcon(
      summary.isVanilla ? 'verified' : 'warning',
      summary.isVanilla ? undefined : new vscode.ThemeColor('problemsWarningIcon.foreground')
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
    super(label, collapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded)
    this.iconPath = new vscode.ThemeIcon(icon)
    this.contextValue = `smwSection_${sectionId}`
  }
}

/**
 * A named Level: the overworld-linked entrance room plus all rooms
 * transitively reachable via screen exits.  Rooms may appear in multiple
 * LevelFolders — they are references to the same underlying virtual file.
 */
class LevelFolder extends vscode.TreeItem {
  constructor(
    public readonly index: number,
    public readonly slug: string,
    /** All transitively reachable sub-rooms (not including the entrance itself). */
    public readonly subIndices: number[],
    displayName?: string,
  ) {
    const hex = index.toString(16).toUpperCase().padStart(3, '0')
    super(
      displayName ?? `$${hex}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    )
    this.description  = displayName ? `$${hex}` : undefined
    this.iconPath     = new vscode.ThemeIcon('symbol-method')
    this.contextValue = 'smwLevelFolder'
  }
}

/** A single map/room — leaf node inside a LevelFolder or a Resources section. */
class RoomItem extends vscode.TreeItem {
  constructor(
    index: number,
    slug: string,
    /** Named rooms show name + $hex description. Unnamed rooms show only $hex as label. */
    name: string | null,
    role: 'entrance' | 'sub' | 'resource',
  ) {
    const hex = index.toString(16).toUpperCase().padStart(3, '0')
    super(name ?? `$${hex}`, vscode.TreeItemCollapsibleState.None)
    this.description = name ? `$${hex}` : undefined
    this.iconPath = new vscode.ThemeIcon(
      role === 'entrance' ? 'home'
      : role === 'sub'    ? 'group-by-ref-type'
      :                     'file-code'
    )
    this.command = {
      command: 'vscode.open',
      title:   'Open Room',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/maps/${hex}.smwmap`)]
    }
    this.contextValue = `smwRoom_${role}`
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
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/palettes/${groupId}.smwpalette`)]
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
    super(`Area ${area.index} (${area.widthTiles}×${area.heightTiles})`,
          vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon('map')
    this.command = {
      command: 'vscode.open',
      title: 'Open Overworld Area',
      arguments: [vscode.Uri.parse(
        `smwrom:/${slug}/overworld/${area.index}-${area.widthTiles}x${area.heightTiles}.smwoverworld`,
      )],
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
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/info.smwinfo`)]
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
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/compare.smwtilecomp`)]
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
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/graph.smwgraph`)]
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
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/rom.smwrommap`)]
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
 * Expands to show the entrance map + all transitively reachable sub-maps.
 * Maps that are shared across levels appear under each level independently
 * but open the same virtual file.
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

  getTreeItem(element: MapsTreeItem): vscode.TreeItem { return element }

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
      const exitGraph  = rom.buildLevelExitGraph()
      const transitive = buildTransitiveLevelMap(overworld, exitGraph)

      const folders = overworld.map(index => new LevelFolder(
        index, slug,
        transitive.get(index) ?? [],
        rom.getLevelName(index) ?? undefined,
      ))
      return [new OverworldFolder(slug), ...folders]
    }

    if (element instanceof OverworldFolder) {
      return loadOverworldAreas(rom.rom).map(a => new OverworldAreaItem(slug, a))
    }

    if (element instanceof LevelFolder) {
      const entrance = new RoomItem(
        element.index, element.slug,
        rom.getLevelName(element.index),
        'entrance',
      )
      const subs = element.subIndices.map(ci =>
        new RoomItem(ci, element.slug, rom.getLevelName(ci), 'sub')
      )
      return [entrance, ...subs]
    }

    return []
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

  getTreeItem(element: ResourcesTreeItem): vscode.TreeItem { return element }

  getChildren(element?: ResourcesTreeItem): ResourcesTreeItem[] {
    if (!this.session) return []
    const { slug, rom } = this.session

    if (!element) {
      // Build the Maps section from ALL 512 pointer table entries
      const allSlots = rom.enumerateAllLevels()
      const validRooms = allSlots.filter(s => s.hasData)

      const roomItems: RoomItem[] = validRooms.map(s =>
        new RoomItem(s.index, slug, s.name, 'resource')
      )

      const roomsSection = new SectionFolder(
        `Maps  (${validRooms.length})`, 'rooms', 'file-code', roomItems, true,
      )
      const romPalettes = loadRomPalettes(rom.rom)
      const paletteItems: PaletteGroupItem[] = romPalettes.groups.map(g => {
        const variantCount = g.variants.length
        const desc = variantCount > 1 ? `${variantCount} variants` : undefined
        return new PaletteGroupItem(g.label, slug, g.id, desc)
      })
      const palettesSection = new SectionFolder(
        `Palettes  (${paletteItems.length})`, 'palettes', 'symbol-color',
        paletteItems,
        true,
      )
      const gfxSection = new SectionFolder(
        `GFX Files  (${GFX_FILE_COUNT})`, 'gfx', 'file-media',
        Array.from({ length: GFX_FILE_COUNT }, (_, i) => new GfxFileItem(i, slug)),
        true,
      )
      const asmSection = new SectionFolder(
        'ASM', 'asm', 'symbol-function',
        [new PlaceholderItem('ROM Code')],
        true,
      )
      return [new StatsItem(slug), new GraphItem(slug), new TileCompItem(slug), new RomMapItem(slug), roomsSection, palettesSection, gfxSection, asmSection]
    }

    if (element instanceof SectionFolder) return element.children
    return []
  }
}
