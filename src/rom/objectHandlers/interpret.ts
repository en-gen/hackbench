/**
 * interpret.ts -- a bounded interpreter for Layer-1 object handlers (en-gen/hackbench#664).
 *
 * Runs a handler's own bytes from the ROM and returns the tile-buffer writes it
 * makes, in order, or a refusal with a reason. The hand ports in
 * standardHandlers.ts model each SHAPE by hand; this reads it.
 *
 * Bounded, not an emulator. It evaluates only the opcode+mode pairs the vanilla
 * handlers were measured to use (the 65 cases of the switch below), touches
 * only the direct page, a few named WRAM cells, named game-state inputs and
 * the two Map16 buffers, and refuses anything else. Values carry UNKNOWN (null): the interpreter
 * refuses only when an unknown reaches a branch, an index, a pointer or a tile
 * write, which is how the dead `LDA $AA0D` (bank_0D.asm:4031) passes and a
 * real dependence does not.
 *
 * Two primitives, nothing else modelled:
 *   - ExecutePtrLong (bank_00.asm:864-884), recognized by the SHA-256 of its
 *     36 bytes, never by address. Its effect is applied as the routine leaves it.
 *   - MVN, only as a copy inside one Map16 buffer (castle wall, bank_0D.asm:7224).
 * The shared helpers (page select, write+advance, row+1, bookmark, merges) run
 * inline, so a hack that edits one is read as edited.
 *
 * Assumptions, both the game's own: D = $0000, and DB maps $0000-$1FFF to WRAM
 * (the handlers address $1928 with `.W`). DB itself is UNKNOWN, so an absolute
 * read at $2000 or above is unknown and a write there refuses.
 * docs/rom/level-rendering.md, "The L1 handler interpreter".
 */

import type { RomFile } from '../RomFile'
import { fingerprint } from '../Fingerprint'
import { INSN_LEN, M, X } from '../dispatch/HandlerWalk'
import { readLongPointer } from './romData'
import {
  MAP16_BYTES_PER_SCREEN_H,
  SWITCH_FLAGS_UNCLEARED,
  type SwitchFlags,
  type TileGrid,
} from './cursor'

/** CODE_0DA40F / CODE_0DA100 (bank_0D.asm:1319, :1051): what LevLoadNrmObj and
 *  LevLoadExtObj JSL to (bank_05.asm:807, :802). Both select a handler through
 *  ExecutePtrLong, so the dispatch chain is interpreted too. */
export const ENTRY_STANDARD = 0x0da40f
export const ENTRY_EXTENDED = 0x0da100

/** SHA-256 of ExecutePtrLong's 36 bytes on vanilla (bank_00.asm:864-884; one
 *  match in the cart). Stored as a hash: the routine is Nintendo's code. */
export const EXECUTE_PTR_LONG_SHA256 =
  '9269f0bdf61255bd04b61dbb8aa17533389a25d3932f9478941cb387ff736a9d'
const EXECUTE_PTR_LONG_LEN = 36

/** Vanilla's largest in-range run is 99,776 steps and 13,470 writes. */
export const STEP_BUDGET = 250_000
export const WRITE_BUDGET = 16_384

/** Map16TilesLow / Map16TilesHigh ($7EC800 / $7FC800, $3800 bytes each). */
const BUF_LO = 0x7ec800
const BUF_HI = 0x7fc800
const BUF_LEN = 0x3800
const TILE_EMPTY = 0x25

/** The immediate-operand opcodes among the ones the switch in `interpret` evaluates. */
const IMMEDIATE = new Set([0xa9, 0xa2, 0xa0, 0xe0, 0x29, 0x69, 0xc9, 0xe9, 0x09, 0x49])

/** Game-state RAM a handler may read (rammap.asm), each defaulting to 0. */
// prettier-ignore
const GAME_STATE: readonly [number, number][] = [
  [0x13be, 1], [0x13bf, 2], [0x13ce, 1], // ItemMemorySetting, TranslevelNo, MidwayFlag
  [0x19f8, 384], [0x1ea2, 96], // ItemMemoryTable, OWLevelTileSettings
  [0x1f27, 4], [0x1f2f, 12], [0x1f3c, 12], [0x1fee, 12], // switches, coins, 1-ups, moons
]
const SWITCH_BLOCK_FLAGS = 0x1f27
const LEVEL_LOAD_OBJECT = 0x1928 // current screen; ext $01 writes it (bank_0D.asm:1444)
const LEVEL_LOAD_OBJECT_TILE = 0x1ba1
const OBJECT_TILESET = 0x1931

/** The loader's direct-page inputs (bank_05.asm:677-782). */
export interface Placement {
  /** Level-data bytes 0 and 1 (`_A`, `_B`). */
  rawA: number
  rawB: number
  /** LvlLoadObjSize ($59): size for a standard object, the number for an extended one. */
  size: number
  /** LvlLoadObjNo ($5A); 0 for an extended object. */
  objNo: number
  /** LevelLoadPos ($57): row << 4 | column, within the screen half. */
  pos: number
  /** LevelLoadObject ($1928), which the loader also copies to $1BA1. */
  screen: number
  /** Map16LowPtr ($6B) and Map16HighPtr ($6E), 24-bit. */
  lowPtr: number
  highPtr: number
}

/** Named inputs from outside the object, each with an editor default. */
export interface InterpretEnv {
  /** ObjectTileset ($1931). */
  tileset: number
  switchFlags?: SwitchFlags
  /** Any other GAME_STATE byte, by WRAM address. Unset reads are 0. */
  ram?: ReadonlyMap<number, number>
  /** What earlier objects left in the buffer (merge reads). Unset: $25 low, $00 high. */
  prior?: (addr: number) => number | undefined
}

export interface InterpretOptions {
  stepBudget?: number
  writeBudget?: number
  /** Overrides EXECUTE_PTR_LONG_SHA256; synthetic tests pass their own. */
  dispatchFingerprint?: string
}

export interface BufferWrite {
  addr: number
  value: number
}

export interface InterpretResult {
  /** Every buffer write, in order; partial when refused. */
  writes: BufferWrite[]
  /** Each ExecutePtrLong target, in order. The last one is the leaf routine. */
  dispatches: number[]
  steps: number
  refusal: { reason: string; at: number } | null
}

type V = number | null
type Frame = { call: 'jsr' | 'jsl' | 'entry'; ret: number } | { call: null; v: V }

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason)
}
const hex = (v: number, n = 6): string => '$' + v.toString(16).toUpperCase().padStart(n, '0')
const known = (v: V, what: string): number => (v === null ? refuse(`unknown ${what}`) : v)

export function interpret(
  rom: RomFile,
  entry: number,
  place: Placement,
  env: InterpretEnv,
  opts: InterpretOptions = {},
): InterpretResult {
  const stepBudget = opts.stepBudget ?? STEP_BUDGET
  const writeBudget = opts.writeBudget ?? WRITE_BUDGET
  const sig = opts.dispatchFingerprint ?? EXECUTE_PTR_LONG_SHA256
  const flags = env.switchFlags ?? SWITCH_FLAGS_UNCLEARED
  const switches = [flags.green, flags.yellow, flags.blue, flags.red]
  const sigSeen = new Map<number, boolean>()

  const dp: V[] = new Array(256).fill(null)
  const set = (at: number, bytes: number[]) => bytes.forEach((b, i) => (dp[at + i] = b & 0xff))
  set(0x0a, [place.rawA, place.rawB])
  set(0x57, [place.pos])
  set(0x59, [place.size, place.objNo])
  set(0x6b, [place.lowPtr, place.lowPtr >> 8, place.lowPtr >> 16])
  set(0x6e, [place.highPtr, place.highPtr >> 8, place.highPtr >> 16])
  const cells = new Map<number, V>([
    [LEVEL_LOAD_OBJECT, place.screen & 0xff],
    [LEVEL_LOAD_OBJECT_TILE, place.screen & 0xff],
  ])
  const buffer = new Map<number, number>()
  const out: InterpretResult = { writes: [], dispatches: [], steps: 0, refusal: null }

  let aLo: V = place.objNo & 0xff
  let aHi: V = null
  let x: V = null
  let y: V = null
  let db: V = null
  let m8 = true
  let x8 = true
  let n: boolean | null = null
  let z: boolean | null = null
  let c: boolean | null = null
  const stack: Frame[] = [{ call: 'entry', ret: 0 }]

  // ── bus ──
  const romByte = (a: number): number | null => {
    const o = rom.fileOffsetOf(a & 0xffffff)
    return o === null || o >= rom.buffer.length ? null : rom.buffer[o]
  }
  /** WRAM offset of a 24-bit address, or null when it is not WRAM. */
  const wram = (a: number): number | null => {
    const bank = a >>> 16
    const lo = a & 0xffff
    if (bank === 0x7e) return lo
    if (bank === 0x7f) return 0x10000 | lo
    return (bank & 0x7f) < 0x40 && lo < 0x2000 ? lo : null
  }
  const bufferAddr = (w: number): number | null => {
    const a = 0x7e0000 + w
    return (a >= BUF_LO && a < BUF_LO + BUF_LEN) || (a >= BUF_HI && a < BUF_HI + BUF_LEN) ? a : null
  }
  const gameState = (w: number): boolean => GAME_STATE.some(([s, l]) => w >= s && w < s + l)

  /** Executable ROM: backed by the cart, not WRAM, not the $0000-$7FFF system half. */
  const isCode = (a: number): boolean =>
    romByte(a) !== null && wram(a) === null && (a & 0xffff) >= 0x8000
  const read8 = (a: number): V => {
    const w = wram(a)
    if (w === null) return romByte(a) ?? refuse(`read of unmodelled address ${hex(a)}`)
    if (w < 0x100) return dp[w]
    const buf = bufferAddr(w)
    if (buf !== null) return buffer.get(buf) ?? env.prior?.(buf) ?? (buf < BUF_HI ? TILE_EMPTY : 0)
    if (cells.has(w)) return cells.get(w)!
    if (w === OBJECT_TILESET) return env.tileset & 0xff
    if (w >= SWITCH_BLOCK_FLAGS && w < SWITCH_BLOCK_FLAGS + 4)
      return switches[w - SWITCH_BLOCK_FLAGS] ? 1 : 0
    if (gameState(w)) return env.ram?.get(w) ?? 0
    return refuse(`read of unmodelled RAM ${hex(0x7e0000 + w)}`)
  }
  const write8 = (a: number, v: V): void => {
    const w = a < 0 ? null : wram(a)
    if (w !== null && w < 0x100) {
      dp[w] = v
      return
    }
    if (w === LEVEL_LOAD_OBJECT_TILE) {
      cells.set(w, v)
      return
    }
    const buf = w === null ? null : bufferAddr(w)
    if (buf === null) return refuse(`write outside the tile buffer at ${hex(a < 0 ? 0 : a)}`)
    if (v === null) return refuse('unknown value written to the tile buffer')
    if (out.writes.length >= writeBudget) refuse('write budget')
    buffer.set(buf, v)
    out.writes.push({ addr: buf, value: v })
  }
  const read = (a: number, wide: boolean): V => {
    if (a < 0) return null
    const l = read8(a)
    if (!wide) return l
    const h = read8(a + 1)
    return l === null || h === null ? null : l | (h << 8)
  }
  const write = (a: number, v: V, wide: boolean): void => {
    write8(a, v === null ? null : v & 0xff)
    if (wide) write8(a + 1, v === null ? null : (v >> 8) & 0xff)
  }
  /** DB-relative address; -1 stands for "above $1FFF in an unknown bank". */
  const dbAddr = (a16: number): number =>
    db !== null ? ((db << 16) + a16) & 0xffffff : a16 < 0x2000 ? a16 : -1
  const pointer = (d: number, len: 2 | 3): number => {
    let p = 0
    for (let i = 0; i < len; i++)
      p |= known(dp[(d + i) & 0xff], `pointer byte at ${hex(d, 2)}`) << (8 * i)
    return p
  }

  // ── registers ──
  /** The full 16-bit accumulator (B:A), whatever M says. */
  const fullC = (): V => (aLo === null || aHi === null ? null : aLo | (aHi << 8))
  const getA = (): V => (m8 ? aLo : fullC())
  const setA = (v: V): void => {
    aLo = v === null ? null : v & 0xff
    if (!m8) aHi = v === null ? null : (v >> 8) & 0xff
  }
  const nz = (v: V, wide: boolean): void => {
    z = v === null ? null : (v & (wide ? 0xffff : 0xff)) === 0
    n = v === null ? null : (v & (wide ? 0x8000 : 0x80)) !== 0
  }
  const pop = (): Frame => stack.pop() ?? refuse('pull from an empty stack')
  const popByte = (): V => {
    const f = pop()
    return f.call === null ? f.v : refuse('pull of a return address')
  }

  /** ExecutePtrLong, as bank_00.asm:864-884 leaves it: _0-_2 target, _3-_4
   *  return high/bank, _5 and Y the caller's Y, A = target bits 8-23, C clear,
   *  N/Z from `LDY _5`, AXY 8-bit. */
  const dispatch = (jslAt: number): number => {
    if (!x8) refuse('ExecutePtrLong entered with 16-bit index')
    const idx = known(aLo, 'dispatch index')
    const ret = jslAt + 3
    const t = readLongPointer(rom, (ret + 1 + idx * 3) & 0xffffff)
    if (t === null || !isCode(t)) refuse(`dispatch target ${hex(t ?? 0)} is not ROM`)
    set(0, [t!, t! >> 8, t! >> 16, ret >> 8, ret >> 16])
    dp[5] = y === null ? null : y & 0xff
    aLo = (t! >> 8) & 0xff
    aHi = t! >> 16
    m8 = x8 = true
    c = false
    nz(y, false)
    out.dispatches.push(t!)
    return t!
  }
  const isDispatch = (t: number): boolean => {
    let hit = sigSeen.get(t)
    if (hit === undefined) {
      hit = fingerprint(rom.readAt(t, EXECUTE_PTR_LONG_LEN)) === sig
      sigSeen.set(t, hit)
    }
    return hit
  }

  let pc = entry
  try {
    for (;;) {
      if (++out.steps > stepBudget) refuse('step budget')
      if (!isCode(pc)) refuse(`execution left ROM at ${hex(pc)}`)
      const op = romByte(pc)!
      const raw = INSN_LEN[op]
      const len = raw === M ? (m8 ? 2 : 3) : raw === X ? (x8 ? 2 : 3) : raw
      const b: number[] = [op]
      for (let i = 1; i < len; i++)
        b.push(romByte(pc + i) ?? refuse(`execution left ROM at ${hex(pc)}`))
      const next = (pc & 0xff0000) | ((pc + len) & 0xffff)
      const imm = len === 3 ? b[1] | (b[2] << 8) : b[1]
      const abs = b[1] | (b[2] << 8)
      const long = abs | (b[3] << 16)
      const ix = (): number => known(x, 'index X')
      const iy = (): number => known(y, 'index Y')
      const wA = !m8
      const wX = !x8
      /** Effective address of a memory operand, by addressing mode (low 5 opcode bits). */
      // prettier-ignore
      const ea = (): number => {
        switch (op & 0x1f) {
          case 0x04: case 0x05: case 0x06: return b[1] // dp
          case 0x0d: case 0x0e: return dbAddr(abs) // abs
          case 0x1d: return db === null && abs + ix() >= 0x2000 ? -1 : dbAddr(abs + ix()) // abs,X
          case 0x19: return db === null && abs + iy() >= 0x2000 ? -1 : dbAddr(abs + iy()) // abs,Y
          case 0x1f: return (long + ix()) & 0xffffff // long,X
          case 0x17: return (pointer(b[1], 3) + iy()) & 0xffffff // [dp],Y
          case 0x11: return dbAddr(pointer(b[1], 2) + iy()) // (dp),Y
        }
        return refuse(`addressing mode of ${hex(op, 2)}`)
      }
      const operand = (wide: boolean): V => (IMMEDIATE.has(op) ? imm : read(ea(), wide))
      const branch = (cond: boolean | null): number => {
        if (cond === null) refuse('unknown value reached a branch')
        const d = b[1] > 0x7f ? b[1] - 0x100 : b[1]
        return cond ? (pc & 0xff0000) | ((next + d) & 0xffff) : next
      }
      const cmp = (reg: V, wide: boolean): void => {
        const v = operand(wide)
        if (reg === null || v === null) return void (c = n = z = null)
        c = reg >= v
        nz((reg - v) & (wide ? 0xffff : 0xff), wide)
      }
      const step = (r: V, d: number, wide: boolean): V => {
        const v = r === null ? null : (r + d) & (wide ? 0xffff : 0xff)
        nz(v, wide)
        return v
      }

      // The allowed set: the 65 opcode+mode pairs measured on the 147 vanilla
      // entries. Anything else reaches `default` and refuses.
      // prettier-ignore
      switch (op) {
        case 0x10: pc = branch(n === null ? null : !n); continue // BPL
        case 0x30: pc = branch(n); continue // BMI
        case 0xd0: pc = branch(z === null ? null : !z); continue // BNE
        case 0xf0: pc = branch(z); continue // BEQ
        case 0x90: pc = branch(c === null ? null : !c); continue // BCC
        case 0xb0: pc = branch(c); continue // BCS
        case 0x80: pc = branch(true); continue // BRA
        case 0x4c: pc = (pc & 0xff0000) | abs; continue // JMP abs
        case 0x20: // JSR abs
          stack.push({ call: 'jsr', ret: next })
          pc = (pc & 0xff0000) | abs
          continue
        case 0x22: // JSL: only the inline-table dispatch
          if (!isDispatch(long)) refuse(`JSL to ${hex(long)} is not the inline-table dispatch`)
          pc = dispatch(pc)
          continue
        case 0x60: case 0x6b: { // RTS, RTL
          const f = pop()
          const name = op === 0x60 ? 'RTS' : 'RTL'
          if (f.call === null || (f.call !== 'entry' && f.call !== (op === 0x60 ? 'jsr' : 'jsl')))
            refuse(`${name}: return over pushed data or the wrong call kind`)
          if (f.call === 'entry') return out
          pc = (f as { ret: number }).ret
          continue
        }
        case 0x48: // PHA
          if (wA) stack.push({ call: null, v: aHi })
          stack.push({ call: null, v: aLo })
          break
        case 0x68: aLo = popByte(); if (wA) aHi = popByte(); nz(getA(), wA); break // PLA
        case 0x8b: stack.push({ call: null, v: db }); break // PHB
        case 0xab: db = popByte(); nz(db, false); break // PLB
        case 0xc2: case 0xe2: // REP, SEP
          if (b[1] & ~0x30) refuse(`REP/SEP ${hex(b[1], 2)} touches flags other than M/X`)
          if (b[1] & 0x20) m8 = op === 0xe2
          if (b[1] & 0x10) x8 = op === 0xe2
          if (x8) [x, y] = [x === null ? null : x & 0xff, y === null ? null : y & 0xff]
          break
        case 0x54: { // MVN dst,src: a copy inside one Map16 buffer
          if (b[1] !== b[2] || (b[1] !== 0x7e && b[1] !== 0x7f)) refuse('block move outside the tile buffer')
          if (x8) refuse('block move with 8-bit index')
          const count = known(fullC(), 'block move length') + 1
          let [sx, dy] = [ix(), iy()]
          for (let i = 0; i < count; i++) {
            if (++out.steps > stepBudget) refuse('step budget')
            write8((b[1] << 16) | dy, read8((b[2] << 16) | sx))
            sx = (sx + 1) & 0xffff
            dy = (dy + 1) & 0xffff
          }
          ;[x, y, aLo, aHi, db] = [sx, dy, 0xff, 0xff, b[1]]
          break
        }
        case 0x18: c = false; break // CLC
        case 0x38: c = true; break // SEC
        case 0xaa: x = x8 ? aLo : fullC(); nz(x, wX); break // TAX
        case 0xa8: y = x8 ? aLo : fullC(); nz(y, wX); break // TAY
        case 0x8a: setA(x); nz(getA(), wA); break // TXA
        case 0x98: setA(y); nz(getA(), wA); break // TYA
        case 0xe8: x = step(x, 1, wX); break // INX
        case 0xca: x = step(x, -1, wX); break // DEX
        case 0xc8: y = step(y, 1, wX); break // INY
        case 0x88: y = step(y, -1, wX); break // DEY
        case 0xe6: case 0xee: case 0xc6: case 0xce: { // INC, DEC
          const a = ea()
          write(a, step(read(a, wA), op >= 0xe0 ? 1 : -1, wA), wA)
          break
        }
        case 0x0a: case 0x4a: { // ASL A, LSR A
          const v = getA()
          c = v === null ? null : op === 0x0a ? (v & (wA ? 0x8000 : 0x80)) !== 0 : (v & 1) !== 0
          setA(v === null ? null : op === 0x0a ? v << 1 : v >> 1)
          nz(getA(), wA)
          break
        }
        case 0xa9: case 0xa5: case 0xad: case 0xbd: case 0xb9: case 0xbf: case 0xb7: case 0xb1:
          setA(operand(wA)); nz(getA(), wA); break // LDA
        case 0xa2: case 0xa6: case 0xae: x = operand(wX); nz(x, wX); break // LDX
        case 0xa0: case 0xa4: y = operand(wX); nz(y, wX); break // LDY
        case 0x85: case 0x8d: case 0x9d: case 0x97: write(ea(), getA(), wA); break // STA
        case 0x86: write(ea(), x, wX); break // STX
        case 0x84: write(ea(), y, wX); break // STY
        case 0x29: case 0x3f: case 0x09: case 0x49: { // AND, ORA, EOR
          const v = operand(wA)
          const a = getA()
          setA(a === null || v === null ? null : op === 0x09 ? a | v : op === 0x49 ? a ^ v : a & v)
          nz(getA(), wA)
          break
        }
        case 0x69: case 0x7f: case 0x65: case 0xe9: { // ADC, SBC (binary; D is never set)
          const v = operand(wA)
          const a = getA()
          if (a === null || v === null || c === null) {
            setA(null)
            c = n = z = null
            break
          }
          const mask = wA ? 0xffff : 0xff
          const r: number = op === 0xe9 ? a - v - (c ? 0 : 1) : a + v + (c ? 1 : 0)
          c = op === 0xe9 ? r >= 0 : r > mask
          setA(r & mask)
          nz(getA(), wA)
          break
        }
        case 0xc9: case 0xdf: cmp(getA(), wA); break // CMP
        case 0xe0: cmp(x, wX); break // CPX
        default: refuse(`opcode ${hex(op, 2)} is not in the allowed set`)
      }
      pc = next
    }
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    out.refusal = { reason: e.message, at: pc }
    return out
  }
}

/**
 * The loader's inputs for an object on a HORIZONTAL level, where each screen
 * is MAP16_BYTES_PER_SCREEN_H bytes. The game reads that stride from
 * LoadBlkPtrs (bank_05.asm:730); phase 2 should read it too.
 */
export function horizontalPlacement(
  kind: 'standard' | 'extended',
  objectNumber: number,
  settings: number,
  x: number,
  y: number,
): Placement {
  const objNo = kind === 'extended' ? 0 : objectNumber & 0x3f
  const screen = x >> 4
  const half = y >= 16 ? 1 : 0
  const base = screen * MAP16_BYTES_PER_SCREEN_H + half * 0x100
  return {
    rawA: ((objNo & 0x30) << 1) | (half << 4) | (y & 0x0f),
    rawB: ((objNo & 0x0f) << 4) | (x & 0x0f),
    size: (kind === 'extended' ? objectNumber : settings) & 0xff,
    objNo,
    pos: ((y & 0x0f) << 4) | (x & 0x0f),
    screen,
    lowPtr: BUF_LO + base,
    highPtr: BUF_HI + base,
  }
}

/**
 * Apply writes to a grid the way cursor.ts's writeTile stores a tile:
 * (high byte << 8) | low byte, rows growing up to $200 columns.
 */
export function applyWrites(
  grid: TileGrid,
  writes: readonly BufferWrite[],
  stride = MAP16_BYTES_PER_SCREEN_H,
): void {
  for (const { addr, value } of writes) {
    const o = (addr & 0xffff) - (BUF_LO & 0xffff)
    const screen = Math.floor(o / stride)
    const rem = o % stride
    const row = grid[rem >> 4]
    const col = screen * 16 + (rem & 0x0f)
    if (!row || col >= 0x200) continue
    while (row.length < col) row.push(TILE_EMPTY)
    const cell = row[col] ?? TILE_EMPTY
    row[col] = addr >>> 16 === 0x7e ? (cell & ~0xff) | value : (value << 8) | (cell & 0xff)
  }
}
