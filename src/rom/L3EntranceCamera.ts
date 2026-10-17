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
 * The routines and tables are fingerprinted like the smash sites: a hack that patches the camera gets
 * no anchor.
 */
import { readL3CodeGate, type CodeSite, type L3CodeGate } from './L3CodeGate'
import type { RomFile } from './RomFile'

const RIGHT_BUFFER = 0x8c
/** (!LevelMaxScreens - 1) << 8, bank_00.asm:2652, 13676-13685 */
const LOAD_CAMERA_MAX = 0x1f00

/**
 * SHA-256 of the stock bytes: DATA_00F6A3..DATA_00F6CF + 12 (bank_00.asm:13605-13628), UpdateScreenPosition
 * through CODE_00F75A's branch (13631-13691), CODE_00F8AB..RTS (13873-13895). The two short sites
 * below are under the 32-byte hash threshold, so `readEntranceCameraGate` compares them byte for byte.
 */
export const ENTRANCE_CAMERA_SITES: readonly CodeSite[] = [
  { addr: 0x00f6a3, length: 0x38, sha256: '307521e5438bf16ab3f015bcfe74b1528a3b721138f35e1ab06d3c5ddbba4482' },
  { addr: 0x00f6db, length: 0x81, sha256: '6186247a0069f82bf2e23520b2edf3ca2e1a4b687dd6617afbf31b7ffb0a3660' },
  { addr: 0x00f8ab, length: 0x34, sha256: 'f6eab3c6fdd58605a6ffcb9f9103b20a17560ac0ae97a78850fc8150eac2690c' },
] // prettier-ignore
// Under the hash threshold, compared byte for byte: GM11's JSR CODE_00A635 / LDA #$20 / STA LastScreenHoriz
// (bank_00.asm:2651-2653), and CODE_00A7B9's LDA #$0080 / STA CameraMoveTrigger (5114-5115), which sets the
// $8C buffer.
const BYTE_SITES = [
  { addr: 0x009705, bytes: [0x20, 0x35, 0xa6, 0xa9, 0x20, 0x85, 0x5e] },
  { addr: 0x00a7b9, bytes: [0xa9, 0x80, 0x00, 0x8d, 0x2a, 0x14] },
] as const

/** The tooltip when the camera code is not stock: plain words, no addresses. */
export const CAMERA_HOOKED =
  "Layer 3 not drawn yet: this ROM changes how the camera starts, so the layer's position cannot be worked out"

export function readEntranceCameraGate(
  rom: RomFile,
  sites: readonly CodeSite[] = ENTRANCE_CAMERA_SITES,
): L3CodeGate {
  for (const site of BYTE_SITES) {
    const got = rom.readAt(site.addr, site.bytes.length)
    if (!got || site.bytes.some((v, i) => got[i] !== v)) return { ok: false, reason: CAMERA_HOOKED }
  }
  const hashed = readL3CodeGate(rom, sites)
  return hashed.ok ? hashed : { ok: false, reason: CAMERA_HOOKED }
}

/** The load-time camera X for Mario's start X (stock code; check `readEntranceCameraGate` first). */
export function entranceCameraX(startX: number): number {
  const dist = startX - RIGHT_BUFFER
  return dist > 0 ? Math.min(dist, LOAD_CAMERA_MAX) : 0
}
