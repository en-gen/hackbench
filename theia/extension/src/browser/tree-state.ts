/**
 * What an explorer keeps across a per-edit rebuild: the keys it remembered
 * (selected rows, expanded rows) that the rebuilt tree still has. A key the
 * rebuild no longer has is dropped, never swapped for a neighbour. No Theia
 * import, so a synthetic unit test (CI has no ROM) covers it.
 */
export function surviving<K>(saved: Iterable<K>, existing: Iterable<K>): K[] {
  const present = new Set(existing)
  return [...saved].filter(key => present.has(key))
}
