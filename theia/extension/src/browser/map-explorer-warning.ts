/** The tooltip warning on a map whose data could not be read to its end (D155). */
export const UNREADABLE_TITLE = "This map's data could not be read"

/**
 * A row's tooltip with the warning kept. A role's own text (Title Screen, Bonus Game)
 * stays, but it never replaces the warning: every kind of row says when its data is bad.
 */
export function titleWithWarning(
  title: string | undefined,
  unreadable?: boolean,
): string | undefined {
  if (!unreadable) return title
  return title ? `${title}\n${UNREADABLE_TITLE}` : UNREADABLE_TITLE
}
