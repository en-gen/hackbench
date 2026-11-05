/**
 * Layer1XPos the moment a level has loaded, where a world-locked Layer 3 starts to follow the camera
 * (#563): the load-time UpdateScreenPosition moves it from X 0 toward Mario's start with no CODE_00F8AB
 * adjustment, so it is start - $8C, at most $1F00. The trace, the direct-load limit and the fingerprint
 * accounting are in docs/rom/layer3-world-locked.md. A ROM whose camera code differs gets no anchor.
 */
import { createHash } from 'node:crypto'
import type { RomFile } from './RomFile'

const RIGHT_BUFFER = 0x8c
/** (!LevelMaxScreens - 1) << 8, bank_00.asm:2652, 13676-13685 */
const LOAD_CAMERA_MAX = 0x1f00

/** The tooltip when the camera code is not stock: plain words, no addresses. */
export const CAMERA_HOOKED =
  "Layer 3 not drawn yet: this ROM changes how the camera starts, so the layer's position cannot be worked out"

export interface CameraSpan {
  addr: number
  length: number
}

/** ONE SHA-256 over these three spans joined in order (193 unknown bytes: docs/rom/layer3-world-locked.md). */
export const ENTRANCE_CAMERA_SPANS: readonly CameraSpan[] = [
  { addr: 0x00f6a3, length: 0x38 },
  { addr: 0x00f6db, length: 0x81 },
  { addr: 0x00f8ab, length: 0x34 },
]
export const ENTRANCE_CAMERA_SHA256 =
  'ae28ce36901dc953227a7979c6d0ffa38bc9331d314c8632dbd813a34d320871'

/**
 * The short places are checked by structure (under 24 unknown bytes), one named opcode or operand at a
 * time, read from the ROM: GM11LoadLevel's calls and the LastScreenHoriz store (bank_00.asm:2651-2656), and
 * CODE_00A7B9's CameraMoveTrigger store (5114-5115).
 */
const LOAD_SITE = 0x009705
const TRIGGER_SITE = 0x00a7b9
export interface CameraSetup {
  loadCallOp: number
  loadCallTarget: number
  maxScreensOp: number
  maxScreens: number
  maxScreensStoreOp: number
  maxScreensStore: number
  scrollCallOp: number
  scrollCallTarget: number
  screenScrollOp: number
  updateCallOp: number
  updateCallTarget: number
  updateCallBank: number
  triggerOp: number
  trigger: number
  triggerStoreOp: number
  triggerStore: number
}
const OP_JSR = 0x20
const OP_LDA_IMM = 0xa9
const OP_STA_DP = 0x85
const OP_STA_ABS = 0x8d
const OP_INC_ABS = 0xee
const OP_JSL = 0x22
/** What the stock game has at the two places, one named value per field. */
export const STOCK_CAMERA_SETUP: Readonly<CameraSetup> = {
  loadCallOp: OP_JSR,
  loadCallTarget: 0xa635, // CODE_00A635
  maxScreensOp: OP_LDA_IMM,
  maxScreens: 0x20, // !LevelMaxScreens
  maxScreensStoreOp: OP_STA_DP,
  maxScreensStore: 0x5e, // LastScreenHoriz
  scrollCallOp: OP_JSR,
  scrollCallTarget: 0xa796, // CODE_00A796
  screenScrollOp: OP_INC_ABS, // INC ScreenScrollAtWill
  updateCallOp: OP_JSL,
  updateCallTarget: 0xf6db, // UpdateScreenPosition, bank $00
  updateCallBank: 0x00,
  triggerOp: OP_LDA_IMM,
  trigger: 0x0080,
  triggerStoreOp: OP_STA_ABS,
  triggerStore: 0x142a, // CameraMoveTrigger
}

/**
 * The instructions at the two checked places, field by field. Null when any byte cannot be read: a cut-short
 * ROM is a refusal, never a stock guess.
 */
export function readCameraSetup(rom: RomFile): CameraSetup | null {
  /** One byte, or null past the end of the ROM. */
  const b = (at: number) => rom.readByte(at)
  /** A little-endian operand word, or null when either byte is unreadable. */
  const w = (at: number) => {
    const lo = b(at)
    const hi = b(at + 1)
    return lo === null || hi === null ? null : (hi << 8) | lo
  }
  const s: Record<keyof CameraSetup, number | null> = {
    loadCallOp: b(LOAD_SITE),
    loadCallTarget: w(LOAD_SITE + 1),
    maxScreensOp: b(LOAD_SITE + 3),
    maxScreens: b(LOAD_SITE + 4),
    maxScreensStoreOp: b(LOAD_SITE + 5),
    maxScreensStore: b(LOAD_SITE + 6),
    scrollCallOp: b(LOAD_SITE + 7),
    scrollCallTarget: w(LOAD_SITE + 8),
    screenScrollOp: b(LOAD_SITE + 10),
    updateCallOp: b(LOAD_SITE + 13),
    updateCallTarget: w(LOAD_SITE + 14),
    updateCallBank: b(LOAD_SITE + 16),
    triggerOp: b(TRIGGER_SITE),
    trigger: w(TRIGGER_SITE + 1),
    triggerStoreOp: b(TRIGGER_SITE + 3),
    triggerStore: w(TRIGGER_SITE + 4),
  }
  return Object.values(s).some(v => v === null) ? null : (s as CameraSetup)
}

/** True when every field is the named stock value; a ROM that redirects any call or the trigger fails (D126: no byte runs). */
export const isStockCameraSetup = (s: CameraSetup | null): boolean =>
  !!s && (Object.keys(STOCK_CAMERA_SETUP) as (keyof CameraSetup)[]).every(k => s[k] === STOCK_CAMERA_SETUP[k]) // prettier-ignore

/**
 * Whether the load-time camera code is the stock code: the joined-span digest AND the structural setup. A hack
 * that patches the camera would put the layer at a wrong X with full confidence, so it is refused instead.
 * `spans`, `sha256` and `setup` are parameters so a synthetic ROM can exercise each half.
 */
export function readEntranceCameraGate(
  rom: RomFile,
  spans: readonly CameraSpan[] = ENTRANCE_CAMERA_SPANS,
  sha256: string = ENTRANCE_CAMERA_SHA256,
  setup: CameraSetup | null = readCameraSetup(rom),
): { ok: true } | { ok: false; reason: string } {
  const hash = createHash('sha256')
  for (const span of spans) {
    const bytes = rom.readAt(span.addr, span.length)
    if (!bytes) return { ok: false, reason: CAMERA_HOOKED }
    hash.update(bytes)
  }
  // Known gap (#1127): this checks the GM11 load path's bytes and call sites, not that the game-mode $11
  // vector reaches it. A hack that redirects the vector and leaves the stock loader intact would still get
  // the stock anchor. The reach check is shared with the other loaders and is tracked there.
  if (hash.digest('hex') !== sha256 || !isStockCameraSetup(setup)) {
    return { ok: false, reason: CAMERA_HOOKED }
  }
  return { ok: true }
}

/** The load-time camera X for Mario's start X (stock code; check `readEntranceCameraGate` first). */
export function entranceCameraX(startX: number): number {
  const dist = startX - RIGHT_BUFFER
  return dist > 0 ? Math.min(dist, LOAD_CAMERA_MAX) : 0
}
