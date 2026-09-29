/**
 * `hb:<name>` measures the perf gates read (docs/superpowers/specs/2026-09-28-perf-gates-design.md,
 * section 2). `perfEnd` records only when a `perfStart` of that name is
 * pending, so a repaint cannot record twice and a removed `perfEnd` leaves a
 * missing measure, which fails the spec instead of reading as zero.
 *
 * Marks are keyed by name alone: valid for single-view specs only. Two views
 * of one kind open at once would share a start mark.
 */
const startMark = (name: string): string => `hb:${name}:start`
const pending = (name: string): boolean =>
  performance.getEntriesByName(startMark(name), 'mark').length > 0

export function perfStart(name: string): void {
  performance.clearMarks(startMark(name))
  performance.mark(startMark(name))
}

export function perfEnd(name: string): void {
  if (!pending(name)) return
  performance.measure(`hb:${name}`, startMark(name))
  performance.clearMarks(startMark(name))
}

/**
 * As `perfEnd`, but the measure is taken in a task queued from the next
 * animation frame: after the frame that follows this call, not after React's
 * commit. Schedules nothing when no start is pending.
 */
export function perfEndAfterPaint(name: string): void {
  if (pending(name)) requestAnimationFrame(() => setTimeout(() => perfEnd(name)))
}
