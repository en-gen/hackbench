/**
 * Custom editor provider for .smwgfx virtual files.
 *
 * Opens a tile sheet viewer for a single GFX file (GFX00–GFX31 hex = indices 0–49).
 * Each file is LC_LZ2-compressed in ROM; standard files decompress to 96 4bpp tiles.
 * GFX20 hex (index 32) is the Mario sprites file — 3bpp, 128 tiles.
 *
 * Message protocol:
 *   Extension → Webview:
 *     { type:'load', gfxIndex, gfxHex, tilePixels, tileCount, paletteRows }
 *     { type:'error', message }
 *   Webview → Extension:
 *     { type:'ready' }
 */

import * as vscode from 'vscode'
import { SmwRom } from '../rom/SmwRom'
import { GFX_FILE_COUNT, GFX_MARIO_3BPP_INDEX, loadGfxFile, loadGfxRaw } from '../rom/GfxLoader'
import { loadRomPalettes, buildLevelCgram } from '../rom/PaletteLoader'

/**
 * Guess the most useful palette row to display for a given GFX file index.
 *
 * SMW CGRAM row conventions:
 *   Rows 0–1  : BG Layer 2 (background scenery)
 *   Rows 2–3  : FG Layer 1 (foreground terrain — most GFX files)
 *   Rows 4–8  : Sprites (enemies, items; SP1–SP4 GFX files)
 *   Row  13   : Player (Mario/Luigi — GFX20 hex / index 32, 3bpp)
 *   Rows 9–15 : Misc / special
 *
 * GFX file→VRAM slot assignments vary per level tileset, but this heuristic
 * covers the majority of vanilla SMW files.
 */
function _suggestPaletteRow(gfxIndex: number): number {
  // GFX20 hex (index 32) = Mario/Luigi 3bpp sprites → Player palette
  if (gfxIndex === GFX_MARIO_3BPP_INDEX) return 13

  // GFX28–GFX2B hex (indices 40–43) = commonly assigned to SP1–SP4 sprite slots
  if (gfxIndex >= 40 && gfxIndex <= 43) return 4

  // GFX2C–GFX2F hex (indices 44–47) = also used for sprites in many tilesets
  if (gfxIndex >= 44 && gfxIndex <= 47) return 4

  // GFX30–GFX31 hex (indices 48–49) = typically animated/misc tiles
  if (gfxIndex >= 48) return 0

  // GFX25–GFX27 hex (indices 37–39) = BG Layer 2 background tiles
  if (gfxIndex >= 37 && gfxIndex <= 39) return 0

  // GFX00–GFX1F hex (indices 0–31) = FG terrain tiles
  return 2
}

export class GfxViewerProvider implements vscode.CustomReadonlyEditorProvider {
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
        await this._sendGfxData(document.uri, panel.webview)
      }
    })
  }

  private async _sendGfxData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(uri)
      const descriptor = JSON.parse(Buffer.from(raw).toString('utf8'))

      const rom = SmwRom.open(descriptor.romPath as string)
      const gfxIndex = descriptor.gfxIndex as number

      if (gfxIndex < 0 || gfxIndex >= GFX_FILE_COUNT) {
        webview.postMessage({ type: 'error', message: `Invalid GFX index: ${gfxIndex}` })
        return
      }

      // Decompress and decode the GFX file via pointer tables + LC_LZ2
      const rawBytes  = loadGfxRaw(rom.rom, gfxIndex)
      const sheet     = loadGfxFile(rom.rom, gfxIndex)
      const tilePixels = sheet.map(tile => Array.from(tile))

      // Build 16 CGRAM rows of RGBA colors from ROM palettes (default variants)
      const romPalettes = loadRomPalettes(rom.rom)
      const cgram = buildLevelCgram(romPalettes, 0, 0, 0)
      const paletteRows = cgram.rows.map(row => row.map(c => Array.from(c)))

      webview.postMessage({
        type: 'load',
        gfxIndex,
        gfxHex:           gfxIndex.toString(16).toUpperCase().padStart(2, '0'),
        tilePixels,
        tileCount:        tilePixels.length,
        paletteRows,
        suggestedPaletteRow: _suggestPaletteRow(gfxIndex),
        // Raw decompressed bytes — sent so the webview can re-decode client-side
        // when the user toggles the 3bpp / 4bpp selector.
        rawBytes: Array.from(rawBytes),
        // Mirror the bpp auto-detect logic from GfxLoader (size-based).
        defaultBpp: (() => {
          const n = rawBytes.length
          const div16 = n % 16 === 0, div24 = n % 24 === 0, div32 = n % 32 === 0
          return (!div24 && !div32 && div16) ? 2 : (!div24 && div32) ? 4 : 3
        })() as 2 | 3 | 4,
      })
    } catch (err) {
      webview.postMessage({ type: 'error', message: (err as Error).message })
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'gfxViewer.js')
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
  <title>SMW GFX Viewer</title>
  <style>html, body { height:100%; margin:0; padding:0; overflow:hidden; } #app { height:100%; }</style>
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
