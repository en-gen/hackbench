/**
 * A widget that shows one project's data and keeps that project's manifest.
 *
 * Such a view cannot follow a project switch: it holds the old manifest path
 * for its reads and writes, so it is closed when another project opens
 * (#628).
 *
 * The `projectBound` brand, not the mere presence of `manifestPath`, marks
 * the type: the overworld view also holds a field of that name and must stay
 * open.
 */
export interface ProjectBound {
  readonly projectBound: true
  /** Undefined until the widget has been opened on something. */
  readonly manifestPath: string | undefined
}

export function isProjectBound(w: unknown): w is ProjectBound {
  return typeof w === 'object' && w !== null && (w as ProjectBound).projectBound === true
}
