/**
 * The identity of a view's preview tab.
 *
 * Its own module, with no Theia imports, so it can be unit tested. It used
 * to live in `preview-tabs.ts`, which pulls in `ApplicationShell` and so
 * needs a DOM; the suite runs on node, so nothing tested it, and a
 * key-shape mismatch between `preview` and `pin` went unnoticed while four
 * views shared it.
 */

/**
 * One stable id per view's preview tab, or per key where a view has more
 * than one independent tab.
 *
 * The key here is TAB identity, not row identity, and the two are different
 * things. The GFX, Map and Palette views open a widget per row but have ONE
 * preview tab, so their tab key is `{}`. Map16 has a genuinely independent
 * tab per table, so its tab key is `{ layer }`. Passing a row key here
 * yields a different id for every row, which matches no existing tab.
 *
 * Sorted, so the id cannot depend on the order two call sites happen to
 * write the same key in. `undefined` members are dropped, because spreading
 * optional options produces them and they are not part of the identity.
 */
export function previewId(viewId: string, key: object = {}): string {
  const parts = Object.entries(key)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
  return parts.length === 0 ? `${viewId}:preview` : `${viewId}:preview:${parts.join(',')}`
}
