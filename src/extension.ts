import * as vscode from 'vscode'
import { RomSession } from './RomSession'
import { LevelsProvider, ResourcesProvider } from './providers/RomExplorerProvider'
import { LevelEditorProvider } from './providers/LevelEditorProvider'
import { PaletteEditorProvider } from './providers/PaletteEditorProvider'
import { GfxViewerProvider } from './providers/GfxViewerProvider'
import { SmwFileSystemProvider } from './providers/SmwFileSystemProvider'

let session: RomSession | undefined

export function activate(context: vscode.ExtensionContext): void {
  const fsProvider = new SmwFileSystemProvider()
  const levelsProvider    = new LevelsProvider()
  const resourcesProvider = new ResourcesProvider()
  const levelEditorProvider = new LevelEditorProvider(context)
  const paletteEditorProvider = new PaletteEditorProvider(context)
  const gfxViewerProvider = new GfxViewerProvider(context)

  // Register the virtual filesystem for smwrom:// URIs
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('smwrom', fsProvider, {
      isCaseSensitive: false,
      isReadonly: false,
    })
  )

  // Register the level custom editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'smwEditor.levelEditor',
      levelEditorProvider,
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
    vscode.window.registerTreeDataProvider('smwEditor.levelsExplorer',    levelsProvider),
    vscode.window.registerTreeDataProvider('smwEditor.resourcesExplorer', resourcesProvider),
  )

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('smwEditor.openRom', () =>
      openRomCommand(context, fsProvider, levelsProvider, resourcesProvider)
    ),
    vscode.commands.registerCommand('smwEditor.closeRom', () =>
      closeRomCommand(context, fsProvider, levelsProvider, resourcesProvider)
    )
  )
}

export function deactivate(): void {
  session?.dispose()
}

async function openRomCommand(
  context: vscode.ExtensionContext,
  fsProvider: SmwFileSystemProvider,
  levelsProvider: LevelsProvider,
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
        levelsProvider.refresh(session)
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
  levelsProvider: LevelsProvider,
  resourcesProvider: ResourcesProvider,
): Promise<void> {
  if (!session) return
  fsProvider.unmount(session.slug)
  levelsProvider.refresh(undefined)
  resourcesProvider.refresh(undefined)
  session.dispose()
  session = undefined
  await vscode.commands.executeCommand('setContext', 'smwEditor.romLoaded', false)
}
