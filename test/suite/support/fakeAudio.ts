/** Just enough WebAudio for node: vitest has none, and the real graph is covered by emulator-view.spec.cjs. */
import { vi } from 'vitest'

export class FakeNode {
  gain = { value: 1 }
  outputs: unknown[] = []
  connect(to: unknown): void {
    this.outputs.push(to)
  }
}

export class FakeAudioContext {
  readonly realDestination = new FakeNode()
  suspend = vi.fn(async () => {})
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  get destination(): unknown {
    return this.realDestination
  }
  createGain(): FakeNode {
    return new FakeNode()
  }
}
