# Sprite dispatch chains: reading through the shared handler stubs

Evidence scope for everything below: static reads against `C:\Projects\SMWDisX`
with every cited line number checked by opening the file at it, plus the raw
bytes of the six cart files in `test/roms/` (vanilla, magic, Grand Poo World 2
1.1, GrandPooWorld V1.2, Invictus 1.0, Seven Vanilla Levels; six files, five
carts, because magic is vanilla plus a copier header). No emulator was run.
Nothing here is dynamically confirmed.

Implementation: `src/rom/dispatch/DispatchChain.ts`.
Tests: `test/suite/unit/dispatch/DispatchChain.test.ts`.

Lifted from `feature/generic-sprite-renderer`. Sections that describe that
branch's draw engine have been cut; what remains is the chain grammar itself,
which is what `SpriteTileLoader` uses.

## 1 The problem the MAIN pointer table does not solve

`SPRITE_MAIN_PTR_TABLE` ($01:85CC) holds 201 sixteen-bit handler pointers.
The engine's first design rule is to key on the resolved handler pointer
rather than the sprite id, on the grounds that the id is a label and the
handler is the identity. Measured across all six carts, that rule buys less
than it looks:

| Measurement | Value, identical on all six carts |
|---|---|
| Entries | 201 |
| Distinct pointer values | 104 |
| Ids sharing a pointer with at least one other id | 126 |
| Entries that are a five-byte `JSL long : RTS` stub | 83 |
| Distinct stubs | 35 |
| Ids behind the largest single stub | 37 |

So for 83 of 201 ids the pointer does not name a handler at all. It names a
thunk, and the code that draws is somewhere behind it.

The five stubs that more than one id shares, and what each leads to:

| Stub | Ids | Target | Label | Shape behind it |
|---|---|---|---|---|
| $01:878E | 37 | $03:A118 | `Bnk3CallSprMain` bank_03.asm:4305 | a `CMP`/`BNE`/`JSR` chain |
| $01:886A | 8 | $02:C1F5 | `ChucksMain` bank_02.asm:8758 | no chain: one body for all 8 |
| $01:875E | 3 | $03:9C34 | `InvisBlk_DinosMain` bank_03.asm:3655 | a single `JSL`/`RTL` split |
| $01:8793 | 3 | $02:D617 | `Banzai_Rotating` bank_02.asm:11365 | a two-way split joined by `BRA` |
| $01:87BB | 2 | $02:E0C5 | `JumpingPiranhaMain` bank_02.asm:12804 | no dispatch: one body for both |

53 ids sit behind those five. **Only the first has a chain.** The other four
are four different shapes, and a reader that tried to cover all five with one
grammar would be four bespoke parsers in a trench coat. They are refused, one
named byte each, and section 4 lists where.

Note also that $01:8806 (id $46) and $01:886A (ids $91-$98) are two different
stubs with the same target, `ChucksMain`. Nine ids run that code and no
pointer comparison groups them, which is a collision axis even the stub
target does not close.

## 2 The grammar

`Bnk3CallSprMain` is not a pointer table. It is a run of links, each of which
compares the sprite number against one immediate and calls one routine. The
byte forms below were derived from bank_03.asm:4305-4525 and then confirmed
against the raw cart bytes.

```
prologue    8B 4B AB B5 9E        PHB PHK PLB LDA SpriteNumber,X   :4306-4309
reload         B5 9E              LDA SpriteNumber,X               :4445
simple link C9 ii D0 05 20 ll hh AB 6B
                                  CMP #ii / BNE +5 / JSR / PLB / RTL
paired link C9 ii F0 04 C9 jj D0 05 20 ll hh AB 6B
                                  CMP #ii / BEQ +4 / CMP #jj / BNE +5 / JSR ...
tail        anything not C9       the block an unmatched id reaches :4521
```

`SpriteNumber` is direct page $9E, read out of the cart rather than assumed:
the operand byte is part of the opcode check, so a chain that dispatched on
some other byte is refused instead of being mapped as though it keyed on the
sprite number.

The two branch displacements are the load-bearing part. Neither is
*followed*. Each is compared for **equality** with a length this reader
measured from the opcodes it just read:

- a link's `BNE` must skip exactly `JSR`(3) + `PLB`(1) + `RTL`(1) = 5 bytes,
- a paired `BEQ` must land exactly on that link's own `JSR`.

That is what makes the id-to-routine pairing structural rather than assumed.
A link with anything inserted into it stops matching its own geometry and is
refused, instead of being silently re-cut at the wrong offset and taking
every link below it with it.

### Why this is reading and not simulating

The reader holds no registers, evaluates no condition, and never asks whether
a branch is taken. It reads a fixed sequence of bytes at offsets derived from
the previous opcode's own length, exactly as the existing `CodeRef` `{ via }`
hops do, and checks each one. The id attached to a routine is the `CMP`
immediate physically adjacent to the `JSR`, which is a static datum in the
cart, not a fact about execution.

## 3 What it recovers

Identical on all six carts:

| Measurement | Value |
|---|---|
| Links read | 34 |
| Ids claimed by a link | 36 |
| Paired links | 2 ($B8/$B7 and $AC/$AD) |
| Mid-chain reloads stepped over | 1 (bank_03.asm:4445) |
| Ids left to the tail block | 1 ($A0) |
| **Ids accounted for** | **37, the whole stub** |

$AB resolves to $03:9517 `RexMainRt`, $B8 and $B7 both to $03:8C2F
`CarrotTopLift`, $AC and $AD both to $03:9423 `WoodenSpike`, all three
cross-checked against `SMWDisX/SMW_U.sym`.

$A0 is reported as a **fallthrough address**, not as a routine, and
deliberately so. The tail block at $03:A259 is `JSL : JSR : JSR : PLB : RTL`
(bank_03.asm:4521-4525), three calls rather than one, so there is no single
routine to name and the reader does not invent one.

Which ids fall through is not stored anywhere. It is whatever is left after
the chain is read, so a hack that adds a link for $A0 moves it out of the
fallthrough set with no change here.

## 4 What it refuses

Every refusal names the address, the grammar element expected and the byte
found. The four non-chain stubs, each refused at a different point, which is
itself the evidence that they are four different shapes:

| Stub target | Refused at | Expected | Found |
|---|---|---|---|
| `ChucksMain` bank_02.asm:8758 | prologue byte 3 | `LDA dp,X` | $BD, `LDA abs,X` on `SpriteMisc187B` |
| `InvisBlk_DinosMain` bank_03.asm:3655 | prologue byte 0 | `PHB` | $B5, it has no prologue |
| `Banzai_Rotating` bank_02.asm:11365 | link 0 tail | `PLB` | $80, a `BRA` to a join |
| `JumpingPiranhaMain` bank_02.asm:12804 | prologue byte 3 | `LDA dp,X` | $20, straight into a `JSR` |

Across the corpus that is 46 of the 83 stub-pointed ids refused and left
unmapped. None of them is given a guessed routine.

The walk is also bounded at `MAX_CHAIN_LINKS` (64, against a longest observed
chain of 34), so a corrupted chain terminates instead of running to the end
of the bank.

## 5 What the sharing still hides

**The plain shared handlers.** 73 of the 126 colliding ids share a pointer
that is a real handler, not a stub, so there is no chain to read:
`Spr0to13Start` $01:8AFC (8 ids), `WallFollowers` $01:885E (6),
`ShellessKoopas` $01:8904 (4), and so on down to 12 pointers shared by 2. For
those the sharing is real. One routine genuinely serves every id, and it
distinguishes them internally from `SpriteNumber` reads and per-id table
lookups scattered through the body, not at one dispatch point.

**`ChucksMain` and the other three.** Nine ids run `ChucksMain` and the
reader cannot say which Chuck variant a given id draws. The variant selection
is inside `CODE_02C22C`, not at a dispatch point this grammar covers.

**A chain resolution is an observation, not a verification.** The reader can
say $AB currently dispatches to $03:9517. It cannot say that is where $AB was
traced from, because nothing here records a vanilla dispatched routine to
compare against.

## 6 Hack-fragility points

Things a romhack can change that this reader would not notice, or would
notice only as a refusal.

1. **`SpriteNumber` at direct page $9E is assumed.** It is checked as a byte,
   so a chain reading a different address refuses rather than mis-maps, but a
   hack that RELOCATED SMW's sprite tables and updated the chain to match
   would be refused even though its chain is perfectly well-formed.
2. **The `BNE` and `BEQ` polarities are assumed, not read.** The reader
   checks that a `BNE` is present and that it skips the right distance; it
   does not and cannot know that a `BNE` there means "not this id". A hack
   that swapped a link's `BNE` for a `BEQ` of the same displacement would
   invert that link's meaning and read as a normal link. This is the same
   assumption `TileNudge` and `UnmodelledTailCall` already make about their
   own branches.
3. **A rewritten chain that still parses is believed.** That is the point,
   but it means garbage that happens to match the grammar maps as data. The
   geometry checks make accidental matches unlikely rather than impossible.
4. **The tail block is not decoded.** Any id that falls through gets an
   address. If a hack turns the tail into a fourth dispatch idiom, the ids
   reaching it are reported as fallthrough rather than resolved.
5. **Bank mirroring is passed through, not normalised.** Grand Poo World 2,
   Invictus and Seven Vanilla Levels hold the stub's `JSL` target as $83:A118
   rather than $03:A118. Resolved routines carry the same bank, which is
   correct for reading but means a caller comparing two carts' addresses must
   fold bit 23 itself.
6. **`readHandlerThunk` assumes the handler bank is $01.** `resolveDispatch`
   takes the bank as a parameter defaulting to $01, which is right for every
   cart measured, but it is a default rather than a read.
