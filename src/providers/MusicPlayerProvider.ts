/**
 * Custom editor provider for .smwmusic virtual files.
 *
 * Opens a music player webview that lists all BGM tracks from the ROM's
 * music bank and provides playback controls. Audio plays via the
 * @smwcentral/spc-player WASM engine + Web Audio API, all within the
 * webview (no external panels needed).
 *
 * Message protocol:
 *   Extension → Webview:
 *     { type:'load', tracks, spcFiles }
 *     { type:'error', message }
 *   Webview → Extension:
 *     { type:'ready' }
 */

import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'
import { getAllLevelBgmTracks, readLevelMusicTableIfReadable, slotsFor } from '../rom/MusicData'
import { buildSpc } from '../rom/SpcBuilder'
import {
  getNonce,
  getWebviewUri,
  readDescriptor,
  postWebviewError,
  SPC_PLAYER_STUB_DOM,
  buildSpcInitScript,
} from './webviewUtils'
import { hex2 } from '../rom/hex'

export class MusicPlayerProvider implements vscode.CustomReadonlyEditorProvider {
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
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = this._buildHtml(panel.webview)

    const unmuteIcon = {
      light: vscode.Uri.joinPath(
        this.context.extensionUri,
        'build',
        'icons',
        'light',
        'unmute.svg',
      ),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'build', 'icons', 'dark', 'unmute.svg'),
    }

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        await this._sendMusicData(document.uri, panel.webview)
      } else if (msg.type === 'musicState') {
        panel.iconPath = msg.playing ? unmuteIcon : undefined
      }
    })
  }

  private async _sendMusicData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const descriptor = await readDescriptor<{ romPath: string }>(uri)
      const rom = resolveRom(descriptor.romPath)

      // Get all track info
      const allTracks = getAllLevelBgmTracks(rom.rom)
      const levelTable = readLevelMusicTableIfReadable(rom.rom)

      // Build SPC files for each track
      const spcFiles: Record<number, number[]> = {}
      for (const track of allTracks) {
        const spc = buildSpc(rom.rom, track.bgmCommand, 'level')
        if (spc) {
          spcFiles[track.bgmCommand] = Array.from(spc)
        }
      }

      webview.postMessage({
        type: 'load',
        tracks: allTracks.map(t => ({
          bgmCommand: t.bgmCommand,
          bgmHex: hex2(t.bgmCommand),
          // Which level music indices map to this track
          levelIndices: slotsFor(levelTable, t.bgmCommand),
        })),
        spcFiles,
      })
    } catch (err) {
      postWebviewError(webview, err)
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const ext = this.context.extensionUri
    const scriptUri = getWebviewUri(webview, ext, 'musicPlayer.js')
    const spcJsUri = getWebviewUri(webview, ext, 'spc.js')
    const wasmUri = getWebviewUri(webview, ext, 'spc.wasm')
    const nonce = getNonce()
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval';
             connect-src ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMW Music Player</title>
  <style>html,body{height:100%;margin:0;padding:0;overflow:hidden;}#app{height:100%;}</style>
</head>
<body>
${SPC_PLAYER_STUB_DOM}
  <div id="app"></div>
${buildSpcInitScript(nonce, wasmUri)}
  <script nonce="${nonce}" src="${spcJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
