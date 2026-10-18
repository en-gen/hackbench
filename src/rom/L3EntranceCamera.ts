/**
 * Layer1XPos the moment a level has loaded, which is where a world-locked Layer 3 starts to follow the
 * camera (#563, docs/rom/layer3-world-locked.md). GM11LoadLevel sets LastScreenHoriz to $20
 * (!LevelMaxScreens), runs CODE_00A635, then UpdateScreenPosition once (bank_00.asm:2650-2656), which
 * moves the camera from X 0 toward Mario's start (bank_00.asm:13631-13691).
 *
 * At that call CODE_00A635 has zeroed $13DA-$1410 (bank_00.asm:4943-4946), so CameraScrollPlayerDir is 0
 * and CODE_00F8AB (bank_00.asm:13873-13895) picks Y = $0A with DATA_00F6BF[$0A] = $0002: for a move to
 * the right the +/-1 adjustment never happens. Hence camera = start - $8C (the right buffer,
 * CameraMoveTrigger $80 + $0C) once Mario starts past $8C, else 0, never past (LastScreenHoriz - 1) << 8
 * = $1F00 whatever the map's own length. Captured $1C1: start 792, Layer1XPos 652.
 *
 * That anchor is a DIRECT load (the overworld path, which zeroes Layer1XPos, bank_05.asm:7170). A map
 * entered by a screen exit copies the previous map's camera first (bank_00.asm:2645-2649), so its load
 * camera depends on where the player came from; the caller keeps the entrance-position note on.
 * * The routines and tables are fingerprinted (one digest, structural checks for the short places): a hack that patches the camera gets
 * no anchor.
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

/**
 * ONE SHA-256 over three spans joined in this order, each one the camera rule reads. Unknown bytes (not
 * already spelled in the repo), counted on the working tree:
 *   - DATA_00F6A3..DATA_00F6DA (bank_00.asm:13605-13628), 56 bytes: scroll/cameraMarioX.ts states 28 of them
 *     (F6A3 4, F6B3 entries 0 and 2 4, F6BF offsets 0/2/8/10 8, F6CF 12), so 28 unknown;
 *   - UpdateScreenPosition through CODE_00F75A's branch (13631-13691), 129 bytes: the synthetic loader stand-in
 *     (test/suite/support/syntheticGm11Spans.ts) rebuilds $F6DB-$F6EA, 16 bytes, which also covers the 9 bytes
 *     develop's LevelLoader.ts spells, so 113 unknown;
 *   - CODE_00F8AB..RTS (13873-13895), 52 bytes, all unknown.
 * Total 193, far over the 24 minimum.
 */
export const ENTRANCE_CAMERA_SPANS: readonly CameraSpan[] = [
  { addr: 0x00f6a3, length: 0x38 },
  { addr: 0x00f6db, length: 0x81 },
  { addr: 0x00f8ab, length: 0x34 },
]
export const ENTRANCE_CAMERA_SHA256 =
  'ae28ce36901dc953227a7979c6d0ffa38bc9331d314c8632dbd813a34d320871'

/**
 * The two short places are checked by structure, not by digest (under 24 unknown bytes): one named opcode
 * or operand at a time, read from the ROM. GM11LoadLevel: JSR CODE_00A635, then LDA #!LevelMaxScreens and
 * STA LastScreenHoriz (bank_00.asm:2651-2653); CODE_00A7B9: LDA #$0080, STA CameraMoveTrigger (5114-5115),
 * which sets the $8C buffer.
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
  triggerOp: number
  trigger: number
  triggerStoreOp: number
  triggerStore: number
}
const OP_JSR = 0x20
const OP_LDA_IMM = 0xa9
const OP_STA_DP = 0x85
const OP_STA_ABS = 0x8d
/** What the stock game has at the two places, one named value per field. */
export const STOCK_CAMERA_SETUP: Readonly<CameraSetup> = {
  loadCallOp: OP_JSR,
  loadCallTarget: 0xa635, // CODE_00A635
  maxScreensOp: OP_LDA_IMM,
  maxScreens: 0x20, // !LevelMaxScreens
  maxScreensStoreOp: OP_STA_DP,
  maxScreensStore: 0x5e, // LastScreenHoriz
  triggerOp: OP_LDA_IMM,
  trigger: 0x0080,
  triggerStoreOp: OP_STA_ABS,
  triggerStore: 0x142a, // CameraMoveTrigger
}

/** Null when any byte cannot be read. */
export function readCameraSetup(rom: RomFile): CameraSetup | null {
  const b = (at: number) => rom.readByte(at)
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
    triggerOp: b(TRIGGER_SITE),
    trigger: w(TRIGGER_SITE + 1),
    triggerStoreOp: b(TRIGGER_SITE + 3),
    triggerStore: w(TRIGGER_SITE + 4),
  }
  return Object.values(s).some(v => v === null) ? null : (s as CameraSetup)
}

export const isStockCameraSetup = (s: CameraSetup | null): boolean =>
  !!s && (Object.keys(STOCK_CAMERA_SETUP) as (keyof CameraSetup)[]).every(k => s[k] === STOCK_CAMERA_SETUP[k]) // prettier-ignore

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
