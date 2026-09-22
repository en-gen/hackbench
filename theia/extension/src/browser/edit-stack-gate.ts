/**
 * Whether HackBench's undo/redo should claim Theia's `core.undo`/`core.redo`.
 *
 * Its own Theia-free file because it is the one piece of the command wiring a
 * plain Vitest test can exercise, and the piece where a mistake is silent:
 * claim too eagerly and Ctrl+Z in the preferences JSON editor stops undoing
 * text and starts dropping ROM edit layers. Declining is not a dead end -
 * Theia takes the first handler whose `isEnabled` says yes, so a no here
 * hands the command back to Monaco's handler and then the built-in.
 *
 * @param activeWidgetId `ApplicationShell.activeWidget`'s id, or undefined.
 * @param hasProject     Whether there is a layer stack to act on at all.
 */
export function handlesEditStack(activeWidgetId: string | undefined, hasProject: boolean): boolean {
  if (!hasProject || !activeWidgetId) return false
  // Every widget this application contributes is registered under this prefix.
  return activeWidgetId.startsWith('hackbench.')
}
