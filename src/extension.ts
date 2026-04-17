import * as vscode from 'vscode'
import { RomSession } from './RomSession'
import { MapsProvider, ResourcesProvider } from './providers/RomExplorerProvider'
import { MapEditorProvider } from './providers/MapEditorProvider'
import { PaletteEditorProvider } from './providers/PaletteEditorProvider'
import { GfxViewerProvider } from './providers/GfxViewerProvider'
import { MusicPlayerProvider } from './providers/MusicPlayerProvider'
import { SmwFileSystemProvider } from './providers/SmwFileSystemProvider'

let session: RomSession | undefined

export function activate(context: vscode.ExtensionContext): void {
  const fsProvider = new SmwFileSystemProvider()
  const mapsProvider      = new MapsProvider()
  const resourcesProvider = new ResourcesProvider()
  const mapEditorProvider = new MapEditorProvider(context)
  const paletteEditorProvider = new PaletteEditorProvider(context)
  const gfxViewerProvider = new GfxViewerProvider(context)
  const musicPlayerProvider = new MusicPlayerProvider(context)

  // Register the virtual filesystem for smwrom:// URIs
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('smwrom', fsProvider, {
      isCaseSensitive: false,
      isReadonly: false,
    })
  )

  // Register the map custom editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'smwEditor.mapEditor',
      mapEditorProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  // Register the palette editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'smwEditor.paletteEditor',
      paletteEditorProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  // Register the GFX tile sheet viewer
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'smwEditor.gfxViewer',
      gfxViewerProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  // Register the two explorer tree views
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('smwEditor.mapsExplorer',      mapsProvider),
    vscode.window.registerTreeDataProvider('smwEditor.resourcesExplorer', resourcesProvider),
  )

  // Register the music player custom editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'smwEditor.musicPlayer',
      musicPlayerProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('smwEditor.openRom', () =>
      openRomCommand(context, fsProvider, mapsProvider, resourcesProvider)
    ),
    vscode.commands.registerCommand('smwEditor.closeRom', () =>
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
        await vscode.commands.executeCommand('setContext', 'smwEditor.romLoaded', true)

        // Open the virtual folder in the explorer
        const rootUri = vscode.Uri.parse(`smwrom:/${session.slug}/`)
        await vscode.commands.executeCommand('revealInExplorer', rootUri)

        vscode.window.setStatusBarMessage(
          `SMW Editor: ${session.summary.internalName.trim()} (${session.summary.romSizeKb} KB)`,
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
  await vscode.commands.executeCommand('setContext', 'smwEditor.romLoaded', false)
}
