import * as vscode from 'vscode'

/** Resolve a file in `dist/webview/` to a webview-safe URI in one call. */
export function getWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  filename: string,
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', filename))
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export async function readDescriptor<T>(uri: vscode.Uri): Promise<T> {
  const raw = await vscode.workspace.fs.readFile(uri)
  return JSON.parse(Buffer.from(raw).toString('utf8')) as T
}

export function postWebviewError(webview: vscode.Webview, err: unknown): void {
  webview.postMessage({ type: 'error', message: (err as Error).message })
}

/**
 * The hidden stub DOM required by spc.js at init time. Both MapEditor and
 * MusicPlayer embed the SPC player, so this block is shared.
 */
export const SPC_PLAYER_STUB_DOM = /* html */`\
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
  </div>`

/** Inline script that wires spc.js's Emscripten locateFile to the WASM asset URI. */
export function buildSpcInitScript(nonce: string, wasmUri: vscode.Uri): string {
  return `  <script nonce="${nonce}">
    window.Module = { locateFile: function(path) {
      if (path.endsWith('.wasm')) return '${wasmUri}';
      return path;
    }};
    window.SMWCentral = { SPCPlayer: {} };
  </script>`
}

/**
 * Build the boilerplate HTML shell for a webview panel.
 *
 * Covers the majority of providers: one script, optional extra CSS links,
 * and an optional extra CSP directive (e.g. `font-src`). Providers that
 * need wasm-unsafe-eval, multiple scripts, or inline DOM stubs (MapEditor,
 * MusicPlayer) build their own HTML but still use the other shared utilities.
 */
export function buildWebviewHtml(opts: {
  title: string
  nonce: string
  scriptUri: vscode.Uri
  cspSource: string
  /** Extra CSS stylesheet URIs (e.g. codicon.css) */
  cssLinks?: vscode.Uri[]
  /** Additional CSP directives appended after style-src (e.g. "font-src ${cspSource};") */
  extraCsp?: string
  /** Inline <style> block; defaults to a full-height overflow-hidden body */
  styles?: string
}): string {
  const { title, nonce, scriptUri, cspSource } = opts
  const styles = opts.styles ?? 'html,body{height:100%;margin:0;padding:0;overflow:hidden;}#app{height:100%;}'
  const cssLinkTags = (opts.cssLinks ?? []).map(u => `  <link rel="stylesheet" href="${u}" />\n`).join('')
  const extraCspLine = opts.extraCsp ? '\n             ' + opts.extraCsp : ''
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${cspSource} 'unsafe-inline';${extraCspLine}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
${cssLinkTags}  <style>${styles}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
