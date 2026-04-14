import * as vscode from 'vscode'
import { SmwRom } from '../rom/SmwRom'
import { loadRomPalettes } from '../rom/PaletteLoader'

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
      const raw = await vscode.workspace.fs.readFile(uri)
      const descriptor = JSON.parse(Buffer.from(raw).toString('utf8'))
      const rom = SmwRom.open(descriptor.romPath as string)
      const palettes = loadRomPalettes(rom.rom)

      // Convert RgbaColor tuples [r,g,b,a] to plain objects for JSON transfer
      const groups = palettes.groups.map(g => ({
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
      webview.postMessage({
        type: 'load',
        groups,
        backAreaColor: { r: br, g: bg, b: bb, a: ba },
        romName: rom.internalName.trim(),
      })
    } catch (err) {
      webview.postMessage({ type: 'error', message: (err as Error).message })
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'paletteEditor.js')
    )
    const nonce = getNonce()
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMW Palette Editor</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    #app { height: 100%; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
