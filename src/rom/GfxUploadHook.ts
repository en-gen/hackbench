/**
 * The hook some hacks put at the `JSL PrepareGraphicsFile` inside
 * UploadGFXFile (bank_00.asm:5402), and whether the file index in Y survives
 * it (#411). Y matters because the dispatch compares it afterwards
 * (bank_00.asm:5403, 5415, 5418); stock PrepareGraphicsFile keeps it with
 * PHY/PLY (bank_00.asm:6573, 6589).
 *
 * Two separate questions, answered from the ROM's bytes without running it:
 *  - Is this a hook we know? A SHA-256 of its entry routine with the
 *    ROM-varying operands zeroed (`HookShape`), since the routine is longer
 *    than the 32 bytes the house rule allows literally.
 *  - Does Y survive it? A static walk of every path to the return (see
 *    `readHookY`). It evaluates no condition, so it reports what some path
 *    does, not what a particular run does.
 * Evidence scope: the entry routine hashed identically on the 4 corpus ROMs
 * that have a hook (corpus only; CI has no ROM and uses synthetic hooks).
 */
import type { RomFile } from './RomFile'
import { mirror } from './addressing'
import { fingerprint } from './Fingerprint'
import { instructionLength } from './dispatch/HandlerWalk'

export interface HookShape {
  /** Bytes from the entry through the final RTL. */
  readonly length: number
  /** Offsets whose value varies between ROMs (call targets, table addresses). */
  readonly wild: readonly number[]
  readonly sha256: string
}

/** The entry routine on the 4 corpus ROMs that carry the hook: 127 bytes,
 *  its four JSR targets and one indexed table address wild. */
export const UPLOAD_HOOK_SHAPES: readonly HookShape[] = [
  {
    length: 127,
    wild: [46, 47, 77, 78, 106, 107, 121, 122, 124, 125],
    sha256: '3ca8f49614ac901ba358e95c5e123ae8f38dd7ec9b3148328c818cb1d5271552',
  },
]

/** SHA-256 of `bytes` with the shape's wild offsets zeroed. */
export function shapeHash(bytes: Uint8Array, wild: readonly number[]): string | null {
  const masked = Uint8Array.from(bytes)
  for (const w of wild) masked[w] = 0
  return fingerprint(masked)
}

export function recognizesHook(
  rom: RomFile,
  entry: number,
  shapes: readonly HookShape[] = UPLOAD_HOOK_SHAPES,
): boolean {
  return shapes.some(s => {
    const b = rom.readAt(mirror(entry), s.length)
    return b !== null && shapeHash(b, s.wild) === s.sha256
  })
}

export type YVerdict =
  { kind: 'kept' } | { kind: 'clobbered'; at: number } | { kind: 'unknown'; reason: string }

// Y state: clean (the entry value), unknown (after a call we could not read),
// dirty (written outside a PHY/PLY pair). Ordered so the worse one wins a join.
type Y = 0 | 1 | 2
type Item = { y: Y | null; m?: boolean; x?: boolean } // y set: a saved Y; else another register
interface State {
  addr: number
  m: boolean
  x: boolean
  y: Y
  at: number
  stack: readonly Item[]
}
interface Summary {
  returns: boolean
  y: Y
  at: number
  flagsKept: boolean
}

const Y_WRITES = new Set([0xa0, 0xa4, 0xac, 0xb4, 0xbc, 0xa8, 0x9b, 0xc8, 0x88, 0x44, 0x54])
const PUSHES = new Set([0x48, 0xda, 0x08, 0x8b, 0x0b, 0x4b])
const POPS = new Set([0x68, 0xfa, 0x28, 0xab, 0x2b])
const BRANCHES = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0])
// Indirect jumps, interrupts, mode switches and stack surgery: not read.
const UNREAD = new Set([0x6c, 0x7c, 0xdc, 0xfc, 0x40, 0x00, 0x02, 0x42, 0xcb, 0xdb, 0xfb])
const UNREAD_STACK = new Set([0x1b, 0x9a, 0xf4, 0xd4, 0x62])

const STATE_BUDGET = 4000
const CALL_DEPTH = 4

/**
 * Does Y survive the routine at SNES `entry`, entered with 8-bit A and index
 * registers (the state UploadGFXFile's stock call runs in)? Y survives when
 * on every path to the return it is never written, or its writes sit between
 * a PHY and its PLY. A call is allowed to the stock PrepareGraphicsFile
 * (`prepareGfx`) or to a routine this walk also clears; any other shape is
 * `unknown`. A write on any path is `clobbered` even if other paths are
 * unread, because the walk refuses either way and the clobber is the reason.
 */
export function readHookY(rom: RomFile, entry: number, prepareGfx: number): YVerdict {
  const notes: string[] = []
  let budget = STATE_BUDGET
  const memo = new Map<string, Summary | null>()
  const stock = mirror(prepareGfx)

  const note = (addr: number, why: string): void => {
    notes.push(`${why} at $${addr.toString(16).toUpperCase().padStart(6, '0')}`)
  }

  function walk(start: number, m: boolean, x: boolean, depth: number): Summary {
    const out: Summary = { returns: false, y: 0, at: 0, flagsKept: true }
    const seen = new Set<string>()
    const todo: State[] = [{ addr: start, m, x, y: 0, at: 0, stack: [] }]
    const bank = (a: number): number => a & 0xff0000
    while (todo.length > 0) {
      const s = todo.pop()!
      const key = `${s.addr}:${s.m}${s.x}${s.y}:${s.stack.map(i => `${i.y ?? 'o'}${i.m ?? ''}`)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (--budget < 0) {
        note(s.addr, 'ran past the walk budget')
        return out
      }
      const head = rom.readAt(mirror(s.addr), 4)
      if (head === null) {
        note(s.addr, 'ran off the ROM')
        continue
      }
      const op = head[0]!
      const len = instructionLength(op, s.m, s.x)
      const next = s.addr + len
      const go = (patch: Partial<State>): void => {
        todo.push({ ...s, addr: next, ...patch })
      }
      const rel8 = (head[1]! << 24) >> 24
      const absTarget = bank(s.addr) | head[1]! | (head[2]! << 8)
      if (UNREAD.has(op) || UNREAD_STACK.has(op)) {
        note(s.addr, `an instruction (opcode $${op.toString(16)}) that is not read`)
      } else if (op === 0xc2 || op === 0xe2) {
        const set = op === 0xe2
        go({
          m: head[1]! & 0x20 ? set : s.m,
          x: head[1]! & 0x10 ? set : s.x,
        })
      } else if (Y_WRITES.has(op)) {
        go({ y: 2, at: s.y === 2 ? s.at : s.addr })
      } else if (op === 0x5a) {
        go({ stack: [...s.stack, { y: s.y }] })
      } else if (op === 0x7a) {
        const top = s.stack[s.stack.length - 1]
        const popped = top?.y ?? null
        go({
          stack: s.stack.slice(0, -1),
          y: popped ?? 2,
          at: popped === null ? s.addr : s.at,
        })
      } else if (PUSHES.has(op)) {
        go({ stack: [...s.stack, op === 0x08 ? { y: null, m: s.m, x: s.x } : { y: null }] })
      } else if (POPS.has(op)) {
        const top = s.stack[s.stack.length - 1]
        if (!top || top.y !== null) note(s.addr, 'a pull that does not match its push')
        else if (op === 0x28) {
          go({ stack: s.stack.slice(0, -1), m: top.m ?? s.m, x: top.x ?? s.x })
        } else go({ stack: s.stack.slice(0, -1) })
      } else if (op === 0x60 || op === 0x6b) {
        if (s.stack.length > 0) note(s.addr, 'a return with something still pushed')
        else {
          out.returns = true
          out.flagsKept &&= s.m === m && s.x === x
          if (s.y > out.y) {
            out.y = s.y
            out.at = s.at
          }
        }
      } else if (op === 0x80 || BRANCHES.has(op)) {
        todo.push({ ...s, addr: next + rel8 })
        if (op !== 0x80) go({})
      } else if (op === 0x82) {
        todo.push({ ...s, addr: ((next + (head[1]! | (head[2]! << 8))) & 0xffff) | bank(s.addr) })
      } else if (op === 0x4c) todo.push({ ...s, addr: absTarget })
      else if (op === 0x5c) todo.push({ ...s, addr: head[1]! | (head[2]! << 8) | (head[3]! << 16) })
      else if (op === 0x20 || op === 0x22) {
        const target = op === 0x20 ? absTarget : head[1]! | (head[2]! << 8) | (head[3]! << 16)
        const sub =
          mirror(target) === stock
            ? { returns: true, y: 0 as Y, at: 0, flagsKept: true }
            : callee(target, s, depth)
        if (sub === null) note(s.addr, 'a call that is not read')
        else if (sub.returns && !sub.flagsKept)
          note(s.addr, 'a call that changes the register widths')
        else if (sub.returns)
          go({ y: Math.max(s.y, sub.y) as Y, at: sub.y === 2 && s.y !== 2 ? sub.at : s.at })
      } else go({})
    }
    return out
  }

  function callee(target: number, s: State, depth: number): Summary | null {
    const key = `${mirror(target)}:${s.m}${s.x}`
    if (memo.has(key)) return memo.get(key)!
    if (depth >= CALL_DEPTH) return null
    memo.set(key, null) // a call cycle is not read
    const r = walk(target, s.m, s.x, depth + 1)
    memo.set(key, r)
    return r
  }

  const top = walk(entry, true, true, 0)
  if (top.returns && top.y === 2) return { kind: 'clobbered', at: top.at }
  if (!top.returns) return { kind: 'unknown', reason: notes[0] ?? 'it never returns' }
  if (notes.length > 0 || top.y === 1) {
    return { kind: 'unknown', reason: notes[0] ?? 'a call it does not read' }
  }
  return { kind: 'kept' }
}
