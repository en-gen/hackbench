/**
 * Reader for the `CMP`/`BNE`/`JSR` handler chains behind SMW's sprite stubs.
 *
 * Lifted unchanged from `feature/generic-sprite-renderer`, apart from its
 * import paths and this note. That branch's fate is undecided; this copy is
 * the one `SpriteTileLoader` depends on.
 *
 * 83 of the 201 MAIN pointer-table entries point at a five-byte
 * `JSL long : RTS` stub rather than at a handler, so the pointer names a
 * shared thunk and not the code that draws. This module reads the chain a
 * thunk leads to and recovers the static id-to-routine mapping.
 *
 * NOT an interpreter. No register state, no branch-condition evaluation, no
 * execution. Every read is a bounded fetch at an offset derived from the
 * previous opcode's own length, every opcode is checked against the one the
 * grammar expects, and a branch displacement is checked for EQUALITY with
 * the link length rather than followed. A byte that is not what the grammar
 * expects produces a refusal naming the address and the opcode found; the
 * reader never guesses past it.
 *
 * The grammar, the four thunks that do NOT match it, and what a hack can
 * still change without this noticing are in
 * `docs/sprites/sprite-dispatch-chains.md`.
 *
 * Evidence scope: grammar derived from `Bnk3CallSprMain`, bank_03.asm:4305
 * to 4525, and confirmed against the raw bytes of all six cart files in
 * the corpus. Static reads only; no emulator was run.
 */

import type { RomFile } from '../RomFile'
import { SPRITE_MAIN_PTR_TABLE, SPRITE_PTR_TABLE_COUNT } from './SpritePointerTables'

// ── Opcodes ─────────────────────────────────────────────────────────────────

const OP_PHB = 0x8b
const OP_PHK = 0x4b
const OP_PLB = 0xab
/** `LDA dp,X`. The chain reads the sprite number through it. */
const OP_LDA_DP_X = 0xb5
const OP_CMP_IMM = 0xc9
const OP_BNE = 0xd0
const OP_BEQ = 0xf0
const OP_JSR = 0x20
const OP_JSL = 0x22
const OP_RTS = 0x60
const OP_RTL = 0x6b

/** Direct-page address of `SpriteNumber`, the operand of the chain's own
 *  `LDA dp,X`. Read as part of the opcode check, so a chain that dispatches
 *  on some other byte is refused instead of mapped. */
const SPRITE_NUMBER_DP = 0x9e

/** Bytes of a `JSL long : RTS` stub. */
const THUNK_LEN = 5
/** Bytes of a chain prologue: `PHB PHK PLB LDA SpriteNumber,X`. */
const PROLOGUE_LEN = 5
/** Bytes a link's `BNE` must skip: `JSR abs` + `PLB` + `RTL`. */
const LINK_TAIL_LEN = 5
/** Bytes a paired link's `BEQ` must skip: `CMP #imm` + `BNE rel`. */
const PAIR_HEAD_LEN = 4

/**
 * Hard ceiling on links walked.
 *
 * The longest vanilla chain is 34 links, so this is generous enough to
 * survive a hack that extends one and tight enough that a corrupted chain
 * terminates instead of running to the end of the bank.
 */
export const MAX_CHAIN_LINKS = 64

// ── Results ─────────────────────────────────────────────────────────────────

/** One matched link: the ids it compares against, and the routine it calls. */
export interface ChainLink {
  /** Sprite ids this link claims. Two for the `CMP/BEQ/CMP/BNE` pair form. */
  readonly ids: readonly number[]
  /** 24-bit address of the `JSR` target, in the chain's own bank. */
  readonly routine: number
  /** Address of the `JSR` itself, so a caller can cite what it read. */
  readonly jsrAt: number
}

/** Why the reader stopped rather than continuing. */
export interface ChainRefusal {
  /** Address of the byte that did not match. */
  readonly at: number
  /** Which link was being read, counting from 0. */
  readonly linkIndex: number
  /** The grammar element expected there. */
  readonly expected: string
  /** What the cart holds, or null when the address is unreadable. */
  readonly found: number | null
}

export type DispatchChainRead =
  | {
      readonly kind: 'chain'
      /** Address of the chain's `PHB`. */
      readonly at: number
      readonly links: readonly ChainLink[]
      /** Address of the block reached when no link matched. */
      readonly fallthroughAt: number
    }
  | { readonly kind: 'refused'; readonly at: number; readonly refusal: ChainRefusal }

/** A `JSL long : RTS` stub found in the MAIN pointer table. */
export interface HandlerThunk {
  /** 24-bit address of the stub. */
  readonly at: number
  /** 24-bit target of its `JSL`. */
  readonly target: number
}

// ── Byte helpers ────────────────────────────────────────────────────────────

function byteAt(rom: RomFile, addr: number): number | null {
  const b = rom.readAt(addr, 1)
  return b ? b[0] : null
}

function toSigned8(b: number): number {
  return b > 0x7f ? b - 0x100 : b
}

/** Target of a two-byte relative branch whose opcode sits at `addr`. */
function branchTarget(rel: number, addr: number): number {
  return (addr & 0xff0000) | ((addr + 2 + toSigned8(rel)) & 0xffff)
}

const refuse = (
  at: number,
  linkIndex: number,
  expected: string,
  found: number | null,
): DispatchChainRead => ({ kind: 'refused', at, refusal: { at, linkIndex, expected, found } })

// ── Thunk ───────────────────────────────────────────────────────────────────

/**
 * Read a `JSL long : RTS` stub at `handlerAddr`, or null when the five bytes
 * there are some other code. Both the `JSL` and the `RTS` are checked: a
 * handler that merely happens to start with a `JSL` is not a stub.
 */
export function readHandlerThunk(rom: RomFile, handlerAddr: number): HandlerThunk | null {
  const b = rom.readAt(handlerAddr, THUNK_LEN)
  if (!b || b[0] !== OP_JSL || b[4] !== OP_RTS) return null
  return { at: handlerAddr, target: b[1] | (b[2] << 8) | (b[3] << 16) }
}

// ── Chain ───────────────────────────────────────────────────────────────────

/**
 * Recover the id-to-routine mapping of a dispatch chain at `chainAt`.
 *
 * Walks at most `MAX_CHAIN_LINKS` links. Each link is read as a fixed
 * sequence of opcodes; the first byte that is not the expected opcode ends
 * the walk with a refusal rather than a guess. The `BNE` displacement is
 * compared against the link's own measured length, so a link with anything
 * inserted into it is refused instead of silently re-cut at the wrong place.
 */
export function readDispatchChain(rom: RomFile, chainAt: number): DispatchChainRead {
  const bank = chainAt & 0xff0000
  const pro = rom.readAt(chainAt, PROLOGUE_LEN)
  if (!pro) return refuse(chainAt, -1, 'chain prologue', null)
  if (pro[0] !== OP_PHB) return refuse(chainAt, -1, 'PHB', pro[0])
  if (pro[1] !== OP_PHK) return refuse(chainAt + 1, -1, 'PHK', pro[1])
  if (pro[2] !== OP_PLB) return refuse(chainAt + 2, -1, 'PLB', pro[2])
  if (pro[3] !== OP_LDA_DP_X) return refuse(chainAt + 3, -1, 'LDA dp,X', pro[3])
  if (pro[4] !== SPRITE_NUMBER_DP) return refuse(chainAt + 4, -1, 'SpriteNumber operand', pro[4])

  const links: ChainLink[] = []
  let p = chainAt + PROLOGUE_LEN

  for (let i = 0; i < MAX_CHAIN_LINKS; i++) {
    // `LDA SpriteNumber,X` reloaded partway down the chain, bank_03.asm:4445.
    // Re-reading the same byte the prologue read changes nothing the reader
    // depends on, so it is stepped over rather than refused.
    const head = rom.readAt(p, 2)
    if (!head) return refuse(p, i, 'link head', null)
    if (head[0] === OP_LDA_DP_X) {
      if (head[1] !== SPRITE_NUMBER_DP) return refuse(p + 1, i, 'SpriteNumber operand', head[1])
      p += 2
    }

    const cmp = rom.readAt(p, 2)
    if (!cmp) return refuse(p, i, 'CMP #imm or fallthrough', null)
    // Anything that is not a compare ends the chain. That block is where an
    // unmatched id lands, and it is reported as an address, not a routine.
    if (cmp[0] !== OP_CMP_IMM) return { kind: 'chain', at: chainAt, links, fallthroughAt: p }

    const ids = [cmp[1]]
    let q = p + 2
    let beqTarget: number | null = null

    // `CMP #a : BEQ hit : CMP #b : BNE next : hit: JSR` shares one routine
    // between two ids, bank_03.asm:4412-4419 and 4476-4483.
    const maybeBeq = rom.readAt(q, 2)
    if (!maybeBeq) return refuse(q, i, 'BNE rel or BEQ rel', null)
    if (maybeBeq[0] === OP_BEQ) {
      beqTarget = branchTarget(maybeBeq[1], q)
      q += 2
      const cmp2 = rom.readAt(q, 2)
      if (!cmp2) return refuse(q, i, 'CMP #imm', null)
      if (cmp2[0] !== OP_CMP_IMM) return refuse(q, i, 'CMP #imm', cmp2[0])
      ids.push(cmp2[1])
      q += 2
    }

    const bne = rom.readAt(q, 2)
    if (!bne) return refuse(q, i, 'BNE rel', null)
    if (bne[0] !== OP_BNE) return refuse(q, i, 'BNE rel', bne[0])
    const bneTarget = branchTarget(bne[1], q)
    q += 2

    const jsr = rom.readAt(q, 3)
    if (!jsr) return refuse(q, i, 'JSR abs', null)
    if (jsr[0] !== OP_JSR) return refuse(q, i, 'JSR abs', jsr[0])
    const jsrAt = q
    const routine = bank | jsr[1] | (jsr[2] << 8)
    q += 3

    const plb = byteAt(rom, q)
    if (plb === null || plb !== OP_PLB) return refuse(q, i, 'PLB', plb)
    q += 1
    const rtl = byteAt(rom, q)
    if (rtl === null || rtl !== OP_RTL) return refuse(q, i, 'RTL', rtl)
    q += 1

    // The two geometry checks. Neither evaluates a condition: each asserts
    // that a displacement already in the cart equals a length this reader
    // measured, which is what makes the id-to-routine pairing structural
    // rather than assumed.
    if (bneTarget !== q) {
      return refuse(
        q - LINK_TAIL_LEN - 2,
        i,
        `BNE skipping ${LINK_TAIL_LEN} bytes to $${q.toString(16)}`,
        bneTarget,
      )
    }
    if (beqTarget !== null && beqTarget !== jsrAt) {
      return refuse(
        jsrAt - PAIR_HEAD_LEN - 2,
        i,
        `BEQ skipping ${PAIR_HEAD_LEN} bytes to $${jsrAt.toString(16)}`,
        beqTarget,
      )
    }

    links.push({ ids, routine, jsrAt })
    p = q
  }

  return refuse(p, MAX_CHAIN_LINKS, `chain end within ${MAX_CHAIN_LINKS} links`, null)
}

// ── Per-sprite resolution ───────────────────────────────────────────────────

export type DispatchResolution =
  /** The MAIN pointer is a handler, not a stub. Nothing to resolve. */
  | { readonly kind: 'direct'; readonly handler: number }
  /** A chain link claims this id. `handler` is the code that draws. */
  | {
      readonly kind: 'dispatched'
      readonly thunk: HandlerThunk
      readonly handler: number
      readonly jsrAt: number
      /** Other ids the SAME link claims, so a caller is told the routine is
       *  still shared rather than being handed a false one-to-one. */
      readonly sharedWith: readonly number[]
    }
  /** No link claims this id, so it reaches the chain's tail block. That
   *  block is not a single `JSR` target, so no routine is reported. */
  | { readonly kind: 'fallthrough'; readonly thunk: HandlerThunk; readonly at: number }
  /** The pointer is a stub but the code behind it is not a chain this
   *  reader's grammar covers. The refusal names the byte that stopped it. */
  | { readonly kind: 'chainRefused'; readonly thunk: HandlerThunk; readonly refusal: ChainRefusal }
  /** The pointer table could not be read for this id. */
  | { readonly kind: 'unreadable' }

/**
 * What code actually draws `spriteId` on the open cart.
 *
 * Reads the MAIN pointer, and where that pointer is a stub, reads the chain
 * behind it. Every branch of the result is derived from cart bytes, so a
 * hack that re-points a chain link changes the answer.
 */
export function resolveDispatch(rom: RomFile, spriteId: number, bank = 0x01): DispatchResolution {
  if (spriteId < 0 || spriteId >= SPRITE_PTR_TABLE_COUNT) return { kind: 'unreadable' }
  const ptr = rom.readAt(SPRITE_MAIN_PTR_TABLE + spriteId * 2, 2)
  if (!ptr) return { kind: 'unreadable' }
  const handlerAddr = (bank << 16) | ptr[0] | (ptr[1] << 8)

  const thunk = readHandlerThunk(rom, handlerAddr)
  if (!thunk) return { kind: 'direct', handler: handlerAddr }

  const chain = readDispatchChain(rom, thunk.target)
  if (chain.kind === 'refused') return { kind: 'chainRefused', thunk, refusal: chain.refusal }

  const link = chain.links.find(l => l.ids.includes(spriteId))
  if (!link) return { kind: 'fallthrough', thunk, at: chain.fallthroughAt }
  return {
    kind: 'dispatched',
    thunk,
    handler: link.routine,
    jsrAt: link.jsrAt,
    sharedWith: link.ids.filter(i => i !== spriteId),
  }
}

/** One line for a tooltip or a warning. */
export function dispatchMessage(r: DispatchResolution): string {
  const hex = (n: number, w = 6) => `$${n.toString(16).toUpperCase().padStart(w, '0')}`
  switch (r.kind) {
    case 'direct':
      return `handler ${hex(r.handler)}`
    case 'dispatched':
      return `dispatched to ${hex(r.handler)} via ${hex(r.thunk.at)}`
    case 'fallthrough':
      return `unmatched by the chain at ${hex(r.thunk.target)}, falls through to ${hex(r.at)}`
    case 'chainRefused':
      return (
        `stub ${hex(r.thunk.at)} leads to ${hex(r.thunk.target)}, which is not a readable chain ` +
        `(expected ${r.refusal.expected} at ${hex(r.refusal.at)}, found ` +
        `${r.refusal.found === null ? 'nothing' : hex(r.refusal.found, 2)})`
      )
    case 'unreadable':
      return 'handler pointer unreadable'
  }
}
