import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'
import { loadRomPalettes } from '../rom/PaletteLoader'
import { loadPaletteAnimData, serializePaletteAnimData } from '../rom/PaletteAnimationLoader'
import { getNonce, getWebviewUri, readDescriptor, postWebviewError, buildWebviewHtml } from './webviewUtils'

/**
 * Custom editor for .smwpalette virtual files.
 *
 * Reads all palette groups from the ROM and sends them to the webview
 * organized by group with variants (e.g. BG0, FG0, Player, etc.).
 *
 * Message protocol:
 *   Extension → Webview:
 *     { type: 'load', groups: PaletteGroup[], backAreaColor: Color, romName: string }
 *     { type: 'error', message: string }
 *   Webview → Extension:
 *     { type: 'ready' }
 */
export class PaletteEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => undefined }
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
      ]
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this._sendPaletteData(document.uri, panel.webview)
      }
    })
  }

  private async _sendPaletteData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const descriptor = await readDescriptor<{ romPath: string; groupId: string | null }>(uri)
      const rom = resolveRom(descriptor.romPath)
      const palettes = loadRomPalettes(rom.rom)

      // If a specific groupId is requested, filter to just that group
      const requestedGroupId = descriptor.groupId
      const sourceGroups = requestedGroupId
        ? palettes.groups.filter(g => g.id === requestedGroupId)
        : palettes.groups

      // Convert RgbaColor tuples [r,g,b,a] to plain objects for JSON transfer
      const groups = sourceGroups.map(g => ({
        id: g.id,
        label: g.label,
        description: g.description,
        cgRamRow: g.cgRamRow,
        variants: g.variants.map(v => ({
          label: v.label,
          romAddr: v.romAddr,
          // rows: array of CGRAM rows; each row is 16 {r,g,b,a} objects
          rows: v.rows.map(row => row.map(([r, g, b, a]) => ({ r, g, b, a }))),
        })),
      }))

      const [br, bg, bb, ba] = palettes.backAreaColor
      const palAnimRaw = loadPaletteAnimData(rom.rom)
      webview.postMessage({
        type: 'load',
        groups,
        backAreaColor: { r: br, g: bg, b: bb, a: ba },
        romName: rom.internalName.trim(),
        paletteAnimation: palAnimRaw ? serializePaletteAnimData(palAnimRaw) : null,
      })
    } catch (err) {
      postWebviewError(webview, err)
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const ext = this.context.extensionUri
    return buildWebviewHtml({
      title: 'SMW Palette Editor',
      nonce: getNonce(),
      scriptUri: getWebviewUri(webview, ext, 'paletteEditor.js'),
      cspSource: webview.cspSource,
      cssLinks: [getWebviewUri(webview, ext, 'codicon.css')],
      extraCsp: `font-src ${webview.cspSource};`,
    })
  }
}
