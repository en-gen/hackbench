/**
 * WorkingCopyNotifier: disconnecting must release the WorkingRom
 * subscription itself, not just drop the client reference - a stub
 * `onDidChange` that hands back a spy unsubscribe is what tells the two
 * apart, since nulling the client alone looks identical from the outside.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  WorkingCopyClient,
  WorkingCopyNotifier,
} from '../../../theia/extension/src/node/working-copy-notifier'

const MANIFEST = '/proj.hbproj'

describe('WorkingCopyNotifier', () => {
  it('disconnecting releases the WorkingRom subscription, not just the client reference', () => {
    let listener: ((change: unknown) => void) | undefined
    const change = { kind: 'append', layer: { id: 'l', label: 'l', ops: [] } }
    const unsubscribe = vi.fn()
    const stubWorking = {
      wordOffsets: () => [],
      onDidChange: vi.fn(fn => {
        listener = fn
        return unsubscribe
      }),
    }
    const notifier = new WorkingCopyNotifier<WorkingCopyClient>()
    const client = { onEditEvent: vi.fn() }

    notifier.setClient(client)
    notifier.watch(MANIFEST, stubWorking as any)
    listener?.(change)
    expect(client.onEditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hackbench.edit.applied', subject: MANIFEST }),
    )

    notifier.setClient(undefined)
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    listener?.(change)
    expect(client.onEditEvent).toHaveBeenCalledTimes(1) // no call after disconnect
  })
})
