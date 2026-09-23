/**
 * The ordering a double click needs (PreviewSequence).
 *
 * A double click fires a single click first, so two widget opens run for
 * one gesture and the second has to retire what the first produced. On
 * `ccb66b4` it looked before the first had attached anything, found
 * nothing, and left two widgets of one row on screen: 21 of 26 Playwright
 * cases died on the duplicate elements.
 *
 * These cases are about the WAIT, so they drive it with deferred promises
 * rather than timers: a case that passes only because a sleep was long
 * enough proves nothing about ordering.
 */
import { describe, it, expect } from 'vitest'
import { PreviewSequence } from '../../../theia/extension/src/browser/preview-sequence'

/** A promise whose settling this test controls. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every already-queued microtask run, so "did not resolve" means it. */
const drain = (): Promise<void> => new Promise(res => setTimeout(res, 0))

describe('PreviewSequence', () => {
  it('does not resolve while an open for that tab is still running', async () => {
    const seq = new PreviewSequence()
    const open = deferred<void>()
    seq.track('tab', open.promise)

    let settled = false
    void seq.settled('tab').then(() => {
      settled = true
    })
    await drain()
    // The whole point: the pin path must still be waiting here. Before this
    // class existed it had already looked, found nothing, and moved on.
    expect(settled).toBe(false)

    open.resolve()
    await drain()
    expect(settled).toBe(true)
  })

  it('resolves immediately when nothing is in flight for that tab', async () => {
    const seq = new PreviewSequence()
    let settled = false
    void seq.settled('tab').then(() => {
      settled = true
    })
    await drain()
    expect(settled).toBe(true)
  })

  it('waits per tab, so previewing one table does not hold up pinning the other', async () => {
    const seq = new PreviewSequence()
    const other = deferred<void>()
    seq.track('map16:preview:layer=bg', other.promise)

    let settled = false
    void seq.settled('map16:preview:layer=fg').then(() => {
      settled = true
    })
    await drain()
    expect(settled).toBe(true)
    other.resolve()
  })

  it('treats a FAILED open as settled rather than failing the pin with it', async () => {
    const seq = new PreviewSequence()
    const open = deferred<void>()
    seq.track('tab', open.promise).catch(() => undefined)

    let outcome = 'pending'
    void seq
      .settled('tab')
      .then(() => {
        outcome = 'settled'
      })
      .catch(() => {
        outcome = 'threw'
      })

    open.reject(new Error('the cartridge moved'))
    await drain()
    // The pin path wants to know the preview will not attach anything, not
    // whether it succeeded. Rethrowing here fails a gesture that did nothing
    // wrong.
    expect(outcome).toBe('settled')
  })

  it('waits for an open that STARTS while the first is being awaited', async () => {
    const seq = new PreviewSequence()
    const first = deferred<void>()
    const second = deferred<void>()
    seq.track('tab', first.promise)

    let settled = false
    void seq.settled('tab').then(() => {
      settled = true
    })
    await drain()

    // A second click lands before the first open finished. Awaiting only the
    // promise captured on entry would return while this one is still
    // running, which is the same window in a smaller form.
    seq.track('tab', second.promise)
    first.resolve()
    await drain()
    expect(settled).toBe(false)

    second.resolve()
    await drain()
    expect(settled).toBe(true)
  })

  it('forgets a settled open, so a later wait is not held by a stale entry', async () => {
    const seq = new PreviewSequence()
    const open = deferred<void>()
    seq.track('tab', open.promise)
    open.resolve()
    await drain()

    let settled = false
    void seq.settled('tab').then(() => {
      settled = true
    })
    await drain()
    expect(settled).toBe(true)
  })

  it('hands back the tracked promise, so the caller still awaits its own work', async () => {
    const seq = new PreviewSequence()
    const open = deferred<string>()
    const tracked = seq.track('tab', open.promise)
    open.resolve('applied')
    await expect(tracked).resolves.toBe('applied')
  })
})
