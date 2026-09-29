/** The order the player meets the special rows, whatever order the backend sends them in. */
export const SPECIAL_ORDER = ['title-screen', 'new-game'] as const

/** Sorts special rows into SPECIAL_ORDER; a role not listed sorts last, stably. */
export function orderSpecials<T extends { role: string }>(specials: readonly T[]): T[] {
  const rank = (s: T): number => {
    const i = (SPECIAL_ORDER as readonly string[]).indexOf(s.role)
    return i < 0 ? SPECIAL_ORDER.length : i
  }
  return [...specials].sort((a, b) => rank(a) - rank(b))
}
