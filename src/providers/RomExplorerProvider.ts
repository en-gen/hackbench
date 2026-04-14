import * as vscode from 'vscode'
import { RomSession } from '../RomSession'
import { GFX_FILE_COUNT } from '../rom/GfxLoader'
import { isOverworldLevel } from '../rom/SmwRom'

// ── Tree item types ───────────────────────────────────────────────────────────

type TreeItem = RomInfoItem | SectionFolder | LevelItem | PaletteItem | GfxFileItem | PlaceholderItem

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

class LevelItem extends vscode.TreeItem {
  constructor(
    public readonly index: number,
    slug: string,
  ) {
    const hex = index.toString(16).toUpperCase().padStart(3, '0')
    super(`Level $${hex}`, vscode.TreeItemCollapsibleState.None)
    this.description = hex
    this.iconPath = new vscode.ThemeIcon('symbol-field')
    this.command = {
      command: 'vscode.open',
      title: 'Open Level',
      arguments: [vscode.Uri.parse(`smwrom:/${slug}/levels/${hex}.smwlevel`)]
    }
    this.contextValue = 'smwLevel'
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
    return []
  }

  private _buildRoot(slug: string): TreeItem[] {
    const rom = this.session!.rom

    // ── Levels ────────────────────────────────────────────────────────────────
    // SMW overworld-accessible levels live in two pointer table ranges:
    //   $000–$024  Main overworld (translevel $00–$24)
    //   $101–$13B  Submaps        (translevel $25–$5F, mapped via +$DC)
    // Slots $025–$0FF and $13C–$1FF are secondary exits (doors, pipes,
    // subareas) and are NOT directly accessible from the overworld.
    // See docs/smw-overworld-levels.md for derivation.
    // Deduplicate by L1 pointer address: some overworld exit tiles (normal +
    // secret) lead to the same room. We keep the first occurrence (lowest
    // room index) so each unique level appears exactly once.
    const seenPointers = new Set<number>()
    const levelItems = rom.getAllLevelPointers()
      .filter(p => isOverworldLevel(p.index))
      .filter(p => {
        if (p.address === null) return false
        if (seenPointers.has(p.address)) return false
        const data = rom.getLevelRawData(p.index)
        if (!data || data.length <= 5) return false
        const levelMode = data[1] & 0x1F
        if (levelMode > 20) return false
        seenPointers.add(p.address)
        return true
      })
      .map(p => new LevelItem(p.index, slug))
    const levelsFolder = new SectionFolder(
      `Levels  (${levelItems.length})`, 'levels', 'symbol-field', levelItems,
      false,  // expanded
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
    return [infoItem, levelsFolder, palettesFolder, gfxFolder, asmFolder, musicFolder]
  }
}
