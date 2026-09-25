/**
 * The DI wiring itself: two connections resolve their own PaletteServiceImpl
 * (not the same shared instance), both keep sharing one WorkingRomRegistry,
 * and closing one connection's channel drops exactly its own WorkingRom
 * subscription while the other keeps getting pushed to. Reaches real
 * inversify and Theia's own messaging classes, so it is gated the same way
 * Map16WriteGate.test.ts gates its wiring cases: the unit job does not
 * install the theia/ workspace, and a test that reaches it fails to LOAD
 * there while passing on any machine that has the workspace installed.
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { WorkingRom, Layer } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'

const theiaInstalled = existsSync(
  resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)
const T = '../../../theia/node_modules/@theia/core/'
const MANIFEST = '/proj.hbproj'

function fakeRom(size = 0x8000): Uint8Array {
  const rom = new Uint8Array(size)
  for (let i = 0; i < size; i++) rom[i] = (i * 31) & 0xff
  const o = loromToOffset(0x00b2ce, size, false) as number
  rom[o] = 0x1f
  rom[o + 1] = 0x39
  return rom
}
const layer = (id: string, oldW: string, newW: string): Layer => ({
  id,
  label: id,
  scope: 'edit',
  ops: [{ address: '$00B2CE', old: oldW, new: newW }],
})

describe.skipIf(!theiaInstalled)('the connection-container wiring', () => {
  it('per-connection instances, one shared registry, close releases the subscription', async () => {
    await import('../../../theia/node_modules/reflect-metadata')
    const { Container } = await import(T + 'shared/inversify')
    const { ConnectionHandler, RpcProxyFactory } = await import(T + 'lib/common/messaging')
    const { ContributionProvider, bindContributionProvider } = await import(
      T + 'lib/common/contribution-provider'
    )
    const { ConnectionContainerModule } = await import(
      T + 'lib/node/messaging/connection-container-module'
    )
    const { ForwardingChannel } = await import(T + 'lib/common/message-rpc/channel')
    const { Uint8ArrayWriteBuffer, Uint8ArrayReadBuffer } = await import(
      T + 'lib/common/message-rpc/uint8-array-message-buffer'
    )
    const { WorkingRomRegistry } = await import('../../../src/project/WorkingRomRegistry')
    const hb = (await import('../../../theia/extension/src/node/hackbench-backend-module')).default
    const pal = (await import('../../../theia/extension/src/node/palette-backend-module')).default
    const { PALETTE_SERVICE_PATH, PaletteService } =
      await import('../../../theia/extension/src/common/palette-protocol')

    const working = new WorkingRom(fakeRom(), false)
    const root = new Container()
    root.load(hb, pal)
    const stub = { get: () => ({ status: 'ok', working, romPath: 'x', project: {} }) }
    root.rebind(WorkingRomRegistry).toConstantValue(stub)

    function pipe() {
      const mk = (peer: () => any) =>
        new ForwardingChannel(
          'p',
          () => {},
          () => {
            const b = new Uint8ArrayWriteBuffer()
            b.onCommit(d => peer().onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(d)))
            return b
          },
        )
      /* eslint-disable prefer-const -- each closure captures the other before either is assigned */
      let a: any, b: any
      a = mk(() => b)
      b = mk(() => a)
      /* eslint-enable prefer-const */
      return [a, b]
    }

    // Same lookup default-messaging-service.js's getConnectionChannelHandlers
    // uses: a handler bound directly in the ROOT container (a service that
    // never moved into a ConnectionContainerModule, or a reverted one) is a
    // real, reachable case, so the recursive provider is required here too -
    // a plain child.getAll would shadow it and this would fail at "handler
    // not found" rather than at the assertion a reverted module should trip.
    function connect() {
      const child = root.createChild()
      bindContributionProvider(child, ConnectionHandler)
      child.load(...root.getAll(ConnectionContainerModule))
      const handlers: any[] = child
        .getNamed(ContributionProvider, ConnectionHandler)
        .getContributions(true)
      const h = handlers.find(x => x.path === PALETTE_SERVICE_PATH)
      const [back, front] = pipe()
      const client = { onWorkingCopyChanged: vi.fn() }
      const f = new RpcProxyFactory(client)
      f.listen(front)
      h.onConnection(back)
      return { child, client, back }
    }

    const A = connect()
    const B = connect()
    const sa = A.child.get(PaletteService)
    const sb = B.child.get(PaletteService)
    expect(sa).not.toBe(sb)
    expect(A.child.get(WorkingRomRegistry)).toBe(B.child.get(WorkingRomRegistry))
    await sa.loadPalettes(MANIFEST)
    await sb.loadPalettes(MANIFEST)

    working.append(layer('L1', '$391F', '$03E0'))
    await vi.waitFor(() => {
      expect(A.client.onWorkingCopyChanged).toHaveBeenCalledTimes(1)
      expect(B.client.onWorkingCopyChanged).toHaveBeenCalledTimes(1)
    })

    // Close B's channel the way the multiplexer does on a real disconnect.
    const listenersBefore: number = (working as any).listeners.size
    B.back.onCloseEmitter.fire({ reason: 'test' })
    const listenersAfter: number = (working as any).listeners.size
    expect(listenersAfter).toBe(listenersBefore - 1)

    working.append(layer('L2', '$03E0', '$001F'))
    await vi.waitFor(() => expect(A.client.onWorkingCopyChanged).toHaveBeenCalledTimes(2))
    expect(B.client.onWorkingCopyChanged).toHaveBeenCalledTimes(1)
  })
})
