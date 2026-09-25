/**
 * A playable .spc of one source song, booted through the game's own driver.
 *
 * SpcBuilder.ts fakes SMW's init because it knows SMW's addresses. A foreign
 * driver's init is unknown, so here the driver runs its own init from the
 * boot entry instead. The one obstacle: init writes CONTROL ($F1) with the
 * port-clear bits set (SMW APU_Start: `MOV A,#$F0 : MOV $F1,A`,
 * bank_0E.asm:54-55), which would wipe the song command we pre-load into
 * the input port. So the snapshot's copy of that one immediate has bits 4-5
 * cleared. Only the preview copy is patched; nothing exported is.
 *
 * Which port carries the music command is driver-specific and is NOT read
 * from the driver yet: SMW uses port 2 (APU_0BC0, bank_0E.asm:946), later
 * Nintendo drivers commonly port 0. The caller chooses.
 */
import type { SoundImage } from './SourceScan'
import { findAll } from './NspcEngine'

const HEADER = 256
const SIGNATURE = 'SNES-SPC700 Sound File Data v0.30'
const CONTROL_PORT_CLEAR = 0x30

export type SnapshotResult =
  { ok: true; spc: Uint8Array; patchedAt: number[] } | { ok: false; reason: string }

export function defaultCommandPort(image: SoundImage): number {
  return image.engine.dialect === 'earlier' ? 2 : 0
}

export function buildSnapshot(image: SoundImage, command: number, port: number): SnapshotResult {
  const aram = image.aram.slice()

  // `MOV A,#imm : MOV !$00F1,A` and `MOV $F1,#imm`: the immediate is the byte to patch.
  const sites = [
    ...findAll(aram, [0xe8, -1, 0xc5, 0xf1, 0x00]).map(at => at + 1),
    ...findAll(aram, [0x8f, -1, 0xf1]).map(at => at + 1),
  ].filter(at => aram[at] & CONTROL_PORT_CLEAR)
  if (sites.length === 0)
    return {
      ok: false,
      reason: 'no CONTROL write that clears the ports was found; cannot pre-load the song command',
    }
  for (const at of sites) aram[at] &= ~CONTROL_PORT_CLEAR

  // Some drivers start a song by first receiving its data from the SNES
  // (F-Zero: the song start CALLs $11D1, which writes $AA/$BB to the ports
  // and waits for $CC). A snapshot has no SNES to answer, so the driver
  // would wait for ever. The data is already in the image; the CALL is
  // replaced by `MOV A,#song : NOP`, which is what the receiver returns.
  const received = patchReceiverCalls(aram, command)

  // Some song starts take the song number from memory for one command:
  // F-Zero's does `CMP A,#6 : BNE : MOV A,!$07FE`, and each course upload
  // sets $07FE to that course's theme (SNES side, file $0077E0). Only
  // commands 1-7 reach the table directly, since the song tick reads the
  // port as `port & 7`; songs 8 and up exist only through this indirection.
  // Traced (local SPC700 tracer, 4M instructions from boot): command 6 with
  // $07FE = 9, 12 or 16 keys on 91-136 notes across five voices, the block
  // pointer advancing inside that song's own list.
  const indirect = findIndirectSongStart(aram)
  let portValue = command
  if (indirect) {
    aram[indirect.address] = command
    portValue = indirect.command
  }

  aram.fill(0, 0xf0, 0x100)
  aram[0xf4 + port] = portValue

  const spc = new Uint8Array(HEADER + 0x10000 + 128 + 64)
  for (let i = 0; i < SIGNATURE.length; i++) spc[i] = SIGNATURE.charCodeAt(i)
  spc[0x21] = 0x1a
  spc[0x22] = 0x1a
  spc[0x23] = 0x1b // no ID666 tag
  spc[0x24] = 30 // version minor
  spc[0x25] = image.entry & 0xff
  spc[0x26] = image.entry >> 8
  spc[0x2b] = 0xef // SP; the driver sets its own
  spc.set(aram, HEADER)
  return { ok: true, spc, patchedAt: [...sites, ...received] }
}

/** The IPL-style handshake a receiver opens with: `MOV A,#$AA : MOV $F4,A : MOV A,#$BB : MOV $F5,A`. */
const HANDSHAKE = [0xe8, 0xaa, 0xc5, 0xf4, 0x00, 0xe8, 0xbb, 0xc5, 0xf5, 0x00]
/** How far before its table lookup a song start may call the receiver (F-Zero: 14 bytes). */
const RECEIVER_REACH = 24

function patchReceiverCalls(aram: Uint8Array, command: number): number[] {
  const lookups = [
    ...findAll(aram, [0x1c, 0xfd, 0xf6]),
    ...findAll(aram, [0x1c, 0x5d, 0xf5]),
    ...findAll(aram, [0x1c, 0xfd, 0xf5]),
  ]
  const patched: number[] = []
  for (const at of lookups) {
    for (let c = at - 3; c >= at - RECEIVER_REACH && c >= 0; c--) {
      if (aram[c] !== 0x3f) continue
      const target = aram[c + 1] | (aram[c + 2] << 8)
      if (!HANDSHAKE.every((b, i) => aram[target + i] === b)) continue
      aram.set([0xe8, command, 0x00], c)
      patched.push(c)
    }
  }
  return patched
}

/**
 * `CMP A,#k : BNE +3 : MOV A,!abs` within reach of a song start's table
 * lookup. More than one distinct pair is a refusal: we cannot say which runs.
 */
function findIndirectSongStart(aram: Uint8Array): { command: number; address: number } | null {
  const lookups = [
    ...findAll(aram, [0x1c, 0xfd, 0xf6]),
    ...findAll(aram, [0x1c, 0x5d, 0xf5]),
    ...findAll(aram, [0x1c, 0xfd, 0xf5]),
  ]
  const found = new Map<string, { command: number; address: number }>()
  for (const at of lookups) {
    for (let c = at - 7; c >= at - RECEIVER_REACH && c >= 0; c--) {
      if (
        aram[c] === 0x68 &&
        aram[c + 2] === 0xd0 &&
        aram[c + 3] === 0x03 &&
        aram[c + 4] === 0xe5
      ) {
        const hit = { command: aram[c + 1], address: aram[c + 5] | (aram[c + 6] << 8) }
        found.set(`${hit.command}:${hit.address}`, hit)
      }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null
}
