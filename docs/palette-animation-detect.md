# Palette animation detection

How `src/rom/PaletteAnimationDetect.ts` decides which CGRAM indices a
cartridge cycles, where their frame tables are, and how many phases each has.

All three answers are operands inside SMW's NMI handler, not entries in a
data table, so they are read out of the cart rather than named as constants.
`PaletteAnimationLoader.ts` turns the result into the per-frame patches the
palette views replay. A context whose bytes do not decode reports itself
unavailable and emits nothing; callers read that as "unknown", never as
"nothing animates" and never as the stock answer.

Reading the operands rather than naming them means the frame table's address
is not a regional constant: `FlashingColors` sits at `$00B60C` in U,
`$00B61F` in E0 and E1, `$00B5AC` in J and `$00B61C` in SS, and the operand
gives whichever one this cart holds. The module is NOT region-portable as a
whole, because the probe addresses themselves are U: in J the kernel is at
`$00A3BA`, so a J cart reports unavailable rather than wrong.

## The shared CGRAM flash kernel

`bank_00.asm:4667-4677`. One kernel writes a single BGR555 word to CGRAM. It
has two entry points: `CODE_00A41C` zeroes the sub-table base first,
`CODE_00A41E` does not, so a caller that preloads the base reaches a second
table in the same block.

What the decoder reads, in order, and what each byte gives it:

| instruction | what the decoder takes from it |
|---|---|
| `STA $2121` | anchor; the CGRAM index is already in A from the caller |
| `LDA dp` | the phase counter, `EffFrame` `$7E0014` (`rammap.asm:60`) |
| `AND #imm` | the phase mask |
| `LSR A` run | the shift, counted rather than assumed |
| `CLC` | optional, not in stock; when present the add is exact |
| `ADC dp` | optional; the direct-page byte holding the sub-table base. A relocated kernel folds the offset into its own operand instead |
| `TAY` or `TAX` | which index register, so the matching load can be read |
| `LDA abs,Y` or `abs,X` | the frame table operand |

| `STA $2122` | anchor |
| second `LDA abs,Y` | must be the first operand plus 1, so the two reads form one word |
| `RTS`, `RTL` or neither | optional; the call convention, not part of what makes this a palette write |

The frame table operand is 16-bit, so it needs a bank. The NMI prologue's
`PHK / PLB` (`bank_00.asm:201-202`) installs the program bank as the data
bank, and a `JSL` into another bank does not change it, so the operand
resolves against the bank the NMI entry itself lives in. Those two bytes are
checked as part of `NMI_PROLOGUE` rather than merely cited: the bank claim
rests on them, and a cart that had dropped them would otherwise get a
confidently wrong table address.

## The three callers

`bank_00.asm:4663-4665` (level) and `:4779-4784` (overworld). Each is a
different byte shape, which is why `decodeFallThroughCaller`,
`decodeJsrCaller` and `decodePreloadedCaller` are separate:

- **level**: `LDA #imm` carrying the CGRAM index, then a fall-through into
  the zeroing entry.
- **overworld, first target**: `LDA #imm`, then `JSR` to the zeroing entry.
- **overworld, second target**: `LDA #imm` carrying a sub-table base, `STA
  dp`, `LDA #imm` carrying the CGRAM index, then `JMP` past the zeroing
  entry so the preloaded base survives.

Each caller's `STZ dp` or `STA dp` must name the same direct-page byte the
kernel's `ADC dp` reads, or the base never reaches the index. That link is
checked, not assumed.

### Relocated routines

A cart may move the whole overworld upload out of bank $00 and replace
`$00A4E3` with the long call that reaches it. Grand Poo World 2 does exactly
this: `$00A4E3` holds `JSL $1BBE20 / RTS`, and everything after it, including
the stock callers at `$00A513` and `$00A518`, is dead.

The relocated routine folds its CGRAM index inline rather than using a caller
that jumps to a shared kernel, and writes successive targets byte-adjacent:

- `LDA #imm / STA $2121 / ...` is one target, with the kernel immediately
  after the index.
- A following target may omit the counter arithmetic entirely and reuse the
  index register the previous one loaded, folding its sub-table offset into
  its own operand. GPW2's `$7D` write does this.

So the detector follows the `JSL` and then WALKS the routine's instructions
from the landing address to the first CGRAM write its own control flow
reaches. A byte scan is not enough and was actively wrong: every edited cart
in the corpus carries a spare decodable kernel in a high bank, so a scan
finds one whether or not any path reaches it, and a hack that removes the
overworld flash by pointing `$00A4E3` at an `RTL` gets reported as animating
a slot it never touches.

The walk is a linear decode, not an emulation. It tracks the `M` and `X`
widths through `REP`/`SEP` because immediate lengths depend on them, follows
unconditional transfers because where they go is determinate, steps over
calls because they return, and continues straight through conditional
branches without following them. It stops at the first write, at `RTS` /
`RTL` / `RTI`, at an indirect jump, at a bank exit, at a loop, or at a step
limit. Everything except reaching a write reports unavailable.

The data bank is read on the way rather than inherited: a `PHK` / `PLB` in
the relocated routine installs its own bank, and the frame-table operand
resolves against whatever is in force at the write.

Chains are capped at one full write plus one that rides its index, which is
what a flash routine is, and the chain must end where the routine does. A
longer run of adjacent writes means the decode has left the routine it
entered, and a tail write there would inherit arithmetic nothing read at that
address.

## Phases

The kernel indexes its table with `(counter & mask) >> shift`, so the phase
sequence is that expression evaluated in counter order, and its period is
`2^bitlength(mask)` counter ticks.

The sequence is emitted in tick order, never sorted. A non-contiguous mask
revisits earlier offsets partway through its period: `AND #$2C` with one
`LSR` yields
`[0,2,4,6,0,2,4,6,16,18,20,22,16,18,20,22]` over 64 ticks, and sorting the
distinct values would replay 8 frames over 32 ticks and diverge from tick 16.
Stock's `AND #$1C` with one `LSR` gives 8 ascending offsets two bytes apart
over 32 ticks, which is the case that hid this.

Without a `CLC`, the final `LSR` has to shift out a zero: its carry lands in
the `ADC` and would displace half the phases by one byte. That holds exactly
when the mask's bit `shift - 1` is clear, which stock's `$1C` satisfies. A
kernel where neither that nor a `CLC` holds is not decoded.

A mask and shift reaching only one offset is refused rather than reported as
a one-phase cycle, because there is no animation there to report.

The counter itself is read and checked, not assumed: only `TrueFrame`
`$7E0013` and `EffFrame` `$7E0014` (`rammap.asm:52`, `:60`) are accepted,
because the millisecond figure the editors replay at is built on their tick
rate. A kernel counting anything else is not decoded, since a stride in
unknown units is not a cadence.

## Reaching the routine, not merely finding it

Decoding the routine only says it EXISTS. A patch that leaves it intact and
diverts control before it would otherwise read as stock, which is the
commonest patch shape there is. So each context checks its approaches first:

| probe | what it must still be | citation |
|---|---|---|
| `$00FFEA` | native NMI vector arriving at SMW's prologue | `smw.asm:43`, `bank_00.asm:194-196` |
| `$00A418` | `SEP #$20` opening the level block | `bank_00.asm:4662` |
| `$00A3D5`, `$00A3EE` | branches that still land on `$00A418` | `bank_00.asm:4635`, `:4644` |
| `$008237` | `JSR` still calling the overworld routine | `bank_00.asm:288` |
| `$00A4E3` | `REP #$10` opening that routine | `bank_00.asm:4760-4761` |

"Arriving at" rather than "pointing at" because hooking the vector with a
trampoline is ordinary. Three of this repo's six carts point `$00FFEA` at a
stub holding a single `JML $80816A` straight back to the stock handler, and
they do run it; refusing them would be a false negative, which for a palette
view is as wrong as the false positive. Only a leading unconditional jump is
followed, and only a few hops, so a stub that does work before jumping is not
treated as transparent.

**This is not a proof of reachability and must not be described as one.** It
verifies the immediate approaches and the handler's head. A patch that
diverts somewhere in the middle of the NMI, or that relocates the whole NMI
to a modified copy carrying the same prologue, would still pass.

For a relocated routine the walk narrows this considerably but does not close
it: a write reached only by a taken conditional branch is missed, which
reports unavailable, and a write inside a subroutine the routine calls is
missed the same way. Both fail in the safe direction. A write the walk
reaches but that the running game skips on a flag it cannot evaluate would
still be reported.

## What the corpus shows

Measured on this repo's six carts. Addresses only; frame colors are the
cart's bytes and stay out of the repo.

| cart | level | overworld | approach |
|---|---|---|---|
| Super Mario World (USA).vanilla.sfc | `$64` from `$00B60C` | `$6D` from `$00B60C`, `$7D` from `$00B61C` | stock |
| Super Mario World (USA).magic.sfc | same | same | stock, copier header |
| Seven_Vanilla_Levels.sfc | same | same | `$00FFEA` hooked, JML trampoline to stock |
| GrandPooWorld_V1.2.sfc | same | same | stock |
| Grand Poo World 2 1.1.sfc | same | `$6D` from `$00B60C`, `$7D` from `$00B61C` | trampolined NMI; upload moved to `$1BBE20`, writes folded inline at `$1BC0FA` |
| Invictus 1.0.sfc | same | same | `$00FFEA` hooked, JML trampoline to stock |

All readable contexts give 8 phases, one phase every 4 counter ticks.

Grand Poo World 2 replaces the `REP #$10` at `$00A4E3` with `JSL $1BBE20`.
Its relocated routine reaches the same answer by a different shape: `TAX` and
`LDA $B60C,X` instead of `TAY` and `LDA $B60C,Y`, no `ADC` because the `$7D`
sub-table offset is folded into `LDA $B61C,X`, and `RTL` instead of `RTS`.
Those are assembler choices, not different behaviour, which is why the
decoder accepts all of them. Its kernels sit at `$1BC0FC` and `$1BC113`.

## Tests

`test/suite/unit/PaletteAnimationDetect.synthetic.test.ts` builds carts that
break one rule each and runs in CI with no ROM file.
`PaletteAnimationDetect.rom.test.ts` sweeps the corpus, records the observed
slots per cart by name, and patches each real cart in memory to exercise
every refusal shape. It is skipped, not silently green, when `test/roms/` is
absent.
