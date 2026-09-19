/**
 * Table-driven sprite draw engine.
 *
 * A faithful, ONCE-ONLY port of SMW's three shared sprite draw routines,
 * parameterised by `SpriteDrawDescriptor` and reading every value from the
 * open ROM. The alternative it replaces is per-sprite TypeScript that
 * hand-encodes what one sprite's handler does, which is pinned to vanilla
 * behaviour and therefore wrong on the romhacks this tool targets.
 *
 * Three design rules, in order of importance:
 *
 * 1. KEY ON THE RESOLVED HANDLER POINTER, NOT THE SPRITE ID. A sprite ID is a
 *    label; the handler is the identity. `resolveIdentity` reads the cart's
 *    own pointer tables and refuses to render confidently when a handler has
 *    been repointed to code we have not traced.
 * 2. READ VALUES FROM THE CART. Descriptors hold addresses. The only literals
 *    are immediate operands, which are code rather than data.
 * 3. DEGRADE HONESTLY. A wrong-but-confident sprite is worse than an admitted
 *    unknown, so every failure mode is a value the caller can render as a
 *    placeholder, never a silent fallback.
 *
 * Evidence scope: static traces against `C:\Projects\SMWDisX` plus the six
 * cart files in `test/roms/`, which hold FIVE distinct carts: `magic.sfc` is
 * `vanilla.sfc` plus a 512-byte copier header. No emulator was run, so nothing here is dynamically
 * verified against live hardware or an accurate emulator.
 */

import type { RomFile } from '../../../RomFile'
import { SPRITE_ANIM_FRAME_STRIDE } from '../../../timing'
import type { SpriteTileTables } from '../../../SpriteTileLoader'
import {
  SPRITE_INIT_PTR_TABLE, SPRITE_MAIN_PTR_TABLE, SPRITE_PTR_TABLE_COUNT,
  SPRITE_DRAW_DESCRIPTORS, SHARED_DRAW_ROUTINES,
  type AnimSource, type AttrOverride, type ByteSource, type CodeRef,
  type DrawRoutine, type ExtraByteSource, type ExtraPart,
  type PaletteSource, type ShiftCount, type SpriteDrawDescriptor, type UnmodelledTailCall,
  type TileNudge, type TileOverride,
} from './SpriteDrawDescriptor'

// ── Hardware / layout constants ─────────────────────────────────────────────

/** OBJ tile 0 lives at hackbench char $400 (`VRAM_CHAR_BASE.sp1`). */
const OBJ_CHAR_BASE = 0x400
/** Chars addressable by an OBJ tile number plus the char-high bit. */
const OBJ_CHAR_MASK = 0x1FF
/** `charHigh` (`SpriteOBJAttribute` bit 0) adds a whole page first. */
const OBJ_CHAR_HIGH = 0x100
/** SNES large-OBJ expansion: base char N covers N, N+1, N+$10, N+$11. */
const LARGE_OBJ_CORNERS = [0x00, 0x01, 0x10, 0x11] as const
/** OAM attribute bit 6, `!OBJ_XFlip`. */
const OBJ_XFLIP = 0x40
/** OAM attribute bit 7, `!OBJ_YFlip`. */
const OBJ_YFLIP = 0x80

/** All 201 sprite handlers live in bank $01: the pointer tables hold 16-bit
 *  addresses and `CallSpriteMain` enters them with a bank-$01 return. */
const SPRITE_HANDLER_BANK = 0x01

/** `LSR A`. A run of these is how 65816 code spells a shift, so counting the
 *  run reads the shift instead of assuming it. */
const OPCODE_LSR_A = 0x4A
/** `JSR addr`. */
const OPCODE_JSR = 0x20
/** `JMP addr`. */
const OPCODE_JMP = 0x4C
/** `CMP #imm`. The terminator of a `dynamicCgram` fade. */
const OPCODE_CMP_IMM = 0xC9
/** `LDA #imm`. A `TileOverride` requires this exact form, so a handler whose
 *  instruction was replaced reads as an unexpected opcode rather than having
 *  its next byte taken as a tile number. */
const OPCODE_LDA_IMM = 0xA9
/** Opcodes a `{ via }` `CodeRef` will hop through. Both are three bytes with
 *  a 16-bit target in the same bank; a longer form would change the
 *  arithmetic, so it is refused rather than guessed at. */
const LINK_OPCODES: readonly number[] = [OPCODE_JSR, OPCODE_JMP]

/** Read-modify-write opcodes a `TileNudge` understands, and the pixel
 *  displacement each one means. `INC abs,X` moves an OAM Y byte DOWN one
 *  pixel; `DEC abs,X` moves it UP. */
const NUDGE_DISPLACEMENT: Readonly<Record<number, number>> = { 0xFE: 1, 0xDE: -1 }

/**
 * Y byte of the FIRST OAM entry the shared draw routines write.
 *
 * `OAMTileYPos` is $0201 and all three routines write their tiles from
 * `+$100` (`STA.W OAMTileYPos+$100,Y`, bank_01.asm:3949). A `TileNudge`'s
 * operand names an absolute address in that buffer, so this is what turns it
 * back into a slot number.
 *
 * RAM layout, not cart data. A hack that moved SMW's sprite OAM window would
 * break this, and the engine would not notice. Named as such in the
 * divergence report rather than left implicit.
 */
const SPRITE_OAM_FIRST_Y = 0x0301

/**
 * Editor animation cadence, converted ONCE, centrally.
 *
 * One editor tick is 8 GAME FRAMES, not one. Every animation in this engine
 * is expressed in game frames and converted here. Counting an animation in
 * ticks, as `SpikeTopAppearance` does, runs it 8x too slow.
 *
 * This was 7.5, back-derived from an uncited 125 ms editor interval. The
 * cadence is now the cited 8 frames (`SPRITE_ANIM_FRAME_STRIDE`), which the
 * shared frame clock realises exactly, so the accumulate-then-floor drift
 * that number carried is gone rather than bounded.
 */
export const ROM_FRAMES_PER_TICK = SPRITE_ANIM_FRAME_STRIDE

// ── Render context ──────────────────────────────────────────────────────────

/**
 * Live inputs resolved at RENDER time, not baked in at construction.
 *
 * Mario's position is the first such input and probably not the last, which
 * is why this is a small explicit object rather than one more argument
 * threaded through every signature. Changing `marioX` must cost one flip
 * recomputation per sprite: no appearance rebuild, no ROM re-read, no GFX
 * re-decode.
 *
 * Caveat, stated rather than solved: `marioX` normally comes from the level's
 * MAIN entrance, but a map can be entered from a midway point, a pipe, or a
 * door in another map, and facing in play depends on where Mario actually is.
 * Deriving from the main entrance is right for a static editor view and is an
 * approximation of gameplay. Making the position a runtime input is what lets
 * "which entrance am I previewing from" become a UI choice later instead of a
 * wrong assumption baked into the data now.
 */
export interface SpriteRenderContext {
  /** Mario's X in level pixels. */
  marioX: number
  /** Free-running game-frame counter, standing in for `EffFrame` ($14). */
  romFrame: number
}

/**
 * Level-scoped inputs a sprite's appearance depends on but does not own.
 *
 * `loadedChars` is the whole of it. A `spriteSet` field was here too, never
 * read by anything: the level's SP1-SP4 assignment reaches the engine
 * already resolved, as the set of chars it produced, and carrying the
 * selector as well invited a second, divergent resolution of the same thing.
 */
export interface SpriteLevelContext {
  /** Chars actually present in this level's OBJ VRAM, by flat char number.
   *  A sprite whose chars are absent is reported, not rendered as garbage. */
  loadedChars: ReadonlySet<number>
}

// ── Output ──────────────────────────────────────────────────────────────────

/** One 8x8 output subtile. Deliberately the same shape as `SpriteSubtile`
 *  in `SpriteTileLoader`, so the equivalence harness can compare directly. */
export interface EnginePart {
  charNum: number
  /** CGRAM row, 8..15 for OBJ palettes. */
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
}

/** Why a sprite could not be rendered confidently. */
export type EngineFailure =
  /** No descriptor has been traced for this sprite ID yet. */
  | { kind: 'noDescriptor'; spriteId: number }
  /** The cart's handler pointer differs from the traced one and does not
   *  match any other descriptor's handler, so we are looking at code nobody
   *  has read. The editor must show "custom handler, appearance unverified". */
  | { kind: 'customHandler'; spriteId: number; expected: number; found: number; table: 'main' | 'init' }
  /** The sprite's chars are not in this level's sprite set. Produced by
   *  `renderSpriteFrame` ONLY, the picker and annotation path; the MAP
   *  render substitutes a placeholder per missing char instead. See
   *  `EngineSpriteAppearance.render` for why the two differ. */
  | { kind: 'charsNotLoaded'; spriteId: number; missing: number[] }
  /** A ROM read fell off the cart. */
  | { kind: 'romReadFailed'; spriteId: number; addr: number }
  /** An opcode at an offset the descriptor names is not the instruction that
   *  kind requires, so the handler has been REWRITTEN rather than retuned and
   *  the engine cannot say what it now does. */
  | { kind: 'unexpectedOpcode'; spriteId: number; addr: number; expected: readonly number[]; found: number }
  /** The handler's `JSR` enters code that is not one of the three shared draw
   *  routines. */
  | { kind: 'unknownDrawRoutine'; spriteId: number; target: number }
  /** A `TileNudge`'s operand names an OAM entry the resolved routine never
   *  wrote, so the descriptor and the handler disagree about what ran. Not a
   *  read failure: the bytes were there and said something impossible. */
  | { kind: 'nudgeTargetOutOfRange'; spriteId: number; slot: number; routine: DrawRoutine }
  /** The handler draws its body through a shared routine and THEN calls code
   *  this engine has no kind for, so the body on its own would be a
   *  confident but incomplete sprite. `KoopaWingGfxRt` is the case that
   *  exists today: see `UnmodelledTailCall`. */
  | { kind: 'unmodelledTailCall'; spriteId: number; routineName: string; addr: number }

export type EngineResult =
  | { ok: true; parts: EnginePart[]; identity: SpriteIdentity; paletteNote?: PaletteNote }
  | { ok: false; failure: EngineFailure; identity?: SpriteIdentity }

/** Something the caller must know about the palette to draw it correctly. */
export interface PaletteNote {
  /** The sprite's colours are written to CGRAM at runtime, and only PART of
   *  the row is overwritten, so the caller must composite: dynamic colours
   *  for `[firstCol, firstCol + colors)`, level palette for the rest. */
  kind: 'dynamicCgram'
  row: number
  firstCol: number
  colors: number
  /** Address of the resting entry's colour data, resolved from the cart. */
  entryAddr: number
}

// ── Identity ────────────────────────────────────────────────────────────────

export interface SpriteIdentity {
  spriteId: number
  mainHandler: number
  initHandler: number
  /** 'vanilla' = both pointers match the traced ones.
   *  'custom'  = either pointer differs, so this cart runs code we have not
   *  traced for this sprite and the engine declines. */
  status: 'vanilla' | 'custom'
  /** Set when the repointed MAIN handler is one ANOTHER descriptor traces.
   *  Diagnostic only: the status is still 'custom' and the engine still
   *  declines. See `resolveIdentity`. */
  aliasOf?: number
}

function readWord(rom: RomFile, addr: number): number | null {
  const b = rom.readAt(addr, 2)
  return b ? b[0] | (b[1] << 8) : null
}

/** Read a sprite's MAIN and INIT handler pointers from the open cart. */
export function readHandlerPointers(
  rom: RomFile, spriteId: number,
): { main: number; init: number } | null {
  if (spriteId < 0 || spriteId >= SPRITE_PTR_TABLE_COUNT) return null
  const main = readWord(rom, SPRITE_MAIN_PTR_TABLE + spriteId * 2)
  const init = readWord(rom, SPRITE_INIT_PTR_TABLE + spriteId * 2)
  return main === null || init === null ? null : { main, init }
}

/**
 * Resolve who this sprite actually IS on the open cart.
 *
 * Measured on the five-cart corpus: the MAIN table is byte-identical in all
 * six files, and the INIT table has three repointed entries, at $52, $53
 * and $9B, none of them a descriptor sprite.
 *
 * ANY pointer mismatch is 'custom'. A 'remapped' status used to sit between,
 * promising a render through the aliased descriptor that was never
 * implemented; `aliasOf` replaces it as a pure diagnostic. The
 * `ptrs.main !== own.vanillaMainHandler` guard is load-bearing, because $4D
 * and $4E share handler $E2CF (bank_01.asm:13388) and without it a $4D whose
 * INIT alone moved would report itself aliased onto $4E.
 */
export function resolveIdentity(
  rom: RomFile,
  spriteId: number,
  descriptors: readonly SpriteDrawDescriptor[] = SPRITE_DRAW_DESCRIPTORS,
): SpriteIdentity | null {
  const ptrs = readHandlerPointers(rom, spriteId)
  if (!ptrs) return null
  const own = descriptors.find(d => d.spriteId === spriteId)
  if (!own) {
    return { spriteId, mainHandler: ptrs.main, initHandler: ptrs.init, status: 'custom' }
  }
  if (ptrs.main === own.vanillaMainHandler && ptrs.init === own.vanillaInitHandler) {
    return { spriteId, mainHandler: ptrs.main, initHandler: ptrs.init, status: 'vanilla' }
  }
  // A repoint onto another sprite's known vanilla handler is still a repoint.
  // Naming the target is useful to whoever has to look at it; it does not
  // make the sprite renderable.
  const alias = descriptors.find(d => d.vanillaMainHandler === ptrs.main && d.spriteId !== spriteId)
  const base = { spriteId, mainHandler: ptrs.main, initHandler: ptrs.init, status: 'custom' as const }
  return alias && ptrs.main !== own.vanillaMainHandler ? { ...base, aliasOf: alias.spriteId } : base
}

// ── Argument resolution ─────────────────────────────────────────────────────

/**
 * Base a descriptor's `{ mainOff }` refs are measured from: the MAIN handler
 * pointer THE CART HOLDS for this sprite, in bank $01.
 *
 * This is what makes a relocated handler keep rendering. A hack that moves
 * the code and repoints the table moves every offset with it; an absolute
 * address would read whatever now occupies the old location and say nothing.
 *
 * Falls back to the descriptor's vanilla pointer when the table cannot be
 * read at all, which is the case for synthetic fixtures that have no pointer
 * table. Those use absolute refs, so the fallback never decides anything.
 *
 * Costs ONE word read per draw, deliberately not cached here: the engine's
 * entry points are pure functions of the open cart, and a cache keyed on a
 * `RomFile` identity is the kind of thing that goes stale silently.
 */
export function resolveHandlerBase(rom: RomFile, d: SpriteDrawDescriptor): number {
  const main = readWord(rom, SPRITE_MAIN_PTR_TABLE + d.spriteId * 2)
  return (SPRITE_HANDLER_BANK << 16) | ((main ?? d.vanillaMainHandler) & 0xFFFF)
}

/**
 * A `CodeRef` as a 24-bit address.
 *
 * Null when a `{ via }` hop's opcode is not a `JSR` or `JMP`, which means
 * the handler has been REWRITTEN at that point rather than relocated, and
 * the descriptor's account of where its draw code lives no longer holds.
 * Silently reading the bytes that happen to be there would render a sprite
 * out of an instruction nobody traced.
 */
export function resolveRef(rom: RomFile, ref: CodeRef, handlerBase: number): number | null {
  if (typeof ref === 'number') return ref
  if ('mainOff' in ref) return handlerBase + ref.mainOff
  const at = resolveRef(rom, ref.via, handlerBase)
  if (at === null) return null
  const b = rom.readAt(at, 3)
  if (!b || !LINK_OPCODES.includes(b[0])) return null
  // The target is 16-bit, so it stays in the bank the link itself is in.
  return (at & 0xFF0000) | (((b[1] | (b[2] << 8)) + ref.off) & 0xFFFF)
}

function readRefByte(rom: RomFile, ref: CodeRef, handlerBase: number): number | null {
  const at = resolveRef(rom, ref, handlerBase)
  if (at === null) return null
  const b = rom.readAt(at, 1)
  return b ? b[0] : null
}

/**
 * Count the run of `LSR A` opcodes that performs a shift.
 *
 * Bounded by `max`, so this is a fixed-length read at a known offset and not
 * a trace. A run at least `max` long reads as `max`, which is why `max` is
 * set past any shift that means anything on an 8-bit accumulator.
 */
export function readShiftCount(rom: RomFile, sc: ShiftCount, handlerBase: number): number | null {
  const at = resolveRef(rom, sc.scan, handlerBase)
  const b = at === null ? null : rom.readAt(at, sc.max)
  if (!b) return null
  let n = 0
  while (n < sc.max && b[n] === OPCODE_LSR_A) n++
  return n
}

/** Resolve the operand of an absolute-addressed instruction into a full
 *  24-bit address. `size` is 2 for `LDA abs,Y`, 3 for `LDA.L long,X`. */
function resolveOperand(rom: RomFile, operandAddr: number | null, size: 2 | 3, bank: number): number | null {
  const b = operandAddr === null ? null : rom.readAt(operandAddr, size)
  if (!b) return null
  return size === 2
    ? (bank << 16) | b[0] | (b[1] << 8)
    : b[0] | (b[1] << 8) | (b[2] << 16)
}

/**
 * Read a byte source, or null when the cart cannot supply it.
 *
 * `immediate` is the only kind that can fail on an OPCODE rather than an
 * address: it requires the `LDA #imm` the descriptor names to still be
 * there, so a rewritten handler is refused instead of having an arbitrary
 * byte read as a tile or prop group.
 */
function readByteSource(
  rom: RomFile, src: ByteSource, frame: number, handlerBase: number,
): number | null {
  if (src.kind === 'const') return src.value
  if (src.kind === 'frameIndex') return frame
  if (src.kind === 'immediate') {
    const at = resolveRef(rom, src.insnAddr, handlerBase)
    const b = at === null ? null : rom.readAt(at, 2)
    return b && b[0] === OPCODE_LDA_IMM ? b[1] : null
  }
  const addr = src.kind === 'table'
    ? src.addr
    : resolveOperand(rom, resolveRef(rom, src.operandAddr, handlerBase), 2, src.operandBank)
  if (addr === null) return null
  if (src.kind === 'shiftedTable') {
    const shift = readShiftCount(rom, src.shift, handlerBase)
    if (shift === null) return null
    const b = rom.readAt(addr + (frame >> shift), 1)
    if (!b) return null
    if (!src.orBit) return b[0]
    const orShift = readShiftCount(rom, src.orBit.shift, handlerBase)
    const mask = readRefByte(rom, src.orBit.maskAddr, handlerBase)
    if (orShift === null || mask === null) return null
    return b[0] | ((frame >> orShift) & mask)
  }
  const b = rom.readAt(addr + frame, 1)
  return b ? b[0] : null
}

/** Two's-complement byte as a signed pixel displacement. */
function toSigned8(b: number): number {
  return b >= 0x80 ? b - 0x100 : b
}

/** Read one byte an extra part needs. Raw: the caller sign-extends offsets. */
function readExtraByte(
  rom: RomFile, src: ExtraByteSource, misc157C: number, handlerBase: number,
): number | null {
  if (src.kind === 'const') return src.value
  const addr = src.kind === 'immediateAt'
    ? resolveRef(rom, src.addr, handlerBase)
    : resolveOperand(rom, resolveRef(rom, src.operandAddr, handlerBase), 2, src.operandBank)
  if (addr === null) return null
  const b = rom.readAt(src.kind === 'immediateAt' ? addr : addr + (misc157C & 1), 1)
  return b ? b[0] : null
}

/**
 * The seed of a `stateTimer` animation, read from the cart.
 *
 * Returns null for every other animation kind, and for a read that falls off
 * the cart. A seed of 0 would mean a state that ends on the frame it starts,
 * which no handler writes, so 0 is also treated as unusable.
 */
export function resolveStateTimerSeed(
  rom: RomFile, anim: AnimSource, handlerBase: number,
): number | null {
  if (anim.kind !== 'stateTimer') return null
  const b = readRefByte(rom, anim.seedOperandAddr, handlerBase)
  return b !== null && b !== 0 ? b : null
}

/**
 * Replace a `spriteCounter`'s shift and mask with the cart's own.
 *
 * Returns a NEW `AnimSource` rather than extra arguments to every consumer,
 * so `frameIndexAt` and `animPeriodFrames` stay pure functions of a plain
 * value and every existing caller keeps working. An animation with no cart
 * refs comes back unchanged.
 *
 * `SetAnimationFrame` (bank_01.asm:2089-2097) is SHARED code, so a
 * descriptor cannot name it by a handler offset. It names the handler's own
 * `JSR` to it instead and hops through the target, which also means a hack
 * that repoints `SetAnimationFrame` is followed rather than missed.
 */
export function resolveAnim(
  rom: RomFile, anim: AnimSource, handlerBase: number,
): AnimSource | null {
  if (anim.kind !== 'spriteCounter') return anim
  if (!anim.shiftAt && !anim.maskAt) return anim
  const shift = anim.shiftAt ? readShiftCount(rom, anim.shiftAt, handlerBase) : anim.shift
  const mask = anim.maskAt ? readRefByte(rom, anim.maskAt, handlerBase) : anim.mask
  if (shift === null || mask === null) return null
  return { kind: 'spriteCounter', shift, mask }
}

/**
 * Frame index for a given game frame.
 *
 * Expressed in GAME frames throughout; callers convert editor ticks with
 * `ROM_FRAMES_PER_TICK`. `spriteCounter` shares the arithmetic with
 * `effFrame` because `SetAnimationFrame` applies the same shift-and-mask; the
 * difference is that its counter is per-sprite, so the PHASE is unknowable in
 * a static editor while the PERIOD is exact.
 */
export function frameIndexAt(anim: AnimSource, romFrame: number, seed = 0): number {
  if (anim.kind === 'static') return 0
  if (anim.kind === 'stateTimer') {
    // The timer counts DOWN, so a rising game-frame count walks the index
    // from `seed` to 0. A seed we could not read leaves the sprite on the
    // pose the timer starts at rather than animating it wrongly.
    if (seed <= 0) return 0
    return seed - (Math.floor(romFrame) % (seed + 1))
  }
  return (Math.floor(romFrame) >> anim.shift) & anim.mask
}

/** Animation period in game frames. `0` for a static sprite. */
export function animPeriodFrames(anim: AnimSource, seed = 0): number {
  if (anim.kind === 'static') return 0
  if (anim.kind === 'stateTimer') return seed <= 0 ? 0 : seed + 1
  return (anim.mask + 1) << anim.shift
}

/**
 * The game frame at which `frameIndexAt` returns `frame`. Inverse of the
 * above.
 *
 * Any caller that pairs `forceFrame` with a `romFrame` MUST use this. An
 * `attrOverride` is driven by `romFrame` and not by `forceFrame`, so a
 * harness that asks for frame N while holding `romFrame` at 0 gets frame N's
 * TILES with frame 0's attribute. For $4E, whose four poses are the flip
 * bits rotating and whose tile group is pinned, that collapses all four
 * frames onto one. Exported for that reason.
 */
export function romFrameForFrame(anim: AnimSource, frame: number, seed = 0): number {
  if (anim.kind === 'static') return 0
  if (anim.kind === 'stateTimer') return seed <= 0 ? 0 : seed - frame
  return frame << anim.shift
}

/**
 * Resolve `SpriteMisc157C`, the direction latch both `SubSprGfx1` and
 * `SubSprGfx2Entry1` read to decide X-flip.
 *
 * `SubHorizPos` (bank_01.asm:6124) returns Y = 0 when Mario is at or to the
 * RIGHT of the sprite and Y = 1 when he is to the left; `FaceMario`
 * (bank_01.asm:847) stores that Y straight into `SpriteMisc157C`.
 */
export function resolveMisc157C(
  src: SpriteDrawDescriptor['misc157C'], spriteX: number, marioX: number,
): number {
  switch (src.kind) {
    case 'const':     return src.value
    case 'unwritten': return 0
    case 'faceMario': return marioX >= spriteX ? 0 : 1
  }
}

/**
 * X-flip from the direction latch.
 *
 * The polarity is counterintuitive and is the root of the `flipX: false`
 * defect. In both routines the sequence is `LDA SpriteMisc157C,X / LSR A /
 * ... / BCS + / ORA #!OBJ_XFlip`, so the branch SKIPS the flip when bit 0 is
 * SET. X-flip is therefore applied when the latch is CLEAR, and a sprite
 * whose handler never writes the latch renders FLIPPED, not unflipped.
 *
 * `SubSprGfx2Entry1` uses `EOR` rather than `ORA` (bank_01.asm:4171), so for
 * that routine the flip TOGGLES any flip bit the handler already set in
 * `SpriteOBJAttribute` instead of forcing it on.
 */
function xflipFromLatch(misc157C: number, attr: number, routine: 'sub1' | 'sub2'): boolean {
  const latchClear = (misc157C & 1) === 0
  const attrFlip = (attr & OBJ_XFLIP) !== 0
  if (!latchClear) return attrFlip
  return routine === 'sub2' ? !attrFlip : true
}

// ── Palette ─────────────────────────────────────────────────────────────────

/**
 * Which entry of a `dynamicCgram` fade this cart actually leaves in CGRAM.
 *
 * The fade ends on a `CMP #imm` that branches PAST the upload, so entries
 * `0 .. imm - 2` are written and `imm - 2` is left standing.
 *
 * FALLS BACK to the descriptor's literal rather than failing, because the
 * colours are a still editor's approximation of a runtime DMA either way and
 * declining would lose a sprite the engine otherwise renders correctly.
 * Divergence report 11.3.
 */
function resolveRestingEntry(
  rom: RomFile, src: Extract<PaletteSource, { kind: 'dynamicCgram' }>, handlerBase: number,
): number {
  if (src.restingEntryCmpAddr === undefined) return src.restingEntry
  const at = resolveRef(rom, src.restingEntryCmpAddr, handlerBase)
  const b = at === null ? null : rom.readAt(at, 2)
  if (!b || b[0] !== OPCODE_CMP_IMM) return src.restingEntry
  const entry = b[1] - 2
  return entry < 0 || entry >= src.entryCount ? src.restingEntry : entry
}

/** Palette row and char-high bit, plus any compositing note. */
interface ResolvedPalette { row: number; charHigh: number; attr: number; note?: PaletteNote }

/**
 * The sprite defines its palette; the level palette is only a fallback.
 *
 * Three sources, in the order the hardware establishes them:
 *  a. `Sprite166EVals` -> `SpriteOBJAttribute` at spawn.
 *  b. An override written by the sprite's INIT routine, which never draws and
 *     is therefore easy to skip.
 *  c. A runtime DMA into CGRAM, which may overwrite only PART of a row, so
 *     the caller must composite the untouched columns from the level palette.
 */
function resolvePalette(
  rom: RomFile, tables: SpriteTileTables, desc: SpriteDrawDescriptor,
  spriteX: number, handlerBase: number,
): ResolvedPalette | null {
  const src: PaletteSource = desc.palette
  let attr = tables.spriteAttr[desc.spriteId] ?? 0

  if (src.kind === 'initTableByX') {
    const tableAddr = resolveOperand(rom, resolveRef(rom, src.operandAddr, handlerBase), 2, src.operandBank)
    if (tableAddr === null) return null
    const idx = (spriteX >> src.shift) & src.mask
    if (idx >= src.entries) return null
    const b = rom.readAt(tableAddr + idx, 1)
    if (!b) return null
    attr = b[0] & 0x0F
  }

  const base: ResolvedPalette = {
    row: 8 + ((attr >> 1) & 0x07),
    charHigh: (attr & 0x01) !== 0 ? OBJ_CHAR_HIGH : 0,
    attr,
  }

  if (src.kind === 'dynamicCgram') {
    const tableAddr = resolveOperand(rom, resolveRef(rom, src.operandAddr, handlerBase), 3, 0)
    if (tableAddr === null) return null
    const row = src.cgramStart >> 4
    const firstCol = src.cgramStart & 0x0F
    const entry = resolveRestingEntry(rom, src, handlerBase)
    return {
      ...base,
      row,
      note: {
        kind: 'dynamicCgram', row, firstCol, colors: src.colorsPerEntry,
        entryAddr: tableAddr + entry * src.colorsPerEntry * 2,
      },
    }
  }
  return base
}

// ── Routine ports ───────────────────────────────────────────────────────────

/**
 * Chars the handler writes over the routine's own, keyed by the OAM slot
 * each names. Empty for all but one descriptor.
 */
type TileOverrides = ReadonlyMap<number, number>

/** No override, shared so the common path allocates nothing. */
const NO_TILE_OVERRIDES: TileOverrides = new Map()

/**
 * Read each `TileOverride`'s replacement char out of the cart.
 *
 * Resolved BEFORE the routine runs although the ROM writes it after: the
 * char must pass through the same large-OBJ corner expansion the routine's
 * own tile does, and undoing the flip permutation afterwards would be worse.
 * A slot the routine never writes overrides nothing.
 */
function readTileOverrides(
  rom: RomFile, ovs: readonly TileOverride[], spriteId: number, handlerBase: number,
): { map: TileOverrides; failure?: undefined } | { map?: undefined; failure: EngineFailure } {
  const map = new Map<number, number>()
  for (const ov of ovs) {
    const at = resolveRef(rom, ov.insnAddr, handlerBase)
    const b = at === null ? null : rom.readAt(at, 2)
    if (at === null || !b) return { failure: { kind: 'romReadFailed', spriteId, addr: at ?? 0 } }
    if (b[0] !== OPCODE_LDA_IMM) {
      return {
        failure: {
          kind: 'unexpectedOpcode', spriteId, addr: at,
          expected: [OPCODE_LDA_IMM], found: b[0],
        },
      }
    }
    map.set(ov.oamSlot, b[1])
  }
  return { map }
}

/**
 * OAM slot the Nth corner of a `sub0` draw is written to.
 *
 * `SubSprGfx0Entry0` counts its corner index `_4` DOWN from $03
 * (bank_01.asm:3874, 3904-3905) while the OAM index counts UP
 * (bank_01.asm:3900-3903), so OAM slot 0 holds corner 3. `drawSub0` emits in
 * corner order, matching the positions and the shipped path, so the reversal
 * lives here. `sub1` and `sub2` emit in OAM order and need no mapping.
 */
const SUB0_CORNERS = 4
function sub0SlotForCorner(corner: number): number {
  return (SUB0_CORNERS - 1 - corner) * 4
}

/**
 * Part indices an OAM slot names, for a routine's OWN entries.
 *
 * Null when the slot is not one the routine wrote: not four-byte aligned,
 * negative, or past its last entry. A descriptor and a handler disagreeing
 * about what ran is reported, not silently ignored.
 */
function partsForSlot(
  routine: DrawRoutine, slot: number, partCount: number,
): number[] | null {
  if (slot < 0 || (slot & 3) !== 0) return null
  const per = ROUTINE_PARTS_PER_ENTRY[routine]
  const entry = slot >> 2
  if (routine === 'sub0') {
    // One 8x8 per entry, and the corner order is reversed.
    const corner = SUB0_CORNERS - 1 - entry
    return corner < 0 || corner >= partCount ? null : [corner]
  }
  const first = entry * per
  return first + per > partCount ? null : Array.from({ length: per }, (_, i) => first + i)
}

/**
 * `SubSprGfx0Entry0` - bank_01.asm:3853.
 *
 * Four INDEPENDENT 8x8 chars, not a hardware large OBJ:
 *   `_2   = SprTilemapOffset[id] + SpriteMisc1602 * 4`
 *   tile  = `SprTilemap[_2 + corner]`
 *   attr  = `GeneralSprGfxProp[propGroup * 4 + corner] | SpriteOBJAttribute`
 *   pos   = `GeneralSprDispX/Y[corner]`
 * with corner counting 3 down to 0, which indexes all four tables alike.
 * Bit 6 of the prop byte is X-flip and bit 7 is Y-flip, per corner.
 */
function drawSub0(
  tables: SpriteTileTables, tilemapBase: number, misc1602: number,
  propGroup: number, pal: ResolvedPalette, ov: TileOverrides,
): EnginePart[] {
  const parts: EnginePart[] = []
  for (let corner = 0; corner < 4; corner++) {
    const tile = ov.get(sub0SlotForCorner(corner)) ?? tables.tilemap[tilemapBase + misc1602 * 4 + corner] ?? 0
    const prop = tables.gfxProp[propGroup * 4 + corner] ?? 0
    parts.push({
      charNum: OBJ_CHAR_BASE + pal.charHigh + (tile & OBJ_CHAR_MASK),
      palette: pal.row,
      flipX: (prop & OBJ_XFLIP) !== 0,
      flipY: (prop & OBJ_YFLIP) !== 0,
      dx: tables.dispX[corner] ?? 0,
      dy: tables.dispY[corner] ?? 0,
    })
  }
  return parts
}

/** Expand one hardware large OBJ into its four 8x8 corners. */
function largeObj(
  baseTile: number, pal: ResolvedPalette, flipX: boolean, flipY: boolean,
  baseDx: number, baseDy: number, tables: SpriteTileTables,
): EnginePart[] {
  // Flipping a large OBJ swaps the corner CHARS as well as mirroring each
  // 8x8, because the hardware flips the whole 16x16 quad.
  const order = flipX && flipY ? [3, 2, 1, 0] : flipX ? [1, 0, 3, 2] : flipY ? [2, 3, 0, 1] : [0, 1, 2, 3]
  return [0, 1, 2, 3].map(corner => ({
    charNum: OBJ_CHAR_BASE + pal.charHigh + ((baseTile + LARGE_OBJ_CORNERS[order[corner]]) & OBJ_CHAR_MASK),
    palette: pal.row,
    flipX, flipY,
    dx: baseDx + (tables.dispX[corner] ?? 0),
    dy: baseDy + (tables.dispY[corner] ?? 0),
  }))
}

/**
 * `SubSprGfx1` - bank_01.asm:3920.
 *
 * `idx = SprTilemapOffset[id] + SpriteMisc1602 * 2`, then TWO large 16x16
 * OBJs: `SprTilemap[idx]` on top at `_1` and `SprTilemap[idx + 1]` below at
 * `_1 + $10`, both at X `_0`. Eight 8x8 subtiles, not four.
 *
 * There is NO per-tile attribute table on this path. ONE attribute byte is
 * computed and stored to both entries, and both get `OAMTileSize` bit $02.
 */
function drawSub1(
  tables: SpriteTileTables, tilemapBase: number, misc1602: number,
  pal: ResolvedPalette, flipX: boolean, ov: TileOverrides,
): EnginePart[] {
  const idx = tilemapBase + misc1602 * 2
  const top = ov.get(0x00) ?? tables.tilemap[idx] ?? 0
  const bottom = ov.get(0x04) ?? tables.tilemap[idx + 1] ?? 0
  const flipY = (pal.attr & OBJ_YFLIP) !== 0
  // Anchored on the TOP entry, which is where `SubSprGfx1` anchors: it
  // stores `_1` to `OAMTileYPos+$100` and `_1 + $10` to `+$104`
  // (bank_01.asm:3948-3952). Anchoring on the bottom instead needed a
  // constant to undo, and that constant put $1F 16 px too high.
  return [
    ...largeObj(top, pal, flipX, flipY, 0, 0, tables),
    ...largeObj(bottom, pal, flipX, flipY, 0, 16, tables),
  ]
}

/**
 * `SubSprGfx2Entry1` - bank_01.asm:4148.
 *
 * ONE hardware 16x16 large OBJ, so its four 8x8 chars are the implicit
 * N, N+1, N+$10, N+$11. It never reads `GeneralSprGfxProp`, and it derives
 * X-flip from `SpriteMisc157C` with `EOR`, not `ORA`.
 */
function drawSub2(
  tables: SpriteTileTables, tilemapBase: number, misc1602: number,
  pal: ResolvedPalette, flipX: boolean, ov: TileOverrides,
): EnginePart[] {
  const tile = ov.get(0x00) ?? tables.tilemap[tilemapBase + misc1602] ?? 0
  const flipY = (pal.attr & OBJ_YFLIP) !== 0
  return largeObj(tile, pal, flipX, flipY, 0, 0, tables)
}

/**
 * OAM slot of a routine's LAST entry, as a byte offset past its first.
 *
 * `sub0` writes four 8x8 entries, `sub1` two large ones and `sub2` one
 * (bank_01.asm:3853, 3920, 4148). An extra part past this slot draws BEHIND
 * the routine's own tiles, because a lower OAM index wins.
 */
const ROUTINE_LAST_SLOT: Record<DrawRoutine, number> = { sub0: 0x0C, sub1: 0x04, sub2: 0x00 }

/** 8x8 parts each of a routine's OAM entries expands to. `sub0` writes four
 *  independent 8x8 entries; `sub1` and `sub2` write hardware large OBJs,
 *  which the engine expands into four corners apiece. */
const ROUTINE_PARTS_PER_ENTRY: Record<DrawRoutine, number> = { sub0: 1, sub1: 4, sub2: 4 }

/**
 * OAM entries the handler writes itself, around the shared routine.
 *
 * Returns null on a ROM read that falls off the cart, which the caller turns
 * into a failure rather than a body drawn without its extras.
 */
function drawExtraParts(
  rom: RomFile, parts: readonly ExtraPart[], routine: DrawRoutine,
  tileGroup: number, misc157C: number, pal: ResolvedPalette,
  flipX: boolean, flipY: boolean, handlerBase: number,
): { behind: EnginePart[]; front: EnginePart[] } | null {
  const behind: EnginePart[] = []
  const front: EnginePart[] = []
  for (const ep of parts) {
    if (ep.gate) {
      const min = readRefByte(rom, ep.gate.operandAddr, handlerBase)
      if (min === null) return null
      if (tileGroup < min) continue
    }
    const char = readExtraByte(rom, ep.char, misc157C, handlerBase)
    const dx   = readExtraByte(rom, ep.dx, misc157C, handlerBase)
    const dy   = readExtraByte(rom, ep.dy, misc157C, handlerBase)
    if (char === null || dx === null || dy === null) return null
    const part: EnginePart = {
      charNum: OBJ_CHAR_BASE + pal.charHigh + (char & OBJ_CHAR_MASK),
      palette: pal.row,
      flipX, flipY,
      // The displacement table already encodes both facings, so a flipped
      // part must NOT be mirrored a second time.
      dx: toSigned8(dx),
      // Already in the routine's own `_1` frame, which is now also the
      // engine's origin for every routine, so no translation is needed.
      dy: toSigned8(dy),
    }
    ;(ep.oamSlot > ROUTINE_LAST_SLOT[routine] ? behind : front).push(part)
  }
  return { behind, front }
}

/**
 * Apply the handler's own post-`JSR` adjustments to the routine's OAM entries.
 *
 * Mutates `parts` in place, which is why it runs before the extra parts are
 * spliced in: a nudge names an entry the ROUTINE wrote, and the operand-to-
 * slot arithmetic is only meaningful against those.
 *
 * Returns a failure rather than a boolean so an unrecognised opcode is
 * reported as what it is instead of collapsing into "a read failed".
 */
function applyTileNudges(
  rom: RomFile, parts: EnginePart[], nudges: readonly TileNudge[],
  routine: DrawRoutine, tileGroup: number, spriteId: number, handlerBase: number,
): EngineFailure | null {
  for (const n of nudges) {
    const from = readRefByte(rom, n.windowBase, handlerBase)
    const size = readRefByte(rom, n.windowSize, handlerBase)
    const bits = readShiftCount(rom, n.bitSelect, handlerBase)
    const at = resolveRef(rom, n.insnAddr, handlerBase)
    const insn = at === null ? null : rom.readAt(at, 3)
    if (from === null || size === null || bits === null || at === null || !insn) {
      return { kind: 'romReadFailed', spriteId, addr: at ?? 0 }
    }
    const dy = NUDGE_DISPLACEMENT[insn[0]]
    if (dy === undefined) {
      return {
        kind: 'unexpectedOpcode', spriteId, addr: at,
        expected: Object.keys(NUDGE_DISPLACEMENT).map(Number), found: insn[0],
      }
    }
    // The handler's own gate: `SEC : SBC #from : CMP #size : BCC skip`, then
    // an `LSR A` run whose last shifted-out bit gates a second `BCC`.
    const diff = (tileGroup - from) & 0xFF
    if (diff < size) continue
    if (bits > 0 && ((diff >> (bits - 1)) & 1) === 0) continue

    const slot = (insn[1] | (insn[2] << 8)) - SPRITE_OAM_FIRST_Y
    const targets = partsForSlot(routine, slot, parts.length)
    if (!targets) return { kind: 'nudgeTargetOutOfRange', spriteId, slot, routine }
    for (const i of targets) parts[i] = { ...parts[i], dy: parts[i].dy + dy }
  }
  return null
}

/**
 * Read the shared routine a `JSR` at `at` enters.
 *
 * Shared by `readDrawRoutine` and `readRoutineSelect`, which differ only in
 * how they decide WHICH `JSR` to look at.
 */
function routineAtJsr(
  rom: RomFile, at: number | null, spriteId: number,
): { routine: DrawRoutine; failure?: undefined } | { routine?: undefined; failure: EngineFailure } {
  const b = at === null ? null : rom.readAt(at, 3)
  if (at === null || !b) return { failure: { kind: 'romReadFailed', spriteId, addr: at ?? 0 } }
  if (b[0] !== OPCODE_JSR) {
    return { failure: { kind: 'unexpectedOpcode', spriteId, addr: at, expected: [OPCODE_JSR], found: b[0] } }
  }
  const target = b[1] | (b[2] << 8)
  const hit = SHARED_DRAW_ROUTINES.find(r => r.addr === target)
  return hit ? { routine: hit.routine } : { failure: { kind: 'unknownDrawRoutine', spriteId, target } }
}

/**
 * Decide whether an `UnmodelledTailCall` fires, reading its threshold and
 * its `JSR` out of the cart.
 *
 * The opcode check is why a hack that NOPs the call out renders normally:
 * the wings are gone, so the body is the whole sprite and safe to draw.
 */
function readTailCall(
  rom: RomFile, tail: UnmodelledTailCall, spriteId: number, handlerBase: number,
): EngineFailure | null {
  const threshold = readRefByte(rom, tail.cmpOperandAddr, handlerBase)
  const at = resolveRef(rom, tail.jsrAddr, handlerBase)
  const insn = at === null ? null : rom.readAt(at, 1)
  if (threshold === null || at === null || !insn) {
    return { kind: 'romReadFailed', spriteId, addr: at ?? 0 }
  }
  if (insn[0] !== OPCODE_JSR) return null
  if (spriteId < threshold) return null
  return { kind: 'unmodelledTailCall', spriteId, routineName: tail.routineName, addr: at }
}

/**
 * Which of two shared routines the handler picks for THIS sprite ID, and
 * the Y adjust the chosen branch applies.
 *
 * Every input is read: the property table's address from the `LDA abs,Y`
 * operand, the selecting bit from the `AND` immediate, and each branch's
 * routine from its own `JSR`. The engine never learns that vanilla's bit is
 * $40 or that vanilla's clear branch is a 16x16, so a hack that sets the bit
 * on a Goomba gets a 16x32 Goomba drawn, and one that swaps the two `JSR`s
 * gets them the other way round.
 *
 * `dy` is expressed as an adjustment to what the routine port already
 * produces, so the routine's own base translation is not counted twice.
 */
function readRoutineSelect(
  rom: RomFile, d: SpriteDrawDescriptor, tileGroup: number, handlerBase: number,
): { routine: DrawRoutine; dy: number; failure?: undefined } | { failure: EngineFailure } {
  const sel = d.routineSelect!
  const tableAddr = resolveOperand(rom, resolveRef(rom, sel.propOperandAddr, handlerBase), 2, sel.propOperandBank)
  const mask = readRefByte(rom, sel.maskOperandAddr, handlerBase)
  const prop = tableAddr === null ? null : rom.readAt(tableAddr + d.spriteId, 1)
  if (mask === null || !prop) {
    return { failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: tableAddr ?? 0 } }
  }

  const set = (prop[0] & mask) !== 0
  const read = routineAtJsr(rom, resolveRef(rom, set ? sel.jsrIfSet : sel.jsrIfClear, handlerBase), d.spriteId)
  if (read.failure) return { failure: read.failure }

  if (set && sel.setBranchTailCall) {
    const tail = readTailCall(rom, sel.setBranchTailCall, d.spriteId, handlerBase)
    if (tail) return { failure: tail }
  }

  const adj = set ? sel.setBranchYAdjust : undefined
  if (!adj) return { routine: read.routine, dy: 0 }

  const bits = readShiftCount(rom, adj.carryShift, handlerBase)
  const sbc = readRefByte(rom, adj.sbcOperandAddr, handlerBase)
  if (bits === null || sbc === null) {
    return { failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }
  }
  // `SBC #imm` subtracts `imm + 1 - carry`, and the carry is the last bit the
  // `LSR A` run shifted out of the tile group. This is the WHOLE of the
  // handler's contribution: the routine ports anchor on their own first OAM
  // entry, so there is nothing of theirs to cancel out here.
  const carry = bits > 0 ? (tileGroup >> (bits - 1)) & 1 : 0
  return { routine: read.routine, dy: -(sbc + 1 - carry) }
}

/**
 * Which shared routine the handler's `JSR` actually enters.
 *
 * A bounded read of three bytes at a fixed offset, not a trace: the opcode
 * has to be a `JSR` and the target has to be one of the three known entry
 * points, or the engine declines. A descriptor with no `routineJsr` falls
 * back to its declared `routine`, which is where the remaining hardcoding
 * lives.
 */
export function readDrawRoutine(
  rom: RomFile, d: SpriteDrawDescriptor, handlerBase: number,
): { routine: DrawRoutine; failure?: undefined } | { routine?: undefined; failure: EngineFailure } {
  if (d.routineJsr === undefined) return { routine: d.routine }
  return routineAtJsr(rom, resolveRef(rom, d.routineJsr, handlerBase), d.spriteId)
}

/** Bounding box of a part list, in the same frame as `EnginePart.dx/dy`. */
export interface SpriteExtents { x0: number; y0: number; x1: number; y1: number }

/**
 * Union of every frame's extents.
 *
 * Per-frame extents are the wrong basis for anything stable. $1F's wand is
 * outside the body's box in the cast poses and inside it in the wind-up
 * poses, so a box tracking the current frame changes size mid-animation, and
 * a selection rect or picker cell built from one frame is wrong on the
 * others. The union is stable and never clips. Callers that genuinely want
 * the drawn frame's box, such as a debug outline, should compute it from the
 * parts they just drew.
 */
export function unionExtents(frames: readonly (readonly EnginePart[])[]): SpriteExtents | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const parts of frames) {
    for (const p of parts) {
      x0 = Math.min(x0, p.dx); y0 = Math.min(y0, p.dy)
      x1 = Math.max(x1, p.dx + 8); y1 = Math.max(y1, p.dy + 8)
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 }
}

// ── Entry points ────────────────────────────────────────────────────────────

function applyAttrOverride(ov: AttrOverride, romFrame: number): number {
  if (ov.kind === 'const') return ov.value
  // The ASL happens in the 8-bit accumulator, so the shift WRAPS. Without the
  // & $FF the flip bits stop cycling and the sprite freezes in one pose.
  return (((Math.floor(romFrame) & 0xFF) << ov.shl) & 0xFF & ov.andMask) | ov.orMask
}

export interface DrawRequest {
  rom: RomFile
  tables: SpriteTileTables
  descriptor: SpriteDrawDescriptor
  /** Sprite X in level pixels. Feeds both facing and X-dependent palettes. */
  spriteX: number
  ctx: SpriteRenderContext
  /** Omit to render the animation frame for `ctx.romFrame`. */
  forceFrame?: number
}

/**
 * Render one sprite's 8x8 parts.
 *
 * Does NOT check identity: callers that care must call `resolveIdentity`
 * first. Separating them keeps the routine port pure and testable against
 * synthetic tables with no cart present.
 */
export function drawSpriteParts(req: DrawRequest): EngineResult {
  const { rom, tables, descriptor: d, spriteX, ctx } = req
  const handlerBase = resolveHandlerBase(rom, d)
  const seed = resolveStateTimerSeed(rom, d.anim, handlerBase)
  if (d.anim.kind === 'stateTimer' && seed === null) {
    const addr = resolveRef(rom, d.anim.seedOperandAddr, handlerBase)
    return { ok: false, failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: addr ?? 0 } }
  }
  const anim = resolveAnim(rom, d.anim, handlerBase)
  if (!anim) return { ok: false, failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }
  const frame = req.forceFrame ?? frameIndexAt(anim, ctx.romFrame, seed ?? 0)

  // Ahead of the routine choice, because a `routineSelect` branch's Y adjust
  // takes its carry from the tile group.
  const tileGroup = readByteSource(rom, d.tileGroup, frame, handlerBase)
  if (tileGroup === null) return { ok: false, failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }

  let overrides: TileOverrides = NO_TILE_OVERRIDES
  if (d.tileOverrides && d.tileOverrides.length > 0) {
    const read = readTileOverrides(rom, d.tileOverrides, d.spriteId, handlerBase)
    if (read.failure) return { ok: false, failure: read.failure }
    overrides = read.map
  }

  const routineRead: { routine?: DrawRoutine; dy?: number; failure?: EngineFailure } = d.routineSelect
    ? readRoutineSelect(rom, d, tileGroup, handlerBase)
    : readDrawRoutine(rom, d, handlerBase)
  if (routineRead.failure || !routineRead.routine) {
    return { ok: false, failure: routineRead.failure ?? { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }
  }
  const routine = routineRead.routine
  const selectDy = routineRead.dy ?? 0

  const pal = resolvePalette(rom, tables, d, spriteX, handlerBase)
  if (!pal) return { ok: false, failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }

  if (d.attrOverride) {
    const attr = applyAttrOverride(d.attrOverride, ctx.romFrame)
    pal.attr = attr
    pal.row = 8 + ((attr >> 1) & 0x07)
    pal.charHigh = (attr & 0x01) !== 0 ? OBJ_CHAR_HIGH : 0
  }

  const tilemapBase = tables.tilemapOffset[d.spriteId] ?? 0
  const misc157C = resolveMisc157C(d.misc157C, spriteX, ctx.marioX)

  const flipY = (pal.attr & OBJ_YFLIP) !== 0
  // `sub0` sets flip per corner from `GeneralSprGfxProp` and never reads the
  // direction latch, so an extra part on that path takes the latch's own
  // answer, which is what the handler's inline copy of the sequence computes.
  const flipX = xflipFromLatch(misc157C, pal.attr, routine === 'sub0' ? 'sub1' : routine)

  let parts: EnginePart[]
  if (routine === 'sub0') {
    const pg = d.propGroup ? readByteSource(rom, d.propGroup, frame, handlerBase) : 0
    if (pg === null) return { ok: false, failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }
    parts = drawSub0(tables, tilemapBase, tileGroup, pg, pal, overrides)
  } else {
    parts = routine === 'sub1'
      ? drawSub1(tables, tilemapBase, tileGroup, pal, flipX, overrides)
      : drawSub2(tables, tilemapBase, tileGroup, pal, flipX, overrides)
  }

  // The handler's own pre-`JSR` Y adjust moves the whole body, so it lands
  // before any nudge that moves ONE of the routine's entries relative to it.
  if (selectDy !== 0) parts = parts.map(p => ({ ...p, dy: p.dy + selectDy }))

  // Before the extras: a nudge names an entry the ROUTINE wrote.
  if (d.tileNudges && d.tileNudges.length > 0) {
    const failure = applyTileNudges(rom, parts, d.tileNudges, routine, tileGroup, d.spriteId, handlerBase)
    if (failure) return { ok: false, failure }
  }

  if (d.extraParts && d.extraParts.length > 0) {
    const extra = drawExtraParts(rom, d.extraParts, routine, tileGroup, misc157C, pal, flipX, flipY, handlerBase)
    if (!extra) return { ok: false, failure: { kind: 'romReadFailed', spriteId: d.spriteId, addr: 0 } }
    parts = [...extra.behind, ...parts, ...extra.front]
  }

  const identity: SpriteIdentity = {
    spriteId: d.spriteId, mainHandler: d.vanillaMainHandler,
    initHandler: d.vanillaInitHandler, status: 'vanilla',
  }
  return pal.note
    ? { ok: true, parts, identity, paletteNote: pal.note }
    : { ok: true, parts, identity }
}

/** Look up a traced descriptor by sprite ID. */
export function findDescriptor(
  spriteId: number, descriptors: readonly SpriteDrawDescriptor[] = SPRITE_DRAW_DESCRIPTORS,
): SpriteDrawDescriptor | undefined {
  return descriptors.find(d => d.spriteId === spriteId)
}

/**
 * Render ONE frame of a sprite: no map, no placement, no sprite instance.
 *
 * Deliberately general, because three consumers share it and it must not be
 * specialised to any of them:
 *   - the map render, which draws the sprite where it sits;
 *   - the sprite picker, which draws a thumbnail for a sprite not yet placed;
 *   - annotations, such as the translucent "ghost" of the emerged $4D mole
 *     drawn above its rubble mound, which needs a specific frame that is
 *     neither frame 0 nor the in-place frame.
 *
 * Without a frame selector that third consumer would have to keep its own
 * private tile-reading path, which is exactly the duplication this engine
 * exists to remove. The engine produces correct pixels for a requested frame
 * and makes NO editorial decision about what to do with them: offsets,
 * opacity and hit-testing belong to the annotation layer.
 *
 * `opts.frame` defaults to the descriptor's `representativeFrame`.
 *
 * Level-CONTEXTUAL by construction. A sprite's graphics come from the level's
 * SP1-SP4 assignment and its colours from that level's palette, so the same
 * sprite ID legitimately looks different between levels, and in some levels
 * its tiles are not loaded at all. That last case is reported as
 * `charsNotLoaded` rather than rendered as garbage, which is genuinely useful
 * to someone placing sprites.
 *
 * Shows `representativeFrame`, which is a reviewed human choice per sprite
 * and not always frame 0: $4D Monty Mole's resting pose is an anonymous pile
 * of rubble because it burrows.
 *
 * Pure: no vscode, no webview, no canvas. Returns parts for the caller to draw.
 */
export function renderSpriteFrame(
  rom: RomFile,
  tables: SpriteTileTables,
  spriteId: number,
  level: SpriteLevelContext,
  opts: { frame?: number } = {},
  descriptors: readonly SpriteDrawDescriptor[] = SPRITE_DRAW_DESCRIPTORS,
): EngineResult {
  const d = findDescriptor(spriteId, descriptors)
  if (!d) return { ok: false, failure: { kind: 'noDescriptor', spriteId } }

  const identity = resolveIdentity(rom, spriteId, descriptors)
  if (identity && identity.status === 'custom') {
    const ptrs = readHandlerPointers(rom, spriteId)!
    return {
      ok: false, identity,
      failure: {
        kind: 'customHandler', spriteId, table: 'main',
        expected: d.vanillaMainHandler, found: ptrs.main,
      },
    }
  }

  const frame = opts.frame ?? d.representativeFrame
  const base = resolveHandlerBase(rom, d)
  const seed = resolveStateTimerSeed(rom, d.anim, base) ?? 0
  const anim = resolveAnim(rom, d.anim, base) ?? d.anim
  // With no placement there is no Mario to face, so put Mario at the sprite:
  // `marioX >= spriteX` gives latch 0, the pose the ROM shows when Mario is
  // to the right. `romFrame` is set to a frame that SELECTS this animation
  // frame, so an attribute override driven by EffFrame stays consistent with
  // the tile the frame selector asked for.
  const res = drawSpriteParts({
    rom, tables, descriptor: d, spriteX: 0,
    ctx: { marioX: 0, romFrame: romFrameForFrame(anim, frame, seed) },
    forceFrame: frame,
  })
  if (!res.ok) return res

  const missing = res.parts.map(p => p.charNum).filter(c => !level.loadedChars.has(c))
  if (missing.length > 0) {
    return { ok: false, identity: identity ?? undefined, failure: { kind: 'charsNotLoaded', spriteId, missing: [...new Set(missing)] } }
  }
  return { ...res, identity: identity ?? res.identity }
}

/**
 * Convenience wrapper: the frame a sprite should show when depicted
 * statically and out of context. Thin alias over `renderSpriteFrame`.
 */
export function renderRepresentativeFrame(
  rom: RomFile,
  tables: SpriteTileTables,
  spriteId: number,
  level: SpriteLevelContext,
  descriptors: readonly SpriteDrawDescriptor[] = SPRITE_DRAW_DESCRIPTORS,
): EngineResult {
  return renderSpriteFrame(rom, tables, spriteId, level, {}, descriptors)
}
