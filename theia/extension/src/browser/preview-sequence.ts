/**
 * Ordering between the two widget opens one double click produces.
 *
 * A double click fires a single click FIRST, so a tree row that supports
 * both gestures runs two handlers for one gesture: the click opens the
 * preview tab, the double click pins the row's own widget and then retires
 * that preview. The second handler can only retire a preview it can find,
 * and both handlers are async, so "can it find it" is a race.
 *
 * Measured, on `ccb66b4` against a real cartridge: the Map16 view ended up
 * with TWO attached widgets per double click, a preview and a pinned one,
 * both rendering the same controls. 21 of 26 Playwright cases died on the
 * duplicate elements that produced.
 *
 * This holds, per preview tab id, the promise for the preview open that is
 * still running, so the pin path can wait for it rather than guess. It has
 * no Theia imports on purpose: the ordering is the part that was wrong, and
 * it is worth being able to test it without a DOM.
 */
export class PreviewSequence {
  private readonly inFlight = new Map<string, Promise<unknown>>()

  /**
   * Records `work` as the open in flight for `tabId`, and clears it when it
   * settles.
   *
   * The entry is removed only if it is STILL this promise: a later preview
   * of the same tab has already replaced it, and deleting blindly would
   * make that one invisible to a pin that has yet to look.
   */
  track<T>(tabId: string, work: Promise<T>): Promise<T> {
    this.inFlight.set(tabId, work)
    const forget = (): void => {
      if (this.inFlight.get(tabId) === work) this.inFlight.delete(tabId)
    }
    work.then(forget, forget)
    return work
  }

  /**
   * Resolves once nothing is in flight for `tabId`.
   *
   * A rejected open is still a settled one: the pin path wants to know the
   * preview is no longer going to attach anything, not whether it
   * succeeded, and rethrowing here would fail a gesture that did nothing
   * wrong.
   *
   * Loops rather than awaiting once, because an open can start while the
   * first is being awaited, and waiting for a promise that has already been
   * superseded leaves the same window this class exists to close.
   */
  async settled(tabId: string): Promise<void> {
    let pending = this.inFlight.get(tabId)
    while (pending) {
      await pending.catch(() => undefined)
      const next = this.inFlight.get(tabId)
      pending = next === pending ? undefined : next
    }
  }
}
