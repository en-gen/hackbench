import type { CharBehavior } from './CharBehavior'

export class Char {
  constructor(
    readonly id: number,
    readonly behavior: CharBehavior,
  ) {}

  getPixels(): Uint8Array {
    return this.behavior.getPixels()
  }

  tickAnimation(): void {
    this.behavior.tickAnimation?.()
  }
}
