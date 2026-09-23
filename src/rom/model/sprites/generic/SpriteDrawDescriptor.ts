/**
 * Data model for the table-driven sprite draw engine.
 *
 * The engine reproduces SMW's three shared sprite draw routines by reading
 * every VALUE from the open ROM. What cannot be read generically is the
 * per-sprite 65816 code that computes the routine's ARGUMENTS. This project
 * has refused to build an ASM interpreter, so those arguments are extracted
 * once, by hand, from the disassembly.
 *
 * The rule that makes that extraction safe for romhacks: a descriptor stores
 * WHERE TO LOOK, never WHAT WAS THERE. A `tableAddr` is a ROM address the
 * engine dereferences at render time, so a hack that retunes the table still
 * renders correctly.
 *
 * OPCODES ARE READABLE BYTES. A shift count is the length of a run of
 * `LSR A`; a displacement's sign is `INC` versus `DEC`; the routine a handler
 * enters is the target of its `JSR`. All of those are read at render time
 * too, because simulating execution to discover WHICH code runs is out of
 * scope but reading a byte at a known offset to learn WHAT it does is not.
 * `ShiftCount` and `CodeRef` below are the two mechanisms that do it.
 *
 * Nothing in this file is a rendered value. No tile numbers, no colours.
 *
 * Evidence scope: every descriptor cites `SMWDisX file:line`. Behaviour was
 * traced in the disassembly and cross-checked against the six cart
 * files in `test/roms/`, which hold FIVE distinct carts: `magic.sfc` is
 * `vanilla.sfc` plus a 512-byte copier header and is byte-identical once it
 * is stripped. No emulator was used, so no claim here is dynamically
 * verified; they are static-trace claims over a five-cart corpus.
 */

/**
 * Where a byte lives on the cart.
 *
 * A bare number is a fixed 24-bit SNES address, for a byte that is NOT inside
 * the sprite's own handler: a shared routine, or a table in another bank.
 *
 * `{ mainOff }` is a byte offset past the MAIN handler pointer THE CART
 * RESOLVES for this sprite. Prefer it for anything inside a handler: a hack
 * that RELOCATES a handler without rewriting it moves every one of these with
 * it, where an absolute address would silently read whatever now lives at the
 * old place.
 *
 * `{ via, off }` is a byte offset past the TARGET of the `JSR` or `JMP` at
 * another `CodeRef`. ONE hop, and the opcode has to be one of those two or
 * the ref does not resolve. It exists because a handler's draw work is often
 * not inside the handler: $00-$03 reach `Spr0to13Gfx` through a `JMP` into
 * the `Spr0to13Start` blob (bank_01.asm:1418, 1656), so no `{ mainOff }` past
 * `ShellessKoopas` names it, and an absolute address would not follow a hack
 * that relocated the shared code. Nesting spells a two-hop chain. Every hop
 * is a bounded 3-byte read at an offset the descriptor names: this READS a
 * link, it does not search for one.
 */
export type CodeRef = number | { mainOff: number } | { via: CodeRef; off: number }

/**
 * A shift count, read by counting the run of `LSR A` opcodes that performs
 * it rather than by recording how long that run is in vanilla.
 *
 * `max` bounds the scan. A shift of 8 clears an 8-bit accumulator, so 8 is
 * the useful ceiling; an unbounded scan on a corrupt cart would walk.
 */
export interface ShiftCount {
  /** First byte of the run. */
  scan: CodeRef
  /** Upper bound on the count. A run at least this long reads as `max`. */
  max: number
}

/** Per-sprite direction latch `SpriteMisc157C`, which the draw routines read
 *  to decide X-flip. How a handler establishes it is per-sprite and traceable. */
export type Misc157CSource =
  /** Handler calls `FaceMario` / `SubHorizPos` (bank_01.asm:847, 6124).
   *  Y = 0 when Mario is at or right of the sprite, 1 when left. */
  | { kind: 'faceMario' }
  /** Handler writes a fixed value. */
  | { kind: 'const'; value: number }
  /** Handler never writes it, so it stays 0 from `InitSpriteTables`.
   *  Per the routines' `BCS` polarity, 0 means X-FLIP IS APPLIED. */
  | { kind: 'unwritten' }

/** A byte the handler feeds to a draw routine. */
export type ByteSource =
  /** A literal, with no instruction to read it back from. Prefer
   *  `immediate` wherever the handler actually holds an `LDA #imm`: this
   *  kind is for a value that is implicit rather than encoded. */
  | { kind: 'const'; value: number }
  /** An immediate operand in the handler, READ from the cart. Code rather
   *  than data, and fixed across frames: the animation, if any, lives
   *  elsewhere. `insnAddr` names the `LDA #imm` OPCODE, so a rewritten
   *  handler is refused rather than having its next byte taken as a value. */
  | { kind: 'immediate'; insnAddr: CodeRef }
  /** The tile group IS the animation frame index. This is what
   *  `SetAnimationFrame` (bank_01.asm:2089) writes straight into
   *  `SpriteMisc1602`, so the walk cycle and the tile selector are the
   *  same number. */
  | { kind: 'frameIndex' }
  /** A ROM table the handler indexes by animation frame. Read at render time. */
  | { kind: 'table'; addr: number }
  /** A ROM table whose ADDRESS is itself read from the operand of the
   *  instruction that consumes it. One level more robust than `table`:
   *  a hack that relocates the table but leaves the handler intact still
   *  resolves. `operandAddr` points at the operand BYTES, not the opcode.
   *  $4D reads both its tile-group and its prop-group table this way
   *  (bank_01.asm:13399, 13401). */
  | { kind: 'tableViaOperand'; operandAddr: CodeRef; operandBank: number }
  /** Like `tableViaOperand`, but the index is SHIFTED first and a low slice
   *  of the same index may be ORed into the result: the shape a handler uses
   *  when one counter carries two cadences. $1F is
   *  `DATA_01BE69[timer >> 6] | ((timer >> 3) & 1)` (bank_01.asm:8513-8528).
   *  Both shifts are COUNTED out of their `LSR A` runs and the OR mask is
   *  read from the `AND` immediate that terminates the second run. Omit
   *  `orBit` for the commoner plain lookup, e.g.
   *  `DATA_01FD95[SpriteMisc1564 >> 3]` (bank_01.asm:16700-16708). */
  | {
      kind: 'shiftedTable'
      operandAddr: CodeRef
      operandBank: number
      shift: ShiftCount
      orBit?: { shift: ShiftCount; maskAddr: CodeRef }
    }

/** How the animation frame index is produced. Periods are in GAME FRAMES. */
export type AnimSource =
  /** Single frame. */
  | { kind: 'static' }
  /** Global `EffFrame` ($14): `(EffFrame >> shift) & mask`. Phase is shared
   *  by every sprite on screen, so it is reproducible in a still editor. */
  | { kind: 'effFrame'; shift: number; mask: number }
  /** A per-sprite counter (e.g. `SpriteMisc1570` via `SetAnimationFrame`,
   *  bank_01.asm:2089): `(counter >> shift) & mask`. The PERIOD is knowable
   *  statically; the PHASE is not, because `InitStandardSprite` seeds the
   *  counter with `GetRand` (bank_01.asm:844-845), so it is not merely
   *  unknown in a still editor, it differs per spawn on hardware. The editor
   *  treats it as free-running from 0.
   *
   *  `shiftAt`/`maskAt` read the two numbers out of the cart instead of
   *  holding them: the shift is the run of `LSR A` at `SetAnimationFrame`
   *  and the mask the `AND` immediate that terminates it (bank_01.asm:2092-
   *  2095). `shift`/`mask` stay as the vanilla figures and are used only when
   *  the cart refs are absent, the same split as `routine` and `routineJsr`. */
  | { kind: 'spriteCounter'; shift: number; mask: number; shiftAt?: ShiftCount; maskAt?: CodeRef }
  /** A ONE-SHOT COUNTDOWN the handler seeds on entry to a state, decremented
   *  once per game frame and floored at zero (bank_01.asm:157-159). The frame
   *  index IS the timer value, running `seed` down to 0. The editor loops it;
   *  on hardware the state ends at 0. `seedOperandAddr` is the operand byte
   *  of the seeding `LDA #imm`, read from the cart. */
  | { kind: 'stateTimer'; seedOperandAddr: CodeRef }

/** Where the sprite's CGRAM row and char-high bit come from. */
export type PaletteSource =
  /** `Sprite166EVals` ($07:F3FE) via `LoadSpriteTables` (bank_07.asm:977):
   *  attr = byte & $0F, palette index = (attr >> 1) & 7, row = 8 + index,
   *  charHigh = attr & 1. The default for most sprites. */
  | { kind: 'spriteTable' }
  /** The sprite's INIT routine overwrites `SpriteOBJAttribute` with a byte
   *  chosen from a ROM table indexed by a spawn-time property. $2C Yoshi Egg
   *  indexes `YoshiPal` by `(SpriteXPosLow >> 4) & 3`, so its colour depends
   *  on which 16 px column it spawned in. Init routines are easy to skip
   *  because they never draw. */
  | {
      kind: 'initTableByX'
      operandAddr: CodeRef
      operandBank: number
      entries: number
      shift: number
      mask: number
    }
  /** The handler DMAs colours into CGRAM at runtime, overwriting part of a
   *  row. A still editor uses the resting entry and composites the untouched
   *  columns from the level palette.
   *
   *  `DynSpritePalette` on `feature/sprite-1f-render` landed the same shape
   *  independently. The two are NOT interchangeable and a merge is a
   *  reconciliation, not a type alias: divergence report 11.4 has the
   *  field-by-field comparison. */
  | {
      kind: 'dynamicCgram'
      operandAddr: CodeRef
      colorsPerEntry: number
      entryCount: number
      cgramStart: number
      /** Fallback, used only when `restingEntryCmpAddr` is absent or the
       *  instruction it names is not the expected `CMP #imm`. */
      restingEntry: number
      /** The `CMP #imm` that ENDS the fade by branching past the upload:
       *  opcode byte first, then the immediate. The fade uploads entries
       *  `0 .. imm - 2`, so the entry left standing in CGRAM is `imm - 2`.
       *  Omit where a handler has no such terminator. */
      restingEntryCmpAddr?: CodeRef
    }

/** An override of `SpriteOBJAttribute` performed by the handler before it draws. */
export type AttrOverride =
  /** A fixed byte. */
  | { kind: 'const'; value: number }
  /** `((EffFrame << shl) & andMask) | orMask`. $4E rotates its flip bits
   *  this way, giving a 4-pose spin out of one tile (bank_01.asm:13412). */
  | { kind: 'effFrameFlip'; shl: number; andMask: number; orMask: number }

/**
 * A byte an EXTRA PART needs. Separate from `ByteSource` because these are
 * read once per draw and indexed by the direction latch, not by the frame.
 * Values come back RAW: a char is unsigned, an offset is sign-extended by
 * the engine.
 */
export type ExtraByteSource =
  /** Fixed, with no instruction to read it back from. Dry Bones' extra tile
   *  sits at the body's Y with no `ADC` at all (bank_01.asm:13562-13563). */
  | { kind: 'const'; value: number }
  /** An immediate operand, read from the cart. `addr` is the operand byte. */
  | { kind: 'immediateAt'; addr: CodeRef }
  /** A ROM table indexed by `SpriteMisc157C`, one displacement per facing.
   *  It encodes BOTH positions, so a flipped part must NOT be mirrored again.
   *  `operandAddr` is the operand of the instruction that reads it. */
  | { kind: 'tableByMisc157C'; operandAddr: CodeRef; operandBank: number }

/** When an extra part is drawn. Absent means always. One kind, one user: a
 *  `CMP` plus `BCC` skip on the tile group. Other gates in this game test a
 *  state flag or a timer window and become their own kinds when needed. */
export type ExtraPartGate =
  /** `SpriteMisc1602 >= imm`, `operandAddr` being the CMP's immediate byte. */
  { kind: 'tileGroupAtLeast'; operandAddr: CodeRef }

/**
 * An 8x8 OAM entry the handler writes ITSELF, around the shared draw routine
 * rather than through it. A descriptor models what the routine READS, so
 * such parts were previously absent from the render entirely.
 *
 * Offsets are in the ROUTINE'S OWN frame, `_0`/`_1` from `GetDrawInfoBnk1`,
 * so the descriptor holds the number the handler's own `ADC` holds and the
 * engine applies the routine's base translation.
 *
 * No attribute and no size field: both known users inherit the body's
 * attribute byte (bank_01.asm:8562-8568, 13564-13565) and clear the OAM size
 * bit (bank_01.asm:8576-8578). Derivation, the second user and what the wing
 * family would still need are in docs/sprites/sprite-engine-divergence.md section 8.
 */
export interface ExtraPart {
  /** Byte offset of this part's OAM slot past the routine's first entry.
   *  A LOWER OAM index draws IN FRONT, so a part whose slot is past the
   *  routine's last entry sits BEHIND the body. */
  oamSlot: number
  char: ExtraByteSource
  /** Signed X displacement, routine frame. */
  dx: ExtraByteSource
  /** Signed Y displacement, routine frame. */
  dy: ExtraByteSource
  gate?: ExtraPartGate
  /** `SMWDisX file:line` for this part specifically. */
  evidence: string
}

/**
 * A vertical adjustment the handler applies to ONE of the shared routine's
 * OWN OAM entries, after the routine has written it.
 *
 * The third instance of "handler work outside the shared routine", after
 * `ExtraPart` and `anim: stateTimer`, and the same root cause: a descriptor
 * that models only what the routine READS cannot see it.
 *
 * Nothing here is a stored value. The displacement AND ITS SIGN come from the
 * read-modify-write opcode, the entry from that instruction's own operand,
 * and the gate from the two immediates that precede it. $1F is
 * `bank_01.asm:8530-8539`: a hack that turns its `INC` into a `DEC` must read
 * as -1, and one that retargets the operand must move the other tile.
 */
export interface TileNudge {
  /** `SBC #imm`: the tile group the gate window is measured FROM. */
  windowBase: CodeRef
  /** `CMP #imm` + `BCC`: the nudge applies when `tileGroup - windowBase` is
   *  at least this. */
  windowSize: CodeRef
  /** The `LSR A` run between the window test and its second `BCC`, which
   *  selects ONE bit of the same difference: the nudge applies only when bit
   *  `count - 1` is set. A run of zero leaves the window test standing alone. */
  bitSelect: ShiftCount
  /** The read-modify-write instruction: opcode byte first, then its 16-bit
   *  absolute operand. `$FE` (`INC abs,X`) is +1 px and `$DE` (`DEC abs,X`)
   *  is -1; the operand names the OAM entry, relative to the first one the
   *  shared routines write. */
  insnAddr: CodeRef
  /** `SMWDisX file:line` for this nudge specifically. */
  evidence: string
}

/**
 * A tile number the handler writes OVER one of the shared routine's own OAM
 * entries after the `JSR`, discarding what the routine read.
 *
 * Where a `TileNudge` MOVES an entry the routine wrote, this REPLACES its
 * char, so `SprTilemap` does not decide the tile at all. $2C is the case
 * (bank_01.asm:16057-16062) and vanilla coincides, which is why it went
 * unnoticed. Derivation: divergence report 11.2.
 */
export interface TileOverride {
  /** The `LDA #imm` that supplies the replacement char: opcode byte first,
   *  then its immediate operand. */
  insnAddr: CodeRef
  /** Byte offset of the overwritten OAM entry past the routine's first. An
   *  entry the resolved routine never wrote overrides nothing. */
  oamSlot: number
  /** `SMWDisX file:line` for this override specifically. */
  evidence: string
}

/**
 * A vertical displacement the handler applies to the SPRITE'S OWN Y before
 * it calls the draw routine (bank_01.asm:1770-1774).
 *
 * `SBC #imm` subtracts `imm + 1 - carry`. The LOAD-BEARING part is the
 * operand, 16 px on the walk family's 16x32 branch; the carry is one 1 px
 * term of the same subtraction and is the walk bob. Named for the
 * displacement, because the old name `CarryYAdjust` advertised the pixel
 * and hid the rest.
 *
 * NOT a `TileNudge`: a nudge moves one of the routine's own entries AFTER
 * the `JSR`, this moves the sprite BEFORE it. Both terms are read: the
 * operand, and the length of the `LSR A` run that supplies the carry.
 */
export interface PreDrawYAdjust {
  /** The `LSR A` run whose last shifted-out bit becomes the carry, so the
   *  carry is bit `count - 1` of the tile group. A run of zero means the
   *  carry has no tile-group contribution and reads as clear. */
  carryShift: ShiftCount
  /** Operand byte of the `SBC #imm`. Y moves by `-(imm + 1 - carry)`. */
  sbcOperandAddr: CodeRef
}

/**
 * A conditional `JSR` the handler makes into code this engine has NO kind
 * for, so the body alone would be a confident but incomplete sprite.
 *
 * `Spr0to13Gfx`'s wing tail, bank_01.asm:1785-1788. Both the threshold and
 * the call are read; the `BCC` polarity is assumed. Derivation and the
 * measured failure it fixes: divergence report 10.5.
 */
export interface UnmodelledTailCall {
  /** Operand of the `CMP #imm`. The call fires when the sprite number is at
   *  or above it. */
  cmpOperandAddr: CodeRef
  /** The gated `JSR`. Read only far enough to confirm the opcode: its target
   *  is code with no descriptor kind either way. */
  jsrAddr: CodeRef
  /** Vanilla name of the called routine, for the failure the caller shows. */
  routineName: string
  /** `SMWDisX file:line` for this call specifically. */
  evidence: string
}

/**
 * A handler that picks its shared draw routine at RENDER time, from a bit of
 * a ROM table indexed by SPRITE NUMBER.
 *
 * The fifth "handler work the shared routines do not read" kind, and the
 * first that changes WHICH routine runs rather than what it is fed.
 * `Spr0to13Gfx` (bank_01.asm:1761-1780) is the whole of its evidence:
 * `Spr0to13Prop[id] & $40` set means a 16x32 pair via `SubSprGfx1`, clear
 * means one 16x16 via `SubSprGfx2Entry1`.
 *
 * Nothing here is a value. The table's ADDRESS is the operand of the `LDA
 * abs,Y` that reads it, the bit is the `AND` immediate, and each branch's
 * routine is its own `JSR` target matched against `SHARED_DRAW_ROUTINES`.
 * `SpriteTileLoader.SPR_0_TO_13_PROP_ADDR` is the hardcode this replaces.
 *
 * Users: every sprite whose handler funnels through `Spr0to13Gfx`, which is
 * $00-$07, $0C, $0F, $11 and $13 (bank_01.asm:898-917).
 */
export interface RoutineSelect {
  /** Operand of the `LDA table,Y` that reads the property byte. */
  propOperandAddr: CodeRef
  propOperandBank: number
  /** Operand of the `AND #imm` that isolates the selecting bit. */
  maskOperandAddr: CodeRef
  /** The `JSR` taken when the masked byte is ZERO. */
  jsrIfClear: CodeRef
  /** The `JSR` taken when it is NONZERO. */
  jsrIfSet: CodeRef
  /** Y adjust applied on the NONZERO branch only. */
  setBranchYAdjust?: PreDrawYAdjust
  /** A call into unmodelled code that the NONZERO branch falls through to.
   *  The clear branch `BRA`s past it (bank_01.asm:1767), so it gates that
   *  branch only. */
  setBranchTailCall?: UnmodelledTailCall
  /** `SMWDisX file:line` for this selection specifically. */
  evidence: string
}

/** Which shared draw routine the handler funnels through. */
export type DrawRoutine =
  /** `SubSprGfx0Entry0` bank_01.asm:3853. Four INDEPENDENT 8x8 chars. */
  | 'sub0'
  /** `SubSprGfx1` bank_01.asm:3920. Two stacked 16x16 large OBJs (16x32). */
  | 'sub1'
  /** `SubSprGfx2Entry1` bank_01.asm:4148. One 16x16 large OBJ. */
  | 'sub2'

/**
 * Entry points of the three shared draw routines, bank $01.
 *
 * Hardcoded deliberately, and the only fixed code addresses the engine
 * matches against. These are the SHARED routines, not per-sprite data: a
 * hack that relocates one of them has replaced the game's draw engine rather
 * than retuned a sprite, and the honest answer there is "unknown routine",
 * which is what a `JSR` target absent from this table produces.
 *
 * Addresses from `SMWDisX/SMW_U.sym`, cross-checked against the `JSR
 * SubSprGfx1` at `bank_01.asm:8529`, whose operand all six carts in
 * `test/roms/` hold as $9D67.
 *
 * The alternate entries `SubSprGfx0Entry1` ($9CF5) and `SubSprGfx2Entry0`
 * ($9F09) are deliberately absent: they take different arguments, and no
 * descriptor kind models them yet.
 */
export const SHARED_DRAW_ROUTINES: readonly { addr: number; routine: DrawRoutine }[] = [
  { addr: 0x9cf3, routine: 'sub0' }, // SubSprGfx0Entry0, bank_01.asm:3853
  { addr: 0x9d67, routine: 'sub1' }, // SubSprGfx1,       bank_01.asm:3920
  { addr: 0x9f0d, routine: 'sub2' }, // SubSprGfx2Entry1, bank_01.asm:4148
]

export interface SpriteDrawDescriptor {
  spriteId: number
  /** The routine the VANILLA handler enters. Used only when `routineJsr` is
   *  absent: where it is present the cart's own `JSR` target decides, and
   *  this field is documentation. */
  routine: DrawRoutine
  /** The `JSR` that enters the shared routine. Read as an opcode plus a
   *  16-bit target, matched against `SHARED_DRAW_ROUTINES`. A bounded read at
   *  a fixed offset, not a trace: a handler whose `JSR` is not at a fixed
   *  offset simply does not get this field. */
  routineJsr?: CodeRef
  /** The handler chooses between two shared routines from a ROM table bit.
   *  Takes precedence over `routineJsr` and `routine`, both of which assume
   *  one handler enters one routine. */
  routineSelect?: RoutineSelect
  /** Vanilla MAIN-table handler pointer, for identity checking. See
   *  `SPRITE_MAIN_PTR_TABLE`. A hack that repoints this is rendering
   *  different code and the engine must say so rather than guess. */
  vanillaMainHandler: number
  /** Vanilla INIT-table pointer. Only load-bearing where the init routine
   *  establishes palette or attribute state the draw depends on. */
  vanillaInitHandler: number
  /** Number of distinct animation frames the descriptor enumerates. */
  frames: number
  anim: AnimSource
  /** Feeds `SpriteMisc1602`, the tile-group selector. */
  tileGroup: ByteSource
  /** Feeds the accumulator on entry to `sub0`, selecting a
   *  `GeneralSprGfxProp` group of 4. Meaningless for sub1/sub2, which never
   *  read that table. */
  propGroup?: ByteSource
  attrOverride?: AttrOverride
  /** OAM entries the handler writes around the routine rather than through
   *  it. Rendered in OAM order, so a part behind the body is drawn first. */
  extraParts?: readonly ExtraPart[]
  /** Adjustments the handler makes to the routine's OWN entries after the
   *  `JSR` returns. Applied before `extraParts`, which are not part of the
   *  routine's output and cannot be targeted by one. */
  tileNudges?: readonly TileNudge[]
  /** Chars the handler writes over the routine's own, after the `JSR`
   *  returns. Resolved BEFORE the draw, so the replacement char expands
   *  through the same large-OBJ corner arithmetic the routine's own would. */
  tileOverrides?: readonly TileOverride[]
  misc157C: Misc157CSource
  palette: PaletteSource
  /**
   * Which frame to show when the sprite is depicted statically and out of
   * context, as in a sprite picker. This is a DELIBERATE HUMAN CHOICE, not a
   * derivation: $4D Monty Mole's resting pose is an anonymous pile of rubble
   * because it burrows, so the front-facing pose is chosen instead.
   */
  representativeFrame: number
  /** True when `representativeFrame` is a fallback to the first drawn frame
   *  rather than a reviewed choice. Lets us triage later instead of silently
   *  shipping bad icons. */
  needsHumanReview: boolean
  /** `SMWDisX file:line` for the trace. Never a copy of the assembly. */
  evidence: string
}

// ── Pointer tables (identity) ───────────────────────────────────────────────

/**
 * Sprite INIT pointer table. 201 entries of 2 bytes, bank $01.
 *
 * Located empirically, not from a label: scanning bank $01 for a base where
 * entry $7D reads $85C2 (`Return0185C2`, whose label encodes its own address)
 * and entries $4F/$50 agree (both `InitPiranha`) yields exactly $01:817D.
 * Cross-checked against every label in `CallSpriteMain`'s init block.
 */
export const SPRITE_INIT_PTR_TABLE = 0x01817d

/**
 * Sprite MAIN pointer table. 201 entries of 2 bytes, bank $01.
 *
 * Located the same way: entry $12 reads $F87B (`Return01F87B`) and entries
 * $00-$03 and $04-$07 form the two runs of identical pointers that
 * `CallSpriteMain` shows. Base is $01:85CC.
 *
 * This is the DRAW-relevant table. A previously circulated figure of
 * $01:8183 is the INIT table misaligned by three entries; descriptors and
 * tests here use the verified bases.
 */
export const SPRITE_MAIN_PTR_TABLE = 0x0185cc

export const SPRITE_PTR_TABLE_COUNT = 201

// ── Descriptors ─────────────────────────────────────────────────────────────

/**
 * The `Spr0to13Gfx` walk family.
 *
 * Twelve sprite IDs funnel through one draw routine (bank_01.asm:1748) from
 * two different MAIN handlers. $04-$07, $0C, $0F, $11 and $13 enter at
 * `Spr0to13Start` (bank_01.asm:902-917) and $00-$03 at `ShellessKoopas`
 * (bank_01.asm:898-901), whose walking path falls through into the same blob
 * at `Spr0to13Main` (bank_01.asm:1659).
 *
 * The walk frame is `SetAnimationFrame` (bank_01.asm:2089): a per-sprite
 * counter incremented once per game frame on the walk path
 * (bank_01.asm:1691), shifted and masked into `SpriteMisc1602`, which IS the
 * tile-group selector. Two frames on a 16-game-frame period, with the shift
 * and the mask both read from the routine's own bytes.
 *
 * Direction is `SpriteMisc157C`, established by `InitStandardSprite` falling
 * into `FaceMario` (bank_01.asm:844-849).
 *
 * Two anchors are passed in rather than derived, because the two handlers
 * reach the shared code differently and the whole point of a `CodeRef` is
 * that it names a route a hack can move:
 *   `safJsr`  the `JSR SetAnimationFrame` this handler itself contains,
 *             which is only used to LOCATE the routine, so the carried-pose
 *             call in `ShellessKoopas` (bank_01.asm:1407) serves as well as
 *             the walking one.
 *   `gfxJsr`  the `JSR Spr0to13Gfx` on this handler's route.
 */
function spr0to13(
  id: number,
  main: number,
  init: number,
  safJsr: CodeRef,
  gfxJsr: CodeRef,
): SpriteDrawDescriptor {
  const gfx = (off: number): CodeRef => ({ via: gfxJsr, off })
  const saf = (off: number): CodeRef => ({ via: safJsr, off })
  return {
    spriteId: id,
    // Documentation only: `routineSelect` reads the choice per cart, and on
    // vanilla it answers sub2 for $00-$03/$0F/$11/$13 and sub1 for the rest.
    routine: 'sub2',
    vanillaMainHandler: main,
    vanillaInitHandler: init,
    frames: 2,
    anim: {
      kind: 'spriteCounter',
      shift: 3,
      mask: 1,
      shiftAt: { scan: saf(0x06), max: 8 }, // LSR A run,  bank_01.asm:2092-2094
      maskAt: saf(0x0a), // AND #$01,   bank_01.asm:2095
    },
    tileGroup: { kind: 'frameIndex' },
    routineSelect: {
      propOperandAddr: gfx(0x1e),
      propOperandBank: 0x01, // LDA Spr0to13Prop,Y
      maskOperandAddr: gfx(0x21), // AND #$40
      jsrIfClear: gfx(0x24), // JSR SubSprGfx2Entry1
      jsrIfSet: gfx(0x3d), // JSR SubSprGfx1
      setBranchYAdjust: {
        carryShift: { scan: gfx(0x2c), max: 8 }, // LSR A on the tile group
        sbcOperandAddr: gfx(0x31), // SBC #$0F
      },
      setBranchTailCall: {
        cmpOperandAddr: gfx(0x4a), // CMP #$08
        jsrAddr: gfx(0x4d), // JSR KoopaWingGfxRt
        routineName: 'KoopaWingGfxRt',
        evidence: 'bank_01.asm:1785-1788 Spr0to13Gfx wing tail',
      },
      evidence: 'bank_01.asm:1761-1780 Spr0to13Gfx routine choice and Y adjust',
    },
    misc157C: { kind: 'faceMario' },
    palette: { kind: 'spriteTable' },
    // Both frames are walk poses, so neither is an out-of-context oddity the
    // way $4D's rubble mound is. Which of the two reads better in a picker
    // has NOT been reviewed, which is exactly what the flag records.
    representativeFrame: 0,
    needsHumanReview: true,
    evidence: 'bank_01.asm:1748-1790 Spr0to13Gfx; bank_01.asm:2089-2097 SetAnimationFrame',
  }
}

/**
 * Length of the `JSR SubSprSprInteract` at `CODE_018B03` (bank_01.asm:1655).
 *
 * The one offset in this file that is an INSTRUCTION LENGTH rather than a
 * position: nothing targets the `JSR Spr0to13Gfx` after it, so there is no
 * named hop and the interact call must be stepped over. Declared in
 * divergence report 9.4, with the exact residual risk; pinned by a test
 * across all six cart files.
 */
const SUB_SPR_INTERACT_LEN = 0x03

/** `ShellessKoopas` route, $00-$03: its own `JSR SetAnimationFrame` locates
 *  the routine (bank_01.asm:1407), and its `JMP CODE_018B03`
 *  (bank_01.asm:1418) lands on the interact call that precedes the
 *  `JSR Spr0to13Gfx` the shared blob runs (bank_01.asm:1655-1656). */
const shellessKoopa = (id: number): SpriteDrawDescriptor =>
  spr0to13(
    id,
    0x8904,
    0x8575,
    { mainOff: 0x0f },
    { via: { mainOff: 0x2a }, off: SUB_SPR_INTERACT_LEN },
  )

/** `Spr0to13Start` route: the `JSR Spr0to13Gfx` is in the handler's first
 *  ten bytes (bank_01.asm:1656) and the walk path's `JSR SetAnimationFrame`
 *  is inside the same blob (bank_01.asm:1691). */
const spr0to13Start = (id: number): SpriteDrawDescriptor =>
  spr0to13(id, 0x8afc, 0x8575, { mainOff: 0x4d }, { mainOff: 0x0a })

/**
 * The descriptor set. Phase 1 deliberately covers a narrow, well-evidenced
 * slice rather than all 201 sprites. Every entry was traced individually.
 */
export const SPRITE_DRAW_DESCRIPTORS: readonly SpriteDrawDescriptor[] = [
  // The `Spr0to13Gfx` walk family. Only the ids whose MAIN handler is one of
  // the two that reach it: the rest of $00-$13 have bespoke handlers
  // (bank_01.asm:906-916) and are not covered here.
  ...[0x00, 0x01, 0x02, 0x03].map(shellessKoopa),
  ...[0x04, 0x05, 0x06, 0x07, 0x0f, 0x11, 0x13].map(spr0to13Start),
  // $0C Yellow Koopa with wings is DELIBERATELY ABSENT: its draw ends with
  // `JSR KoopaWingGfxRt` (bank_01.asm:1788), writing OAM entries no kind
  // models. Wings need BOTH the property bit AND a sprite number at or above
  // the `CMP #$08`, and the first is a per-cart table byte, so
  // `setBranchTailCall` reads the gate rather than excluding $0C by name.
  // Divergence report 10.5.

  {
    // $14 Spiny falling from Lakitu. `SpinyEgg` (bank_01.asm:1793) ends
    // `LDA #$02 / JSR SubSprGfx0Entry0`: prop group 2, four independent 8x8s.
    // `buildSpriteLayout` renders this as a single 16x16 large OBJ with
    // SpriteMisc1602 pinned to 0, which is the documented $14 defect.
    // Offsets past the MAIN pointer $8C18; `+$2C` resolves to the
    // `CODE_018C44` label and so cross-checks the base.
    spriteId: 0x14,
    routine: 'sub0',
    routineJsr: { mainOff: 0x31 }, // JSR SubSprGfx0Entry0, bank_01.asm:1814
    vanillaMainHandler: 0x8c18,
    vanillaInitHandler: 0x8575,
    frames: 2,
    anim: {
      // Its own `JSR SetAnimationFrame` (bank_01.asm:1799) locates the
      // shared routine, exactly as the walk family's does.
      kind: 'spriteCounter',
      shift: 3,
      mask: 1,
      shiftAt: { scan: { via: { mainOff: 0x0b }, off: 0x06 }, max: 8 },
      maskAt: { via: { mainOff: 0x0b }, off: 0x0a },
    },
    tileGroup: { kind: 'frameIndex' },
    propGroup: { kind: 'immediate', insnAddr: { mainOff: 0x2f } }, // LDA #$02
    misc157C: { kind: 'unwritten' },
    palette: { kind: 'spriteTable' },
    representativeFrame: 0,
    needsHumanReview: true,
    evidence: 'bank_01.asm:1793-1815 SpinyEgg; bank_01.asm:1812-1814 draw tail',
  },

  {
    // $1F Magikoopa, state 2 (the visible cast cycle). `Magikoopa`
    // (bank_01.asm:8413) dispatches on `SpriteTableC2 & 3`; only state 2
    // draws a pose the editor can put a clock on. Its pose selector, its wand
    // and its palette are all computed AROUND `SubSprGfx1`, which is why it
    // needed two new kinds. Derivation in
    // docs/sprites/sprite-engine-divergence.md section 8.
    spriteId: 0x1f,
    // Every address below is `{ mainOff }`: a byte offset past the MAIN
    // pointer the cart holds at entry $1F, which is $BDD6 on all six carts in
    // `test/roms/`. Offsets, not addresses, so a hack that relocates the
    // handler still resolves. The absolute addresses they correspond to on
    // vanilla are in docs/sprites/sprite-engine-divergence.md section 9.
    routine: 'sub1',
    routineJsr: { mainOff: 0xd6 }, // JSR SubSprGfx1, bank_01.asm:8529
    vanillaMainHandler: 0xbdd6,
    vanillaInitHandler: 0xbdb8,
    // The state-2 countdown seeds at $70 and is decremented once per game
    // frame, so 113 distinct frame indices map onto 4 tile-group values.
    frames: 0x71,
    anim: { kind: 'stateTimer', seedOperandAddr: { mainOff: 0x24d } },
    tileGroup: {
      // `DATA_01BE69[timer >> 6] | ((timer >> 3) & 1)`, bank_01.asm:8513-8528.
      // Both shifts are runs of `LSR A` and are counted, not stored.
      kind: 'shiftedTable',
      operandAddr: { mainOff: 0xd1 },
      operandBank: 0x01,
      shift: { scan: { mainOff: 0xc0 }, max: 8 },
      orBit: {
        shift: { scan: { mainOff: 0xcb }, max: 8 },
        maskAddr: { mainOff: 0xcf },
      },
    },
    tileNudges: [
      {
        // 1 px down on the TOP large OBJ, on the cast pose that the OR bit
        // selects. The only rendered effect that bit has, so dropping it is
        // now visible in the output rather than silently harmless.
        windowBase: { mainOff: 0xde },
        windowSize: { mainOff: 0xe0 },
        bitSelect: { scan: { mainOff: 0xe3 }, max: 8 },
        insnAddr: { mainOff: 0xea },
        evidence: 'bank_01.asm:8530-8539 CODE_01BE96 post-JSR Y nudge',
      },
    ],
    extraParts: [
      {
        // The wand. Its own OAM entry at +$108, behind the body's +$100 and
        // +$104, drawn only once the cast poses start. In the wind-up poses
        // the wand is part of the body tilemap instead, held in close.
        oamSlot: 0x08,
        char: { kind: 'immediateAt', addr: { mainOff: 0x12f } },
        dx: { kind: 'tableByMisc157C', operandAddr: { mainOff: 0x106 }, operandBank: 0x01 },
        dy: { kind: 'immediateAt', addr: { mainOff: 0x118 } },
        gate: { kind: 'tileGroupAtLeast', operandAddr: { mainOff: 0xfc } },
        evidence: 'bank_01.asm:8545-8578 CODE_01BE6E wand tail',
      },
    ],
    misc157C: { kind: 'faceMario' },
    palette: {
      // Operand of `LDA.L MagiKoopaPals,X`: the opcode BF sits at handler
      // offset $260, so the 24-bit operand is at $261 and resolves to
      // $03:B902 on vanilla.
      kind: 'dynamicCgram',
      operandAddr: { mainOff: 0x261 },
      colorsPerEntry: 8,
      entryCount: 8,
      cgramStart: 0xf0,
      // The fade uploads entries `0 .. imm - 2` (bank_01.asm:8726-8740), so
      // the one left standing is 7. The literal is the fallback for a cart
      // whose routine is not this shape. Divergence report 11.3.
      restingEntry: 7,
      restingEntryCmpAddr: { mainOff: 0x246 },
    },
    // Timer $30 gives tile group $04: the cast pose, wand out, no bob. The
    // wind-up poses read as a hunched blob out of context.
    representativeFrame: 0x30,
    needsHumanReview: false,
    evidence: 'bank_01.asm:8493-8580 CODE_01BE6E; bank_01.asm:8733-8756 CODE_01C028 CGRAM upload',
  },

  {
    // $2C Yoshi Egg. One 16x16 large OBJ. `InitYoshiEgg` picks the OBJ
    // attribute from a 4-entry table indexed by `(SpriteXPosLow >> 4) & 3`,
    // so the egg's colour is a function of the 16 px column it spawns in.
    // That is an INIT-routine palette override: the init routine never
    // draws, which is exactly why it is easy to miss.
    spriteId: 0x2c,
    routine: 'sub2',
    routineJsr: { mainOff: 0x29 }, // JSR SubSprGfx2Entry1, bank_01.asm:16058
    vanillaMainHandler: 0xf764,
    vanillaInitHandler: 0x8339,
    frames: 1,
    anim: { kind: 'static' },
    // Documentation only: `tileOverrides` below replaces the routine's own
    // tile read, so this never reaches the output.
    tileGroup: { kind: 'const', value: 0 },
    tileOverrides: [
      {
        // `LDA #$00 : STA OAMTileNo+$100,Y` right after the `JSR`, so the
        // resting egg's char is this immediate and NOT `SprTilemap`.
        insnAddr: { mainOff: 0x2f },
        oamSlot: 0x00,
        evidence: 'bank_01.asm:16057-16062 CODE_01F78D post-JSR tile override',
      },
    ],
    misc157C: { kind: 'unwritten' },
    // `YoshiPal`'s address is the operand of `LDA.W YoshiPal,Y` inside
    // `InitYoshiEgg`: the opcode B9 sits at $01:8342, so the operand word is
    // at $01:8343 and resolves to $01:8335 on the vanilla cart. Storing the
    // OPERAND address rather than the table address means a hack that moves
    // the table still renders, as long as the handler itself is intact.
    palette: {
      kind: 'initTableByX',
      operandAddr: 0x018343,
      operandBank: 0x01,
      entries: 4,
      shift: 4,
      mask: 3,
    },
    representativeFrame: 0,
    needsHumanReview: true,
    evidence: 'bank_01.asm:16039-16062 YoshiEgg draw; bank_01.asm:463-474 InitYoshiEgg',
  },

  {
    // $4D Monty Mole. `CODE_01E343` (bank_01.asm:13388) is the cleanest
    // example of the descriptor pattern in the whole game:
    //   frame     = (EffFrame >> 4) & 1
    //   Misc1602  = DATA_01E35F[frame]     ; tile-group table
    //   A         = DATA_01E361[frame]     ; prop-group table
    //   JSR SubSprGfx0Entry0
    // Both tables are read from the cart, never copied here.
    //
    // representativeFrame: the mole's resting pose is rubble, because it
    // burrows. A human reviewed the poses and chose the front-facing mole
    // as the recognisable one for a picker. Reviewed, so no review flag.
    // Offsets past the MAIN pointer $E2CF; `+$74` and `+$90` resolve to the
    // `CODE_01E343` and `DATA_01E35F` labels, cross-checking the base twice.
    spriteId: 0x4d,
    routine: 'sub0',
    routineJsr: { mainOff: 0x8c }, // JSR SubSprGfx0Entry0, bank_01.asm:13402
    vanillaMainHandler: 0xe2cf,
    vanillaInitHandler: 0x84ce,
    frames: 2,
    anim: { kind: 'effFrame', shift: 4, mask: 1 },
    // Both table ADDRESSES come from the operands of the `LDA abs,Y` that
    // read them (bank_01.asm:13399, 13401).
    tileGroup: { kind: 'tableViaOperand', operandAddr: { mainOff: 0x84 }, operandBank: 0x01 },
    propGroup: { kind: 'tableViaOperand', operandAddr: { mainOff: 0x8a }, operandBank: 0x01 },
    misc157C: { kind: 'faceMario' },
    palette: { kind: 'spriteTable' },
    representativeFrame: 1,
    needsHumanReview: false,
    evidence: 'bank_01.asm:13388-13403 CODE_01E343',
  },

  {
    // $4E Monty Mole on a ledge. Shares `MontyMole`'s handler but takes the
    // OTHER branch of `CODE_01E343` (bank_01.asm:13411-13422): it overrides
    // `SpriteOBJAttribute` with `((EffFrame << 2) & $C0) | $31`, pins
    // `SpriteMisc1602` to $03 and calls `SubSprGfx2Entry1`.
    //
    // So $4E is a ONE-TILE sprite whose four poses come from rotating the
    // hardware flip bits, not from four tiles. `buildSpriteLayout`
    // classifies it as sub0, which is the documented $4E defect.
    spriteId: 0x4e,
    routine: 'sub2',
    routineJsr: { mainOff: 0xa4 }, // JSR SubSprGfx2Entry1, bank_01.asm:13420
    vanillaMainHandler: 0xe2cf,
    vanillaInitHandler: 0x84ce,
    frames: 4,
    // `(EffFrame << 2) & $C0` is algebraically `(EffFrame & $30) << 2`, so the
    // four poses are driven by EffFrame bits 4-5: one pose every 16 game
    // frames, 64 frames for the full rotation.
    anim: { kind: 'effFrame', shift: 4, mask: 3 },
    tileGroup: { kind: 'immediate', insnAddr: { mainOff: 0x9f } }, // LDA #$03
    attrOverride: { kind: 'effFrameFlip', shl: 2, andMask: 0xc0, orMask: 0x31 },
    misc157C: { kind: 'unwritten' },
    palette: { kind: 'spriteTable' },
    representativeFrame: 0,
    needsHumanReview: true,
    evidence: 'bank_01.asm:13411-13422 CODE_01E343 non-$4D branch',
  },
]
