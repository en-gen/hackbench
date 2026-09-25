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
    let listener: (() => void) | undefined
    const unsubscribe = vi.fn()
    const stubWorking = {
      onDidChange: vi.fn(fn => {
        listener = fn
        return unsubscribe
      }),
    }
    const notifier = new WorkingCopyNotifier<WorkingCopyClient>()
    const client = { onWorkingCopyChanged: vi.fn() }

    notifier.setClient(client)
    notifier.watch(MANIFEST, stubWorking as any)
    listener?.()
    expect(client.onWorkingCopyChanged).toHaveBeenCalledWith(MANIFEST)

    notifier.setClient(undefined)
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    listener?.()
    expect(client.onWorkingCopyChanged).toHaveBeenCalledTimes(1) // no call after disconnect
  })
})
