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
import { OverworldViewerProvider } from './providers/OverworldViewerProvider'
import { SmwFileSystemProvider } from './providers/SmwFileSystemProvider'
import { EmulatorPreviewProvider } from './providers/EmulatorPreviewProvider'
import { romPathFromCommandArg } from './romPathFromCommandArg'
import { staleRomTabs } from './romTabs'

let session: RomSession | undefined

export function activate(context: vscode.ExtensionContext): void {
  // VS Code restored any smwrom:// tabs that were open when it last closed,
  // but not the ROM session behind them, and it offers no way to opt an
  // editor out of that. Close them before the custom editor providers are
  // registered, so nothing tries to resolve a descriptor from a filesystem
  // that is not mounted. Fire and forget: activation must not wait on it,
  // and a failure here is not worth blocking the extension over.
  void closeRestoredRomTabs()

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
  const overworldViewerProvider = new OverworldViewerProvider(context)

  // Register the virtual filesystem for smwrom:// URIs
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('smwrom', fsProvider, {
      isCaseSensitive: false,
      isReadonly: false,
    }),
  )

  // retainContextWhenHidden:false - each map webview copies VRAM frames +
  // animation frames + an AudioContext (postMessage is a structured clone,
  // not a reference). Keeping 100 hidden tabs alive would pile up hundreds
  // of MB. With the ROM buffer shared via RomSession.resolveRom(), rebuild
  // on re-show is all in-memory compute, no disk I/O.
  const registerEditor = (
    viewType: string,
    provider: vscode.CustomReadonlyEditorProvider,
  ): void => {
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(viewType, provider, {
        webviewOptions: { retainContextWhenHidden: false },
      }),
    )
  }

  registerEditor('hackbench.mapEditor', mapEditorProvider)
  registerEditor('hackbench.paletteEditor', paletteEditorProvider)
  registerEditor('hackbench.gfxViewer', gfxViewerProvider)

  // Register the two explorer tree views. `createTreeView` (rather than
  // `registerTreeDataProvider`) is used so `showCollapseAll` renders the
  // native collapse-all button in the view title bar.
  context.subscriptions.push(
    vscode.window.createTreeView('hackbench.mapsExplorer', {
      treeDataProvider: mapsProvider,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView('hackbench.resourcesExplorer', {
      treeDataProvider: resourcesProvider,
      showCollapseAll: true,
    }),
  )

  registerEditor('hackbench.musicPlayer', musicPlayerProvider)
  registerEditor('hackbench.romStats', romStatsProvider)
  registerEditor('hackbench.levelGraph', levelGraphProvider)
  registerEditor('hackbench.tilesetCompare', tilesetCompareProvider)
  registerEditor('hackbench.romMap', romMapProvider)
  registerEditor('hackbench.overworldViewer', overworldViewerProvider)

  // Commands
  context.subscriptions.push(
    // The Explorer context menu invokes this with the URI that was
    // right-clicked; the palette and the welcome-view link invoke it bare.
    vscode.commands.registerCommand('hackbench.openRom', (arg?: unknown) =>
      openRomCommand(
        context,
        fsProvider,
        mapsProvider,
        resourcesProvider,
        romPathFromCommandArg(arg),
      ),
    ),
    vscode.commands.registerCommand('hackbench.closeRom', () =>
      closeRomCommand(context, fsProvider, mapsProvider, resourcesProvider),
    ),
    // Spike (libretro-view-engine): runs the libretro core inside the
    // extension's own webview. See src/providers/EmulatorPreviewProvider.ts.
    vscode.commands.registerCommand('hackbench.openEmulatorPreview', (levelId?: number) =>
      new EmulatorPreviewProvider(context).open(levelId),
    ),
  )
}

export function deactivate(): void {
  session?.dispose()
}

async function closeRestoredRomTabs(): Promise<void> {
  const stale = staleRomTabs(vscode.window.tabGroups.all)
  if (stale.length === 0) return
  try {
    await vscode.window.tabGroups.close(stale, /* preserveFocus */ true)
  } catch (err) {
    console.warn('[hackbench] could not close restored ROM tabs:', err)
  }
}

// ── ROM commands ─────────────────────────────────────────────────────────────

async function openRomCommand(
  context: vscode.ExtensionContext,
  fsProvider: SmwFileSystemProvider,
  mapsProvider: MapsProvider,
  resourcesProvider: ResourcesProvider,
  knownRomPath?: string,
): Promise<void> {
  let romPath = knownRomPath
  if (!romPath) {
    const uris = await vscode.window.showOpenDialog({
      title: 'Open Super Mario World ROM',
      filters: { 'SNES ROM': ['sfc', 'smc', 'rom'] },
      canSelectMany: false,
    })
    if (!uris?.length) return
    romPath = uris[0].fsPath
  }

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
          5000,
        )
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open ROM: ${(err as Error).message}`)
      }
    },
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
