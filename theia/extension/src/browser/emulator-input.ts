/**
 * Keyboard to SNES controller, for the core's exported simulate_input.
 * The core never sees the keyboard itself: its own listeners are on its
 * iframe's document, which never has focus, so every press comes through
 * here. A gamepad source can feed the same HeldButtons later.
 */

/**
 * libretro RETRO_DEVICE_ID_JOYPAD ids by KeyboardEvent.code. Matches the
 * default keyboard configs in each emulator's source (master, read
 * 2026-09-23): arrows, Z/X/A/S and Enter as RetroArch, ZSNES and BizHawk;
 * Q/W shoulders as RetroArch and Mesen 2. Select is RShift in RetroArch and
 * ZSNES but Space in BizHawk and Snes9x Qt, so it has both.
 */
export const KEY_TO_BUTTON: Readonly<Record<string, number>> = {
  KeyZ: 0, // B
  KeyA: 1, // Y
  ShiftRight: 2, // Select
  Space: 2, // Select
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
 * Which keys are down, so key repeat sends nothing and a release can be
 * forced. A press the core never sees released stays held, survives a core
 * restart, and has wedged a run on a black screen (spikes/libretro-view-engine/FINDINGS.md).
 * Tracked per key, not per button: a button with two keys stays down until
 * the last of them is let go.
 */
export class HeldButtons {
  private readonly held = new Set<string>()

  constructor(private readonly send: (button: number, pressed: boolean) => void) {}

  /** False for keys that are not controller keys, which the caller must leave alone. */
  key(code: string, down: boolean): boolean {
    const button = KEY_TO_BUTTON[code]
    if (button === undefined) return false
    if (down === this.held.has(code)) return true
    const shared = [...this.held].some(c => c !== code && KEY_TO_BUTTON[c] === button)
    if (down) this.held.add(code)
    else this.held.delete(code)
    if (!shared) this.send(button, down)
    return true
  }

  releaseAll(): void {
    for (const button of new Set(Array.from(this.held, c => KEY_TO_BUTTON[c])))
      this.send(button, false)
    this.held.clear()
  }
}
