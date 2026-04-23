/**
 * Custom editor provider for .smwgraph virtual files.
 *
 * Renders the ROM's level interconnection graph: all levels that have at
 * least one secondary exit are shown as nodes; directed edges represent
 * pipe, door, and pit exits.  Clicking a node opens that level's map editor.
 *
 * Message protocol:
 *   Extension → Webview:
 *     { type:'load', nodes, edges, slug }
 *     { type:'error', message }
 *   Webview → Extension:
 *     { type:'ready' }
 *     { type:'openLevel', levelIndex, slug }
 */

import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'

export class LevelGraphProvider implements vscode.CustomReadonlyEditorProvider {
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
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this._sendGraphData(document.uri, panel.webview)
      }
      if (msg.type === 'openLevel') {
        const hex = (msg.levelIndex as number).toString(16).toUpperCase().padStart(3, '0')
        const uri = vscode.Uri.parse(`smwrom:/${msg.slug}/maps/${hex}.smwmap`)
        await vscode.commands.executeCommand('vscode.open', uri)
      }
    })
  }

  private async _sendGraphData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(uri)
      const descriptor = JSON.parse(Buffer.from(raw).toString('utf8'))
      const rom  = resolveRom(descriptor.romPath as string)
      const slug = descriptor.slug as string

      const exitGraph = rom.buildLevelExitGraph()

      // Collect all level IDs referenced by at least one edge
      const referenced = new Set<number>()
      for (const [src, targets] of exitGraph) {
        referenced.add(src)
        for (const t of targets) referenced.add(t)
      }
      if (referenced.size === 0) {
        webview.postMessage({ type: 'error', message: 'No level connections found in this ROM.' })
        return
      }

      const { overworld } = rom.classifyLevels()
      const overworldSet = new Set(overworld)

      const nodes = Array.from(referenced).map(id => ({
        id,
        hex: id.toString(16).toUpperCase().padStart(3, '0'),
        name: rom.getLevelName(id),
        isOverworld: overworldSet.has(id),
      }))

      const edges: { source: number; target: number }[] = []
      for (const [src, targets] of exitGraph) {
        if (!referenced.has(src)) continue
        for (const tgt of targets) {
          edges.push({ source: src, target: tgt })
        }
      }

      webview.postMessage({ type: 'load', nodes, edges, slug })
    } catch (err) {
      webview.postMessage({ type: 'error', message: (err as Error).message })
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'levelGraph.js')
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
  <title>Level Graph</title>
  <style>
    html, body { height:100%; margin:0; padding:0; overflow:hidden; background:var(--vscode-editor-background,#1e1e1e); }
    #app { width:100%; height:100%; overflow:hidden; position:relative; }
    #app svg { position:absolute; top:0; left:0; }
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
