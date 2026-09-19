import * as vscode from 'vscode'

/** Matches the scheme `extension.ts` registers the filesystem provider under. */
const ROM_SCHEME = 'smwrom'

/**
 * Restored tabs that point into a ROM session that no longer exists.
 *
 * VS Code persists open editors across restarts, and it does so for virtual
 * files too. Ours are descriptors under `smwrom://`, resolved on demand from
 * a ROM the session holds open. After a restart nothing is mounted, so a
 * restored tab cannot resolve anything: it shows an error where a map used
 * to be, and the ROM it names may not even be on disk any more.
 *
 * There is no way to opt an editor out of that persistence.
 * `registerCustomEditorProvider` takes `webviewOptions` and
 * `supportsMultipleEditorsPerDocument` and nothing else, so the tabs come
 * back whatever we do. Closing them during `activate` is the supported way
 * to keep them from lingering.
 */
export function staleRomTabs(groups: readonly vscode.TabGroup[]): vscode.Tab[] {
  return groups.flatMap(g => g.tabs.filter(t => uriOf(t.input)?.scheme === ROM_SCHEME))
}

/**
 * The URI a tab input names, when it names one.
 *
 * Custom editors give `TabInputCustom`, and "Open With... Text Editor" on a
 * descriptor gives `TabInputText` on the same dead URI. Terminals, diffs and
 * webview panels have inputs with no `uri` at all, and reading one blindly
 * would throw during activation.
 */
function uriOf(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputCustom) return input.uri
  if (input instanceof vscode.TabInputText) return input.uri
  return undefined
}
