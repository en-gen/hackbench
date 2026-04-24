import * as vscode from 'vscode'
import { RomSession } from './RomSession'
import { MapsProvider, ResourcesProvider } from './providers/RomExplorerProvider'
import { MapEditorProvider } from './providers/MapEditorProvider'
import { PaletteEditorProvider } from './providers/PaletteEditorProvider'
import { GfxViewerProvider } from './providers/GfxViewerProvider'
import { MusicPlayerProvider } from './providers/MusicPlayerProvider'
import { RomStatsProvider } from './providers/RomStatsProvider'
import { LevelGraphProvider } from './providers/LevelGraphProvider'
import { TilesetCompareProvider } from './providers/TilesetCompareProvider'
import { RomMapProvider } from './providers/RomMapProvider'
import { SmwFileSystemProvider } from './providers/SmwFileSystemProvider'

let session: RomSession | undefined

export function activate(context: vscode.ExtensionContext): void {
  const fsProvider = new SmwFileSystemProvider()
  const mapsProvider = new MapsProvider()
  const resourcesProvider = new ResourcesProvider()
  const mapEditorProvider = new MapEditorProvider(context)
  const paletteEditorProvider = new PaletteEditorProvider(context)
  const gfxViewerProvider = new GfxViewerProvider(context)
  const musicPlayerProvider = new MusicPlayerProvider(context)
  const romStatsProvider = new RomStatsProvider()
  const levelGraphProvider = new LevelGraphProvider(context)
  const tilesetCompareProvider = new TilesetCompareProvider(context)
  const romMapProvider = new RomMapProvider(context)

  // Register the virtual filesystem for smwrom:// URIs
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('smwrom', fsProvider, {
      isCaseSensitive: false,
      isReadonly: false,
    })
  )

  // Register the map custom editor.
  // retainContextWhenHidden:false — each map webview copies VRAM frames +
  // animation frames + an AudioContext (postMessage is a structured clone,
  // not a reference). Keeping 100 hidden tabs alive would pile up hundreds
  // of MB. With the ROM buffer shared via RomSession.resolveRom(), rebuild
  // on re-show is all in-memory compute, no disk I/O.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.mapEditor',
      mapEditorProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the palette editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.paletteEditor',
      paletteEditorProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the GFX tile sheet viewer
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.gfxViewer',
      gfxViewerProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the two explorer tree views. `createTreeView` (rather than
  // `registerTreeDataProvider`) is used so `showCollapseAll` renders the
  // native collapse-all button in the view title bar.
  context.subscriptions.push(
    vscode.window.createTreeView('hackbench.mapsExplorer',      { treeDataProvider: mapsProvider,      showCollapseAll: true }),
    vscode.window.createTreeView('hackbench.resourcesExplorer', { treeDataProvider: resourcesProvider, showCollapseAll: true }),
  )

  // Register the music player custom editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.musicPlayer',
      musicPlayerProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the ROM stats dashboard
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.romStats',
      romStatsProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the level interconnection graph
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.levelGraph',
      levelGraphProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the tileset comparison view
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.tilesetCompare',
      tilesetCompareProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Register the ROM memory-map viewer
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'hackbench.romMap',
      romMapProvider,
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  )

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hackbench.openRom', () =>
      openRomCommand(context, fsProvider, mapsProvider, resourcesProvider)
    ),
    vscode.commands.registerCommand('hackbench.closeRom', () =>
      closeRomCommand(context, fsProvider, mapsProvider, resourcesProvider)
    )
  )
}

export function deactivate(): void {
  session?.dispose()
}

// ── ROM commands ─────────────────────────────────────────────────────────────

async function openRomCommand(
  context: vscode.ExtensionContext,
  fsProvider: SmwFileSystemProvider,
  mapsProvider: MapsProvider,
  resourcesProvider: ResourcesProvider,
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    title: 'Open Super Mario World ROM',
    filters: { 'SNES ROM': ['sfc', 'smc', 'rom'] },
    canSelectMany: false,
  })
  if (!uris?.length) return

  const romPath = uris[0].fsPath

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading ROM…' },
    async () => {
      try {
        session?.dispose()
        session = new RomSession(romPath)

        fsProvider.mount(session)
        mapsProvider.refresh(session)
        resourcesProvider.refresh(session)
        await vscode.commands.executeCommand('setContext', 'hackbench.romLoaded', true)

        // Open the virtual folder in the explorer
        const rootUri = vscode.Uri.parse(`smwrom:/${session.slug}/`)
        await vscode.commands.executeCommand('revealInExplorer', rootUri)

        vscode.window.setStatusBarMessage(
          `HackBench: ${session.summary.internalName.trim()} (${session.summary.romSizeKb} KB)`,
          5000
        )
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open ROM: ${(err as Error).message}`)
      }
    }
  )
}

async function closeRomCommand(
  _context: vscode.ExtensionContext,
  fsProvider: SmwFileSystemProvider,
  mapsProvider: MapsProvider,
  resourcesProvider: ResourcesProvider,
): Promise<void> {
  if (!session) return
  fsProvider.unmount(session.slug)
  mapsProvider.refresh(undefined)
  resourcesProvider.refresh(undefined)
  session.dispose()
  session = undefined
  await vscode.commands.executeCommand('setContext', 'hackbench.romLoaded', false)
}

