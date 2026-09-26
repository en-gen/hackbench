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
import {
  getNonce,
  getWebviewUri,
  readDescriptor,
  postWebviewError,
  buildWebviewHtml,
} from './webviewUtils'
import { hex3 } from '../rom/hex'
import { deriveOverworldEntrances } from '../rom/OverworldEntrances'

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
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        await this._sendGraphData(document.uri, panel.webview)
      }
      if (msg.type === 'openLevel') {
        const hex = hex3(msg.levelIndex as number)
        const uri = vscode.Uri.parse(`smwrom:/${msg.slug}/maps/${hex}.smwmap`)
        await vscode.commands.executeCommand('vscode.open', uri)
      }
    })
  }

  private async _sendGraphData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const descriptor = await readDescriptor<{ romPath: string; slug: string }>(uri)
      const rom = resolveRom(descriptor.romPath)
      const slug = descriptor.slug

      const bounds = deriveOverworldEntrances(rom).roots
      const exitGraph = rom.buildLevelExitGraph(bounds).graph

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

      const { overworld } = rom.classifyLevels(bounds)
      const overworldSet = new Set(overworld)

      const nodes = Array.from(referenced).map(id => ({
        id,
        hex: hex3(id),
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
      postWebviewError(webview, err)
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    return buildWebviewHtml({
      title: 'Level Graph',
      nonce: getNonce(),
      scriptUri: getWebviewUri(webview, this.context.extensionUri, 'levelGraph.js'),
      cspSource: webview.cspSource,
      styles:
        'html,body{height:100%;margin:0;padding:0;overflow:hidden;background:var(--vscode-editor-background,#1e1e1e);}#app{width:100%;height:100%;overflow:hidden;position:relative;}#app svg{position:absolute;top:0;left:0;}',
    })
  }
}
