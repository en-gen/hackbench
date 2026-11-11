/**
 * Synthetic carts here have no readable sprite loader, so a drawn special-drawer result also carries the unreadable-routing
 * reason (#1273). These tests are about the drawer's own `unverified` text: strip that one sentence, leave the rest to assert on.
 */
export const withoutRoutingReason = (unverified: string | undefined): string | undefined =>
  unverified?.replace(/the loader's id routing could not be read \(.*?\), so this id may be a shooter, generator or scroll command the game never runs as a sprite/, '') || undefined // prettier-ignore
