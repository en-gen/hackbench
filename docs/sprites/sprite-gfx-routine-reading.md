# Reading a sprite's draw routine off the ROM

Evidence scope for everything below: static reads against `C:\Projects\SMWDisX`
with every cited line number checked by opening the file at it, plus the raw
bytes of the six ROM files in `test/roms/` (vanilla, magic, Grand Poo World 2
1.1, GrandPooWorld V1.2, Invictus 1.0, Seven Vanilla Levels; six files, five
ROMs, because magic is vanilla plus a copier header). No emulator was run.
Nothing here is dynamically confirmed.

Implementation: `src/rom/dispatch/HandlerWalk.ts` and
`src/rom/dispatch/GfxRoutineReader.ts`.
Tests: `test/suite/unit/dispatch/HandlerWalk.test.ts` and
`test/suite/unit/dispatch/GfxRoutineReader.test.ts`.
The dispatch chain this builds on: `docs/sprites/sprite-dispatch-chains.md`.

## 1 What was frozen, and why that is a defect

`SpriteTileLoader.ts` carried four hand-extracted tables. A frozen derivation
is not the same thing as a constant: it is an answer that WAS true of one
ROM's code, presented as though it were a property of the format. Open a
romhack and it renders the vanilla answer, confidently, with nothing on
screen to say the ROM disagrees.

`SPRITE_GFX_OVERRIDES` was the worst of the four because the thing it encodes
is a single `JSR` operand in the sprite's own handler, which is about as
readable as ROM data gets.

## 2 The walk

`HandlerWalk` decodes 65816 forward from a handler entry:

- Every opcode's length comes from a 256-entry table. The 65816 defines all
  256 opcodes, so a decode never meets an unknown byte.
- The only machine state tracked is M and X, because they alone decide
  whether `LDA #imm` is two bytes or three. `REP`/`SEP` update them. Entry is
  assumed 8-bit, which is how `CallSpriteMain` (bank_01.asm:893) reaches a
  handler. That tracking is incomplete in four ways: section 9.
- Conditional branches are queued and both sides walked. `BRA`, `BRL`,
  `JMP abs` and `JML long` are followed.
- `JSR`/`JSL` targets are matched against the watch list; anything else is
  descended into, to a depth of 3.
- `RTS`, `RTL`, `RTI`, `STP` and `WAI` end the path.
- A call whose callee can reach no `RTS`, `RTL` or `RTI` ends the path with
  a reason. Control does not come back, so the bytes after the call site are
  not the next instruction. `JSL ExecutePtr` (bank_00.asm:847) is the case
  this exists for: it ends `JML [_0]` and consumes an inline `dw` table as
  its argument. The test is on the callee's own shape, so a relocated or
  hand-written equivalent declines too. An earlier version matched
  `ExecutePtr` by address, and copying its body to $00:FFB0 and repointing
  the one `JSL` in Magikoopa's handler turned `$1F` from `unreached` into a
  confident `read: sub1` derived from decoding pointer bytes as opcodes.
- A call the probe could not decide also ends the path, with the refusal
  named: `probeBudget` when the callee outran the probe's state ceiling,
  `probeDepth` when it nested past the probe's recursion bound. An
  undecided call is not evidence that control comes back. Both used to be
  read as "returns"; "Bounds" below is what changed and what it was
  measured against.
- `JMP (abs)`, `JMP (abs,X)`, `JML [abs]` and `JSR (abs,X)` end the path with
  a reason, for the same lack of a bound.

It is not an emulator. No condition is evaluated, no memory is modelled, and
the result is the SET of watched routines reachable, not the one that runs.

### What the probe assumes, and the one thing it gets wrong

The probe answers "can control return from this call", by the same decode,
and its answer decides whether the bytes after the call site are code. Three
properties of it are worth stating because none is obvious:

- **A cycle through a call is assumed to return.** That is what a recursive
  subroutine does. The assumption is temporary and is never written into the
  memo, so a verdict does not depend on the order the addresses were asked
  about. It used to: the memo was seeded optimistically to break the cycle,
  nested probes consumed the seed and then committed their own verdicts on
  top of it, and `A: JSR B ; JML [$0000]` with `B: JSR A ; RTS` gave B
  opposite answers depending on whether A had been probed first.
- **A cycle that closes inside one probe is not.** Going round a loop
  forever is not returning, so the repeated-state check breaks the loop
  without setting a return. The code was always right about this; an earlier
  version of this document said "a cycle is read as returning", which
  overstated the problem in the safe direction.
- **"Reaches a return" is not "returns to `callAt + len`", and this is a
  hole.** A routine that pops its return address, steps it past an inline
  argument table and pushes it back satisfies the probe while control
  resumes somewhere else entirely. Planted at $00:86DF this fabricates,
  where the hardcoded `EXECUTE_PTR` constant the probe replaced refused
  unconditionally. Vanilla `ExecutePtr` (bank_00.asm:847) is `PLY`/`PLA`/
  `JML [_0]` and so has no reachable return at all, which is why the corpus
  never meets it. Not fixed: the cheap conservative guard would be to refuse
  when a callee manipulates the return address on the stack, and that has
  not been designed or measured.

### Bounds

Both of the probe's ceilings refuse when they are hit, which degrades to the
frozen floor in `SPRITE_GFX_OVERRIDES`. Neither is reached on the six ROMs,
and both were measured by lowering them until a verdict on vanilla moved:

| Ceiling | Value | Lowest value that still changes nothing |
|---|---|---|
| `DEFAULT_PROBE_BUDGET` | 1500 | 159 |
| `DEFAULT_PROBE_DEPTH` | 64 | 5 |

The budget counts distinct `(address, M, X)` states across every branch
side, not straight-line length, so a branchy non-returning dispatcher
reaches it well short of 1500 real instructions. Before, exhausting it read
as "returns", and the walk then decoded whatever followed the call as code:
measured on a synthetic ROM, 1499 NOPs in front of a dead end gave "does
not return" and 1500 gave "returns".

The depth bound exists because the probe was the only unbounded recursion
here. `walkHandler`'s own descent is bounded by `callDepth`; the probe
recursed on every `JSR`/`JSL` with nothing but the memo to stop it, and a
chain of roughly 4000 distinct call targets raised `RangeError: Maximum call
stack size exceeded` out of `walkHandler` and `readGfxRoutines` into the map
build. A crash is worse than a wrong answer and far worse than a refusal.

### Depth

Swept 2, 3, 4, 5, 6 and 8 on vanilla: identical tallies at every value.
Depth 3 is kept because it matches what the frozen extraction claimed to use.
Exceeding it costs coverage and not soundness: a call too deep to descend
into is still probed for whether it returns.

### Cost

84 walks take about 36 ms cold on vanilla, best of eight in-process runs.
It was 22 ms until `RomFile.readAt` was made to return a copy rather than a
window onto the ROM buffer; measured by planting that one change on the
otherwise unmodified reader, the whole 14 ms is the per-instruction
allocation in `decode` and none of it is the probe. Whether that is worth
buying back with a fill-a-caller's-buffer read is an open question, not a
decision made here.

`readGfxRoutines` caches per ROM, invalidated by a counter that
`RomFile.writeAt` bumps, because a map build reruns on every toolbar change
and this was otherwise the largest single term in it. That invalidation
rests on `writeAt` being the only way the bytes change, which was not true
while `readAt` returned a live `Buffer.prototype.slice` view; it is now, up
to the public `buffer` field, which nothing writes through. Warm the read is
under 0.05 ms. `buildSprites` also returns before reading the tables at all
when the level has no sprites.

## 3 The six entry points and three trampolines

| Address | Routine | Label, checked in `bank_01.asm` |
|---|---|---|
| $01:9CF3 | sub0 | `SubSprGfx0Entry0` :3853 |
| $01:9CF5 | sub0 | `SubSprGfx0Entry1` :3855 |
| $01:9D67 | sub1 | `SubSprGfx1` :3920 |
| $01:9F09 | sub2 | `SubSprGfx2Entry0` :4144 |
| $01:9F0D | sub2 | `SubSprGfx2Entry1` :4148 |
| $01:8042 | sub0 | `GenericSprGfxRt0` :61 |
| $01:9D5F | sub1 | `GenericSprGfxRt1` :3912 |
| $01:90B2 | sub2 | `GenericSprGfxRt2` :2393 |

The three `GenericSprGfxRtN` entries are `PHB PHK PLB : JSR <shared> : PLB
RTL`. Every caller outside bank $01 goes through one, which is why grepping
for `JSR SubSprGfx` undercounts the callers by roughly a third.

These eight addresses are hardcoded, and that is a real fragility: a hack
that relocates `SubSprGfx1` makes every sprite that used it report
`unreached`, and the caller falls back to the frozen floor in
`SPRITE_GFX_OVERRIDES`. That is a degradation rather than a fabrication,
which is why the floor is kept at its full 17 entries rather than trimmed
to the four the walk never reaches.

## 4 The routine selector

Where a handler reaches two shared routines, one branch usually chooses. The
reader looks for a branch whose accumulator came from
`LDY SpriteNumber,X : LDA table,Y : AND #mask`, walks each side with the
other side's entry blocked, and takes the split only when each side reaches
exactly one routine and the two differ. Then it reads `table + spriteId` from
the ROM, applies `mask`, and resolves by the branch's own opcode: `BNE`
means the set case takes the branch, `BEQ` means it does not.

On all six ROMs this finds exactly one selector, `Spr0to13Gfx`
bank_01.asm:1762-1765:

```
LDY.B SpriteNumber,X
LDA.W Spr0to13Prop,Y
AND.B #$40
BNE CODE_018BEC          ; two tiles high
```

Table $01:88F0, mask $40, set goes to sub1, clear goes to sub2. All four of
those facts are read, not remembered, and each has a planted-byte test.

It covers 17 ids: $00-$0D, $0F, $11, $13. The frozen list it replaces named
12 of them, leaving out $00-$03 and $0D. The omission never showed, because
`Spr0to13Prop` has bit 6 clear for all five on every ROM measured; only
$04-$0C have it set. The reader covers them because the code path does.

## 5 What resolves, measured

Ids $00-$53, the range `SprTilemapOffset` covers:

| | vanilla | magic | GPW2 1.1 | GPW V1.2 | Invictus | 7 Vanilla Levels |
|---|---|---|---|---|---|---|
| `read` (one routine) | 40 | 40 | 39 | 40 | 40 | 40 |
| `selected` (selector) | 17 | 17 | 17 | 17 | 17 | 17 |
| `ambiguous` | 5 | 5 | 5 | 5 | 5 | 5 |
| `unreached` | 22 | 22 | 23 | 22 | 22 | 22 |
| **resolved** | **57** | **57** | **56** | **57** | **57** | **57** |

**Zero of the resolutions contradict the frozen table they replace, on any of
the six.** That is what makes preferring the live answer a swap rather than a
behaviour change.

Grand Poo World 2 1.1 is the interesting column. Id $21's MAIN pointer still
reads $01:C353, the vanilla address, but the code behind it is patched and
the draw call now sits behind a computed dispatch. The pointer is unchanged
and the body is not, which is precisely the shape of change a frozen table
cannot see.

### The five ambiguous

$33, $3F, $40, $4F, $50 each reach both sub0 and sub2 with no branch between
them, because the sprite draws more than one part and uses a different
routine for each. Para-Goomba ($3F) draws a parachute through sub2 and a body
through sub0 in sequence (`ParachuteSprites`, bank_01.asm:11558).
`buildSpriteLayout` already special-cases $3F and $40 for exactly this
reason. There is no single answer to give, so none is given.

### The 22 unreached, and the 4 that stay frozen

Of the 22, 18 were already defaulting to sub2 and still do. Four were in the
frozen table and stay there:

| Id | Sprite | Why the walk cannot reach the call |
|---|---|---|
| $1F | Magikoopa | `JSL ExecutePtr` in the handler |
| $4D | Ground Monty Mole | `JSL ExecutePtr` in the handler |
| $4E | Ledge Monty Mole | `JSL ExecutePtr` in the handler |
| $27 | Thwimp | no shared call found; a `callDepth` stop is recorded, but depth 8 finds none either |

$27 is the only one a bigger budget might reach; raising the depth to 8
does not, so whatever separates it is not a call chain.

## 6 The base-tile table: measured, and not replaced

`SPRITE_BASE_TILE_OVERRIDES` holds 98 values for ids $54-$C8. Its previous
comment claimed it was auto-extracted by following each handler to depth 3
and capturing the first `LDA ... STA OAMTileNo` pair, an immediate's operand
or an indexed load's first table byte.

That rule was reimplemented on top of `HandlerWalk` and run against the
table. On every one of the six ROMs:

| | count |
|---|---|
| live value equals the frozen value | 35 |
| live value differs | 58 |
| no store reachable at all | 5 |

So the stated method reproduces about a third of its own output. The table is
curated, not extracted, and the comment claiming otherwise is the thing most
worth fixing about it.

Three reasons the disagreements are not bugs in the reimplementation:

1. **The first store is usually not the sprite's own.** The value $82 comes
   back for 32 of the 58 on five of the six files and 27 on Grand Poo
   World 2 1.1, from a shared OAM preamble that runs before the
   handler writes its own tile. "First" in reachability order is not "first"
   in the sense a human reading the routine means.
2. **Table-sourced tiles need an index the ROM does not hold statically.**
   `PowerUpTiles` serves $74-$78 at indices 0 through 4; the index is an
   animation or state byte in RAM. Taking element 0 is right once in five.
   The frozen table has all five correct, which is itself proof it was
   indexed by hand.
3. **Which store is representative is a judgement.** $88 takes the value on
   the `BCC`-taken side. Nothing in the bytes says that side is the one to
   show a level editor.

Keeping the 35 that agree and freezing the other 63 would be calibration
against the frozen table itself, so nothing was kept.

A weaker check was measured and also rejected: collect every value the
handler can store to `OAMTileNo` (immediates, plus the first 16 bytes of any
table it indexes) and warn when the frozen value is not among them. On
vanilla that warns on 8 of the 98 correct entries, and on the other five
ROMs it produces the identical 8, so it never fires on a real difference in
this corpus. An 8 percent false-alarm rate with no demonstrated true
positive is not worth the code.

## 7 What a hack still changes without us noticing

1. **Every value in `SPRITE_BASE_TILE_OVERRIDES`, `SPRITE_TALL_OVERRIDES`,
   `SPRITE_WIDE_OVERRIDES` and `SPRITE_LOW_RANGE_OVERRIDES`.** Nothing reads
   these off the ROM.
2. **The `sub2` default** that an id with no reading and no floor entry
   falls back to, and the 17 floor values themselves wherever the walk does
   not resolve. `SUB0_GFX_PROP_GROUP` is the same: read live for the three
   `sub0` ids the walk resolves, frozen for the rest.
3. **A relocated shared draw routine.** Degrades to `unreached`, which falls
   back to the frozen floor rather than to a wrong live answer. This is the
   only degradation direction the corpus demonstrates; it is not a general
   guarantee, and section 9 is the counter-example.
4. **A selector whose polarity was inverted along with its mask** such that
   the two changes cancel. Read as the original.
5. **Anything behind a computed jump, a non-returning call, or a call the
   probe declined to decide.** The walk stops and reports; it does not guess
   the table's length and does not report what is past it.
6. **The layout semantics themselves.** `buildSpriteLayout` implements
   `SubSprGfx2Entry1`'s large-OBJ corner expansion as TypeScript. A hack that
   patches `SubSprGfx2Entry1` is not followed at all; only the choice of
   WHICH routine is read from the ROM, not what the routine does.

## 8 Testing the decoder, and what a mutation sweep found

The first version of this work reported "22 planted mutations, one at a
time, all killed". The sweep was real but it was aimed at the decision
layer, and it ran against two test files rather than the suite. Two of its
22 mutations touched the 256-entry length table and both were immediates.
An independent review then ran 23 mutations against the full suite and 15
survived, all of them in the decoder.

What the tests now do about that:

- **The whole opcode table is swept.** For each of the 243 opcodes that do
  not divert control, the test plants it with zero operands, follows it
  with a call to a watched routine, and requires both that the call is
  reached and that exactly three instructions were decoded. A wrong length
  fails the count even where it happens to realign. The oracle is shown to
  fail by laying `PEA` out as two bytes and as four.

  It cannot fail for 23 of the 256 entries, and the earlier claim of 13 was
  wrong in both directions. Measured, not reasoned: each entry in turn was
  given a wrong value and the FULL suite run against it, 256 runs, and
  exactly these 23 survived.

  | Opcodes | Why the length is never read |
  |---|---|
  | $40 $60 $6B, $CB $DB | returns and halts: the path ends |
  | $6C $7C $DC $FC | computed jumps: the path ends |
  | $4C $5C | `JMP abs`, `JML long`: the operand IS the next address |
  | $80 $82 | `BRA`, `BRL`: the code adds a literal 2 or 3, then `continue` |
  | $10 $30 $50 $70 $90 $B0 $D0 $F0 | conditional branches: literal 2 |
  | $C2 $E2 | `REP`, `SEP`: literal 2 |

  The previous count of 13 named `JSR` and `JSL`, which DO read the table
  (`addr += len` after the call), and left out `BRA`, `BRL`, the eight
  conditional branches and `REP`/`SEP`, which do not. The sweep does plant
  all of the branches, but with zero operands, so "branch to the next
  instruction" lands where a wrong length would have landed anyway. Making
  those entries observable would mean computing branch targets as
  `addr + len + disp`, which turns an inert table error into a live one;
  that trade was considered and not taken. The other 233 entries are all
  killed by the suite.
- **The 13 diverting opcodes are covered separately**, by asserting that
  the returns and halts end the path after one instruction and that the
  four computed jumps stop with a reason.
- **Flag-width immediates are swept in both widths.** All eight
  accumulator-width and all four index-width immediates, under `SEP` and
  under `REP`, plus a cross-check that widening one flag does not widen an
  immediate that follows the other. The 8-bit sweep alone cannot see a
  flag-width entry pinned at 2, which is how `BIT #imm` sat wrong.

Twenty-four mutations survive, and each is equivalent rather than uncaught.
Twenty-three are the `INSN_LEN` entries in the table above: the value is
never read, so a wrong one cannot change any behaviour. The twenty-fourth
is not a table entry:

| Mutation | Why no test can see it |
|---|---|
| `BRL` displacement read unsigned | The sum is masked to 16 bits, so the signed and unsigned readings are congruent. The sign-extending helper was removed rather than left as untestable code |

The earlier "two mutations survive" counted only the two that a 23-mutation
review had happened to plant.

### The sweep run for the probe fixes

A second sweep, aimed at the probe, the bank folds, the call-site
accumulator and the frozen floor. Twenty-nine mutations, one at a time,
each against the full `npm run test:unit`.

Treat this as a SMOKE TEST and not as a coverage measurement. Every
mutation here was designed by the same agent that wrote the code being
mutated, which is exactly the part it had already thought about; three
previous kill tables on this project were checked independently and all
three had survivors the author had not imagined. The first pass killed 25
and left 4:

| Survivor | What was done |
|---|---|
| `DEFAULT_PROBE_DEPTH` 64 to 4 | Killed. The two ids that refuse at 4, $4F and $50, are `ambiguous`, and an `ambiguous` reading discards `stops`, so no count moved. The new test walks the handlers directly instead of reading verdicts |
| prop group taken for any routine, not just `sub0` | Killed. `SpriteTileLoader` only reads it on the `sub0` branch, so it was invisible through that consumer; the reader's own contract says `sub0` only, and now a test says so |
| `SPRITE_GFX_OVERRIDES` loses its $1F row | Killed. Only $1A and $4D were pinned, so 15 of the 17 rows could be deleted unnoticed. All 17 are now checked against the layout each one produces |
| `blocked` branch-queue lookup unfolded | Equivalent. Witness: the STRONGER mutation, deleting that guard outright, also survives, because `path` re-checks `blocked` with the fold on entry. The guard is an early-out, and the only way the two could differ is which of `insnBudget` and the block is recorded first |

Three confirmation mutants were then run to check the new tests were not
passing for the wrong reason: `DEFAULT_PROBE_BUDGET` 1500 to 158 (killed;
the corpus needs 159), and the floor losing $2B instead of $1F (killed).
Nothing here says the suite has no other holes. It says these 29 are
covered.

## 9 Where the decoder is unsound, and why that is documented rather than fixed

The walk tracks M and X because instruction length depends on them. It does
not track everything that can change them, and it assumes one thing about
the data bank. Each of these can in principle desync the decoder, and a
desynced decoder does not fail safely: a synthetic case produces a confident
`read: sub2` at a place where a real CPU reaches nothing at all. "Unreached
is the safe direction" is true of the cases measured, not of the mechanism.

1. **`PLP` ($28) is not modelled.** It restores the whole processor status
   from the stack, including M and X. The walk steps over it and keeps the
   flags it had. Measured on vanilla: 403 `PLP` decodes at 25 distinct
   addresses across the 84 walks.
2. **`XCE` ($FB) is not modelled.** Exchanging carry with the emulation bit
   forces M and X to 1 when it enters emulation mode.
3. **A callee that alters M or X and returns is not modelled.** The walk
   resumes after a call with the flags it had before it.
4. **DBR is assumed to equal PBR.** `LDA abs`, `LDA abs,X` and `LDA abs,Y`
   are reported as reading a table in the program counter's bank. On the
   real machine the bank comes from the data bank register, which sprite
   handlers set with `PHK : PLB` at entry, which is why the assumption holds
   for the selector this reader uses. It is an assumption, not a read, and
   a handler that sets DBR to something else would have its table address
   reported wrongly.
5. **The bank fold is not exactly a mirror.** Every address is keyed as
   `addr & $7FFFFF`, which correctly makes $83:A118 and $03:A118 one
   address, and also merges $7E/$7F with $FE/$FF, which are not a pair:
   `loromToOffset` rejects the first as WRAM and maps the second as real
   ROM. Nothing in SMW or in the six ROMs executes from $FE/$FF, so this
   is theoretical, but it is a collision and not a mirror.

A sixth, the one where the probe can be satisfied by a callee that reaches
a return without resuming at the call site, is in section 2 with the rest of
the probe.

None of this changes a current answer. All six ROMs were re-run under three
alternative treatments of the flag state and the tallies were identical, so
no measurement in this document depends on which treatment is chosen. It is
a mechanism hole, recorded so that the next person extending the walk knows
the floor they are standing on, not a defect with a victim.
