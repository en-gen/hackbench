import * as vscode from 'vscode'

/**
 * Which ROM did the user mean, if the command invocation already says?
 *
 * `hackbench.openRom` is contributed to `explorer/context` for `.sfc` and
 * `.smc`, and VS Code invokes a context-menu command with the URI of the
 * resource that was right-clicked. The command palette and the welcome-view
 * link invoke the same command with nothing.
 *
 * Returns the file path when the argument names one, and `undefined` when the
 * caller has to ask instead. Kept out of `extension.ts` so it can be tested
 * without dragging in every provider that module constructs.
 */
export function romPathFromCommandArg(arg: unknown): string | undefined {
  // `instanceof` is the check that matters. A duck-typed object carrying a
  // `scheme` and an `fsPath` is not a URI, and trusting one would mean taking
  // a path from whatever happened to be passed.
  if (!(arg instanceof vscode.Uri)) return undefined

  // `fsPath` on a non-file URI is a lie: it will happily render
  // `smwrom://vanilla/maps/000.smwmap` as a path-shaped string that opens
  // nothing.
  if (arg.scheme !== 'file') return undefined

  return arg.fsPath
}
