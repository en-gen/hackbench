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
import { getAllLevelBgmTracks, readLevelMusicTable } from '../rom/MusicData'
import { buildSpc } from '../rom/SpcBuilder'

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
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
      ]
    }
    panel.webview.html = this._buildHtml(panel.webview)

    const unmuteIcon = {
          light: vscode.Uri.joinPath(this.context.extensionUri, 'build', 'icons', 'light', 'unmute.svg'),
          dark: vscode.Uri.joinPath(this.context.extensionUri, 'build', 'icons', 'dark', 'unmute.svg'),
        }

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this._sendMusicData(document.uri, panel.webview)
      } else if (msg.type === 'musicState') {
        panel.iconPath = msg.playing ? unmuteIcon : undefined
      }
    })
  }

  private async _sendMusicData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(uri)
      const descriptor = JSON.parse(Buffer.from(raw).toString('utf8'))
      const rom = resolveRom(descriptor.romPath as string)

      // Get all track info
      const allTracks = getAllLevelBgmTracks(rom.rom)
      const levelTable = readLevelMusicTable(rom.rom)

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
          bgmHex: t.bgmCommand.toString(16).toUpperCase().padStart(2, '0'),
          // Which level music indices map to this track
          levelIndices: levelTable
            .filter(e => e.bgmCommand === t.bgmCommand)
            .map(e => e.index),
        })),
        spcFiles,
      })
    } catch (err) {
      webview.postMessage({ type: 'error', message: (err as Error).message })
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'musicPlayer.js')
    )
    const spcJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'spc.js')
    )
    const wasmUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'spc.wasm')
    )
    const nonce = getNonce()
    return /* html */`<!DOCTYPE html>
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
  <style>html, body { height:100%; margin:0; padding:0; overflow:hidden; } #app { height:100%; }</style>
</head>
<body>
  <!-- Stub DOM: spc.js UI init accesses these elements. All hidden. -->
  <div id="spc-player-interface" style="display:none;">
    <div id="spc-player-header" class="header-button"></div>
    <div class="title"></div><div class="subtitle"></div><div class="details"></div>
    <button class="pause hidden"></button><button class="play"></button>
    <button class="restart"></button><button class="stop"></button><button class="close"></button>
    <input type="checkbox" id="spc-player-toggle"/>
    <input type="checkbox" id="spc-player-loop"/>
    <input type="range" id="volume-slider" class="volume-slider" min="0" max="1.5" step="0.01" value="1"/>
    <div class="volume-fill"></div><div class="volume-level"></div><div class="volume-thumb"></div>
    <div class="seek-container"><input type="range" class="seek-control" min="0" max="1"/><span class="seek-preview"></span></div>
    <span class="track-time-elapsed"></span><span class="track-duration"></span>
    <div id="track-list-container" class="hidden">
      <div class="track-list-scrollbox"></div>
      <div class="track-list"></div>
      <div class="overflow-indicator top"></div><div class="overflow-indicator bottom"></div>
    </div>
    <div class="seek"></div>
  </div>
  <div id="app"></div>
  <script nonce="${nonce}">
    window.Module = { locateFile: function(path) {
      if (path.endsWith('.wasm')) return '${wasmUri}';
      return path;
    }};
    window.SMWCentral = { SPCPlayer: {} };
  </script>
  <script nonce="${nonce}" src="${spcJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
