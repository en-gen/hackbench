/**
 * captureAudioContext against a fake AudioContext: vitest runs in node, which
 * has no WebAudio, and the real one is exercised by emulator-view.spec.cjs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { captureAudioContext, AudioOutput } from '../../../theia/extension/src/browser/audio-output'
import { FakeAudioContext, FakeNode } from '../support/fakeAudio'

describe('captureAudioContext', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("routes the captured graph's destination through input -> master -> the real output", () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const outputs: AudioOutput[] = []
    const release = captureAudioContext(globalThis, o => outputs.push(o))

    const ctx = new AudioContext() as unknown as FakeAudioContext
    release()

    expect(outputs).toHaveLength(1)
    const { input, master } = outputs[0] as unknown as { input: FakeNode; master: FakeNode }
    // What the core sees as the destination is our input, so everything it
    // plays passes through master, where volume lives.
    expect(ctx.destination).toBe(input)
    expect(input.outputs).toEqual([master])
    expect(master.outputs).toEqual([ctx.realDestination])
  })

  it('restores the global, so contexts made afterwards are untouched', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const onCreate = vi.fn()
    captureAudioContext(globalThis, onCreate)()

    const ctx = new AudioContext() as unknown as FakeAudioContext
    expect(onCreate).not.toHaveBeenCalled()
    expect(ctx.destination).toBe(ctx.realDestination)
    expect(globalThis.AudioContext).toBe(FakeAudioContext)
  })

  it('without WebAudio at all it captures nothing and does not throw', () => {
    vi.stubGlobal('AudioContext', undefined)
    const onCreate = vi.fn()
    expect(() => captureAudioContext(globalThis, onCreate)()).not.toThrow()
    expect(onCreate).not.toHaveBeenCalled()
  })
})
