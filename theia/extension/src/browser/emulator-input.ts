/**
 * Keyboard to SNES controller, for the core's exported simulate_input.
 * The core never sees the keyboard itself: its own listeners are on its
 * iframe's document, which never has focus, so every press comes through
 * here. A gamepad source can feed the same HeldButtons later.
 */

/**
 * libretro RETRO_DEVICE_ID_JOYPAD ids by KeyboardEvent.code. The layout the
 * VS Code extension's emulator preview used (src/webview/emulatorPreview),
 * plus Q/W for the shoulder buttons it lacked.
 */
export const KEY_TO_BUTTON: Readonly<Record<string, number>> = {
  KeyZ: 0, // B
  KeyA: 1, // Y
  ShiftRight: 2, // Select
  Enter: 3, // Start
  ArrowUp: 4,
  ArrowDown: 5,
  ArrowLeft: 6,
  ArrowRight: 7,
  KeyX: 8, // A
  KeyS: 9, // X
  KeyQ: 10, // L
  KeyW: 11, // R
}

/**
 * Which buttons are down, so key repeat sends nothing and a release can be
 * forced. A press the core never sees released stays held, survives a core
 * restart, and has wedged a run on a black screen (spike/FINDINGS.md).
 */
export class HeldButtons {
  private readonly held = new Set<number>()

  constructor(private readonly send: (button: number, pressed: boolean) => void) {}

  /** False for keys that are not controller keys, which the caller must leave alone. */
  key(code: string, down: boolean): boolean {
    const button = KEY_TO_BUTTON[code]
    if (button === undefined) return false
    if (down !== this.held.has(button)) {
      if (down) this.held.add(button)
      else this.held.delete(button)
      this.send(button, down)
    }
    return true
  }

  releaseAll(): void {
    for (const button of this.held) this.send(button, false)
    this.held.clear()
  }
}
