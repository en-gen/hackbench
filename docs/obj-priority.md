# OBJ priority and the compositor pass list

Why `SmwMap.render` walks a table instead of a fixed sequence, and where
every number in `src/rom/SpritePriorityLoader.ts` and
`src/rom/model/RenderPass.ts` comes from.

## 1. Mode 1 interleaves BG and OBJ priorities

SMW runs BG mode 1. Traceable:

- Header byte 2 bit 7 becomes `MainBGMode`, OR'd with mode 1
  (`bank_05.asm:590-597`); `!HW_BG_BG3Pri` is bit 3
  (`hardware_registers.asm:76`).
- `RegularLevelNMI` writes mode 1 *with* BG3 priority unconditionally
  (`bank_00.asm:237-242`), so the status-bar rows always have BG3 on top.
- The IRQ waits 31 H-blanks (`bank_00.asm:453-454`) and then writes the
  header value back (`bank_00.asm:463-465`), so the header bit governs the
  rest of the frame.

The priority ORDER itself is not in the disassembly and cannot be: it is PPU
silicon, not code. It is taken from
[`snes-superfamicom-selected.md:501-518`](snes-superfamicom-selected.md),
which is hardware documentation and the one link in this chain with no
`SMWDisX` citation. Front to back with the BG3-priority bit SET:

| | layer |
|---|---|
| 1 | BG3.1 |
| 2 | OBJ.3 |
| 3 | BG1.1 |
| 4 | BG2.1 |
| 5 | OBJ.2 |
| 6 | BG1.0 |
| 7 | BG2.0 |
| 8 | OBJ.1 |
| 9 | OBJ.0 |
| 10 | BG3.0 |

With the bit CLEAR the doc says only that BG3.1 "moves from position 1 to
position 8". Renumbering the list after removing it puts BG3.1 between OBJ.1
and OBJ.0, and that is what `RenderPass.ts` encodes. **Unverified against a
second source**; it is the only entry whose placement the doc does not spell
out, and the only pair of orderings the two readings disagree about is
OBJ.1 against BG3.1.

Consequence: "backgrounds, then sprites, then foreground" cannot express
mode 1. OBJ.1 belongs under every BG1 and BG2 tile; OBJ.3 over all of them.

## 2. The per-level default sprite priority is a table read

`SpriteProperties` is `$7E:0064`, bits 5:4 are OBJ priority
(`rammap.asm:518-527`).

The level header parser takes the 5-bit level mode, indexes
`LevXYPPCCCTtbl` ($05:84B7, 32 bytes, `bank_05.asm:505-509`) and stores the
byte to `SpriteProperties` (`bank_05.asm:542-543`).

On "Super Mario World (USA)" that table reads `$20` for modes 0, 1, 2, $0E
and $0F, and `$30` for the other 27 (byte-compared against
`bank_05.asm:506-509`). So **the default is OBJ.2 on five level modes and
OBJ.3 on twenty-seven** -- "sprites default to OBJ priority 2" is false on
this cart.

`bank_00.asm:2401-2402` does write `#!OBJ_Priority2`, but it sits inside
`LoadCastleCutscene`, not the level loader. It is a whole-cart grep of
constant stores to `SpriteProperties` that shows this: outside the handler
sites below, the only two are that one and `bank_05.asm:543`.

The per-sprite half of the OAM attribute contributes no priority bits:
`LoadSpriteTables` masks `Sprite166EVals` with `#$0F` before storing it
(`bank_07.asm:977-980`), and the shared draw routines OR the two halves
(`bank_01.asm:3870-3871`, `:4169-4173`, `:9628-9629`). So the effective OBJ
priority is whatever `SpriteProperties` holds.

## 3. The per-handler lowering is read as opcodes, not hardcoded

`CallSpriteMain` ends in `JSL ExecutePtr` followed by a `dw` table
(`bank_01.asm:893-896`), so sprite id N's handler is the word at
`$01:85CC + N*2`, bank `$01`.

Handlers that draw behind scenery open with `LDA #imm : STA $64` -- e.g.
`ClassicPiranhas` at `bank_01.asm:2113-2114`, reached from sprite ids `$1A`
and `$2A`. `SpritePriorityLoader` walks real 65816 instructions from the
handler entry to the first unconditional control transfer and reads that
immediate off the cart, so a repointed handler or an altered constant reads
correctly.

Why an instruction walk and not a byte search: a raw 4-byte search for
`A9 ?? 85 64` gives a different answer for every window size -- on the
vanilla cart it finds the pattern for 12 sprite ids at 128 bytes, 18 at 256
and 23 at 512, because past the routine's `RTS` it is reading unrelated
code. The walk has no such free parameter.

What the walk finds on the vanilla cart: **7 sprite ids** (`$1A`, `$2A`,
`$79`, `$7D`, `$7E`, `$7F`, `$80`) reach a lowering to OBJ.1 on the
straight-line path from their handler entry. The walk does not follow
branches or `JSL`, so the four bank_02 sites (`:7482`, `:12816`, `:12995`,
`:13750`) and the bank_01 sites past an unconditional transfer are not
reached, and those sprites keep the level default. That is a false negative,
not a wrong answer.

### Honest degradation

Four bank_01 sites gate the lowering on `SpriteBehindScene` ($1632):
`:3762-3767`, `:3782-3787`, `:7979-7984`, `:9331-9335`. That flag is
per-instance runtime state -- zeroed at spawn (`bank_07.asm:935`), set only
by the sprite-killed path (`bank_01.asm:3671-3672`) and the Pipe Lakitu
branch (`:3751-3752`). A still frame has no value for it.

When the walk reaches a lowering within two instructions of a
`LDA.W SpriteBehindScene,X`, the loader returns the level default with
`source: 'runtimeGated'` rather than asserting the lowered value. On the
vanilla cart this never fires, because all four such sites sit past an
unconditional transfer from their handler entry; it is covered by a
synthetic-ROM test instead.

## 4. The pass list is per level

`SmwMap.passes()` filters the mode-1 order to the `(layer, priority)` pairs
this level occupies: L1 and L2 from their Map16 subtile priority bits, L3
from its tile-word priority bit, sprites from the distinct
`sprite.priority.value`. A romhack that sets the priority bit on one of the
19 BG Map16 tiles that carry it gets a correct L2 split with no new code,
because the order is the PPU's and not ours.

Two things the pass model cannot express, and does not try to: the
status-bar rows, where the NMI forces BG3 priority regardless of the header
(§1), and anything HDMA does mid-frame. Both are per-scanline register
state; a still compositor picks one scanline's worth.
