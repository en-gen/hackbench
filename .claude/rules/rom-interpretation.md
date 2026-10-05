---
paths:
  - 'src/**'
  - 'theia/extension/src/node/**'
  - 'test/**'
  - 'tools/**'
  - 'docs/rom/**'
---

# Reading the ROM

Loaded when you read or edit ROM-facing code. Moved out of CLAUDE.md so sessions
that never touch the ROM do not pay for it.

## The ROM is a collection of lookup tables

Read the tables. Do not model the behaviour.

SMW stores what it needs in tables, and a romhack still has to run on a stock
SNES, so those tables stay where the hardware expects them. Almost every
question this project asks ("which levels exist", "what does this exit lead
to", "what is this level called") is answered by finding the right table and
the right index into it. We are not building an emulator. Where a table is
enough, reading the table IS the answer; reach for code only when the table
alone cannot tell you whether it is still the one the ROM uses.

**The table is never the hard part. The index is.** Reading 512 three-byte
entries is trivial. The work is knowing what indexes them. The exit-graph bug
took a day and the answer was that `DATA_05F800` is indexed
`(submapFlag << 8) | rawByte`, with the high byte coming from `OWPlayerSubmap`
and NOT from the translevel: two independent gates in one routine
(`bank_05.asm:7217-7226`). Trace the ASM to learn the index, then read the
table. Do not port the routine.

**If you are describing behaviour, you have lost the thread.** Every defect
this project has shipped came from modelling instead of reading:

| Defect                 | What it did                                                                      | What it should have done                  |
| ---------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `screenHasExitTrigger` | invented Map16 tile scanning, cited an address with zero hits in the disassembly | read `DATA_05F800`                        |
| `levelHasObjects()`    | invented a "modes 0-20 valid" rule with a fabricated line citation               | compare the L1 pointer against the filler |
| exit-graph high byte   | derived it from `ExitTableHigh` bit 3, which the game never reads for this       | take it from the submap flag              |

Both fabricated citations are tracked in issue #311. Neither was caught by
tests; both were caught by someone re-reading the disassembly.

**The one case where table-reading is not enough.** Lunar Magic replaces
routines, not just data. `$05D8B1` holds the `BEQ` opcode `$F0` in a stock ROM
(`bank_05.asm:7224`); in this repo's 6-ROM corpus the 2 stock ROMs hold `$F0`
and the 4 edited ones hold `$22` (a JSL), which is an empirical observation of
ROM bytes, not an ASM claim. On such a ROM the stock table may be bypassed
entirely in favour of a precomputed one. So: read the table, but check that
the routine which reads it still exists. When it does not, fail closed and say
the tier is unavailable. Emitting vanilla-shaped output for a patched ROM is
the worst outcome available, because it is confidently wrong and looks right.

**Relocation is rarer than override. Measure before assuming either.** Palettes
were measured across the 6-ROM corpus: all eight stock tables sit at their
vanilla addresses on 6 of 6, and the variant-offset table at `$00ABD3` plus the
two `LDA #imm` sites feeding CGRAM column 1 are byte-identical on 6 of 6. The
data does not move. What changes is the CONTENT in place - GPW2 edits 4 of the
8 tables, Invictus 2 - and, separately, Lunar Magic writes per-level override
blocks through `$0EF600`: 157 levels on GPW2, 161 on Invictus, 53 on GPW 1.2,
0 on the three unedited ROMs. So for palettes a fixed address is safe and
reading the override table is mandatory, which is the opposite shape to music,
where AddmusicK moves the data and deletes the call. Do not generalise one
subsystem's answer to another; both cost one probe to check.

**Existing is not the same as reached.** A patch that leaves a routine
byte-identical and diverts control before it passes every existence check.
Poking `$00A418` to `RTS`, or the NMI vector at `$00FFEA` to anywhere, leaves
`$00A41A..$00A435` pristine while the ROM animates nothing; a detector
anchored only on the callee reports vanilla with full confidence. Hijacking an
entry point is the commonest patch shape there is, so verify the PATH as well
as the destination: the vector, the branch displacement, the call site. Those
are a handful of readable bytes.

**The recipe, when a value lives in code rather than a table.** Six separate
features got this wrong before review caught them, so it is written out:

1. Read the operand where it sits. `LDA #imm`, `LDA abs,Y`, an `AND` mask, a
   run of `LSR`, a branch displacement. These are readable bytes and reading
   them is interpretation, not assumption.
2. Gate on the opcode first. Confirm the instruction is still the one you
   think you are reading, at the offset you think it is. A fixed offset into a
   replaced routine lands mid-instruction and yields a plausible wrong answer:
   `$008148` reads `$20`, the operand of a `SEP`, and the derived music bank
   address comes out `$0EAE60` against a true `$0EAED6`.
3. Prefer a byte PATTERN over a fixed address, so a relocated but intact
   routine is still found. More than one match means you cannot say which one
   runs, which is unavailable, not a guess.
4. Never fall back to the vanilla value. Report unavailable with a reason.
   Keeping the stock constants as a documented cross-check is fine; reading
   one as a default is the defect.
5. Validate the result independently where you can. A derived bank address
   whose header holds a sane `blockSize` and whose pointer table terminates is
   evidence; one that lands on filler is not.

**Scope each issue to vanilla plus refusal.** A fix is done when it is correct
on vanilla and refuses a hack it does not recognize, with a reason. Recognizing
a particular hack's code (a Lunar Magic hook, a relocated routine) is its own
issue, ranked by how often the SMW Central sweep (#543) meets it. Adding hack
support inside a correctness fix is what roughly doubled #488-#490.

**Viewers draw; they do not blank.** Where a view cannot verify what it draws,
it draws the best data it has, marks it unverified and says why. That is not a
vanilla fallback: the data still comes from this ROM, and the view says it is
unverified instead of presenting it as fact.

## Knowledge Integration (External Disassembly)

Domain library: `C:\Projects\SMWDisX`. SMW ROM constants, handler ports, and ASM-behavior questions are authoritative there - not in this file. This section is the router; `SMWDisX` is the store.

**Global SNES rulebook** (addressing, BGR555, VRAM layout): `@C:\Projects\SMWDisX\.claude\rules\snes-global.md` - load this whenever any `src/rom/` task touches color math, LoROM offsets, or VRAM slot assignments.

**Pillar 1 - Scoped Rules (`src/rom/`)**: Any work touching `src/rom/` requires cross-referencing the matching bank folder in `SMWDisX`. Do not port or assert ROM behavior without tracing to an ASM line there first.

**Pillar 1a - ASM is REFERENCE, not a source to hardcode from**: Use the
disassembly to trace which lookups happen, in what order, and how graphics are
composed and presented. Do NOT derive logic from the ROM and then hardcode it.
This tool targets romhacks, and the ROM's code can be manipulated in ways that
invalidate any such derivation. A hardcoded derivation does not merely go
stale: it renders confidently wrong on the user's own ROM with every test
still green.

In practice:

- Sprite identity comes from the MAP's sprite stream. Everything about that
  sprite is then looked up from ROM tables: one hardcoded address per SHARED
  table, indexed by the id. `SprTilemapOffset[id]`, `Sprite166EVals[id]`, the
  handler pointer at `$01:85CC + id*2`. Values always read from the ROM.
- Where a value lives inside one sprite's own handler rather than a shared
  table, anchor it as an OFFSET FROM THE ROM-RESOLVED HANDLER POINTER, not as
  an absolute address, so a relocated handler still resolves.
- **If HackBench can interpret the ROM directly to produce graphics or
  animation, it MUST. It must go no further.** Opcodes are readable bytes, so
  reading them is interpretation, not assumption. Do not stop at data tables
  and hardcode the rest.
- Worked examples, all verified readable on the vanilla ROM. A shift count is
  the number of consecutive `$4A` (`LSR A`) bytes at an address: `$01:BE96`
  reads 6 and the OR-bit slice reads 3, which a descriptor should COUNT rather
  than hardcode. A displacement can be the opcode itself: `$FE` at `$01:BEC3`
  is `INC abs,X` on `$0301`, so the 1 px top-tile nudge is +1 on
  `OAMTileYPos+$100`, and a hack that changed it to `$DE` would correctly read
  as -1. Comparison thresholds are plain immediates.
- The line is at ASSUMPTION, not at opcodes. **We are not building an
  emulator, but content we load for editing must be INTERPRETED, not assumed
  from the ROM.** Running the ROM to see what happens is out of scope outside
  the two bounded exceptions below.
  Reading bytes - including opcodes - to determine what the ROM does with
  the content we are about to show the user is in scope and required.
- Static control-flow reading is on the required side of that line. Walking
  instructions from a known entry to find which write is REACHED is reading,
  because it evaluates no condition and holds no machine state; it follows
  determinate transfers and refuses everything else. The palette-animation
  detector does this to resolve a relocated routine, and it exists because
  the byte scan it replaced reported a ROM as animating a slot the hack had
  disabled. A walk that refuses conditional branches fails closed; a scan
  that takes the first plausible match fails confident.
- One bounded exception, for L1 object handlers only (#351):
  `src/rom/objectHandlers/interpret.ts` evaluates a handler's bytes over a
  fixed opcode set, a named memory surface and step/write budgets, and
  refuses anything else with a reason. Do not extend it to other subsystems
  without a decision of the same kind.
- Second bounded exception, for sprites (owner decision 2026-10-05, #582): a
  sprite is drawn by executing its own INIT and MAIN from the ROM on the
  concrete 65816 core (`src/rom/cpu`, #583). Generic seeds only, no per-sprite
  tables, refusal with a reason on an unknown entry shape, step budgets.
  Captures and Mesen are an oracle only, never a runtime input.
- A derivation that truly cannot be read must be NAMED as a hack-fragility
  point and paired with honest degradation: compare the handler against its
  vanilla bytes and DECLINE TO ASSERT when it diverges, rather than rendering
  vanilla with confidence. Reach for this only after establishing the value is
  genuinely unreadable, which is rarer than it first appears.

**Pillar 2 - Context Budgeting**: Load domain knowledge on demand using `@C:\Projects\SMWDisX\<bank_xx>\MEMO.md` syntax. Never read entire bank folders speculatively; load only the MEMO.md for the bank(s) directly relevant to the current task.

**Pillar 2a - Ask smw-mcp before spelunking**: ROM and disassembly questions (level entrances, pointer tables, sprite lists, which levels use a tile, what a routine does, whether a citation is right) go through the `smw-mcp` server's tools first. `smw-mcp` is ours to change as the work needs.

- **Codify repeats.** Log every question answered by hand in `smw-mcp/docs/query-log.md`. That includes ad-hoc ROM scripts, repeated table reads, raw `sed`/`grep`/`Read` of `.asm` line ranges, and hand-checked `file:line` citations. Past 3 of a kind, add it to `smw-mcp` as a tool, with tests and SMWDisX citations, then use the tool.
- **Tune what does not help.** Log a result that was not useful in the same file's Effectiveness section, then fix the tool: output far larger than the question needed, a missing field that forced a follow-up, a wrong answer, an error. Falling back to raw reads because a tool is broken counts; fix the tool.

**Pillar 3 - Memory Snapshot Protocol**: SMWDisX is our fork (`en-gen/SMWDisX`) and our tool. Whenever a detail of the disassembly is learned or confirmed, record it in `SMWDisX/<bank_xx>/MEMO.md` for the bank where the routine lives. This covers a multi-routine trace, a single table's meaning, one flag bit, or which index a lookup uses. Delegated research counts: a sub-agent confirms the citations, then writes the memo from the findings.

- **Content:** the address range, the behavior decoded, the non-obvious invariants, and the issue or PR that exercised it.
- **Wrong memos:** correct them in place, and say what was corrected and why.
- **Publishing:** write, commit and push; no proposal step. Stage only the memo files you changed.
- **Never edit the disassembly code.** Its instructions, labels, data and addresses are reference SMW. Annotations, comments, memos and docs that help development are welcome.
