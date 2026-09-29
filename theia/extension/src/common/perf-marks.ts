/**
 * Performance marks the perf gates read (docs/superpowers/specs/2026-09-28-perf-gates-design.md,
 * section 2). A spec reads `performance.getEntriesByType('measure')` and takes
 * the `hb:<name>` entry, so the number comes from the app, never from a
 * selector wait around it.
 *
 * `perfEnd` is a no-op unless a `perfStart` of the same name is pending, so a
 * repaint after the first draw cannot record a second measure, and a missing
 * `perfEnd` shows up as a missing measure (the spec fails) rather than a zero.
 */
const PREFIX = 'hb:'
const startMark = (name: string): string => `${PREFIX}${name}:start`

const supported = (): boolean =>
  typeof performance !== 'undefined' && typeof performance.mark === 'function'

export function perfStart(name: string): void {
  if (!supported()) return
  performance.clearMarks(startMark(name))
  performance.mark(startMark(name))
}

/** Records `hb:<name>` from the pending start; false when none was pending. */
export function perfEnd(name: string): boolean {
  if (!supported() || performance.getEntriesByName(startMark(name), 'mark').length === 0) {
    return false
  }
  performance.measure(`${PREFIX}${name}`, startMark(name))
  performance.clearMarks(startMark(name))
  return true
}

/** As `perfEnd`, but after the next paint, for DOM the framework commits asynchronously. */
export function perfEndAfterPaint(name: string): void {
  if (typeof requestAnimationFrame !== 'function') return void perfEnd(name)
  requestAnimationFrame(() => setTimeout(() => perfEnd(name)))
}

/** `hb:<name>` from navigation start (time origin) to now. */
export function perfSinceNavigation(name: string): void {
  if (supported()) performance.measure(`${PREFIX}${name}`, { start: 0 })
}
