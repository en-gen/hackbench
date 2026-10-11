# Resource-based ROM layout

Design for en-gen/hackbench#881. Status: **proposal, awaiting owner
approval**. Nothing here is built. Items marked **[PROP]** are
recommendations, not decisions. Items marked UNCONFIRMED are listed again at
the end with what would settle them.

Evidence scope: ROM facts below are static traces of SMWDisX (U ROM), cited as
`file:line`. Corpus figures are quoted from the notes they come from, each with
its own scope; none was re-measured for this document.

## Problem

An edit today is a layer of byte ops, `{ address, old, new }`, applied in place
(see [project-format.md](project-format.md)). That only works for edits that
never change size, such as a palette color. Most edits do change size:

- A map's sprite list grows when a sprite is added. Written in place it runs
  into whatever follows, which can be another map's list.
- An edited Layer 1 object list, GFX file or song can come out longer, and a
  compressed GFX file can grow from a one-pixel change.
- Vanilla's GFX region has 755 bytes of slack for all 50 files
  ([../gfx-arena-budget.md](../gfx-arena-budget.md), 6 ROMs, one machine).
  Two of the four editable hacks in that corpus have none.

Some data also cannot move freely because the game's code fixes where it may
live. Sprite data is the clearest case: the pointer is 2 bytes from
`Ptrs05EC00` and the code hard-sets the bank to `$07`
(SMWDisX `bank_05.asm:7253-7258`). Once bank `$07` is full no level can gain
sprites until the code reads a full pointer from a new table.

[../rom/map-data-mechanics.md](../rom/map-data-mechanics.md) measured the same
thing from the other side: on vanilla, adding one object to any of 182 tightly
packed Layer 1 maps corrupts the map stored after it, and the unreferenced runs
in banks `$06` and `$07` total 14517 bytes (that note's scope: no L1, L2 or
sprite pointer reaches them; it does not prove nothing else uses them).

## The pipeline

```
edits per resource -> resource content -> build -> working copy -> BPS
 (ops/, undoable)    (level 105 L1,        encode      (every view      (Export Patch,
                      sprite list 105,     place        reads it)        unchanged)
                      GFX 14, song 3)      fix pointers
                                           install hooks
```

1. **Edits per resource.** The user's edits live in `ops/` as an ordered stack
   of layers, exactly as now. A layer targets a named resource and carries
   operations meaningful for that resource, not addresses.
2. **Resource content.** Replaying the layers over the resource's base content
   gives its current content: a list of sprites, a list of objects, a bitmap of
   tiles. This is decoded, in-memory data, never stored in the project.
3. **Build.** For each resource whose content differs from base, in a fixed
   order: encode it to its ROM form, place it (in place if it fits, otherwise
   in free space), rewrite every pointer to it, and install any code hook the
   new placement needs. Resources that were not edited are not touched.
4. **Working copy.** The result is the working copy that every view already
   reads. The rule in `CLAUDE.md` is unchanged: views never read base bytes.
5. **BPS.** Export Patch diffs the working copy against base. BPS already
   describes a resized ROM
   ([../decisions/2026-10-04-bps-primary-patch-format.md](../decisions/2026-10-04-bps-primary-patch-format.md)),
   so export needs no change.

A resource is one of three kinds, as in the issue: **data** (object list,
sprite list, GFX file, song, Map16 page, palette; each with an encoder),
**pointers** (rewritten when a resource moves) and **code hooks** (changes to
the game's code when a table's format cannot reach the new location).

## Design rules

The issue's five principles, restated so each can be checked in review.

1. **Relocate on demand; never defragment.** A resource that was not edited
   stays at its base address. An edited one stays in place if the new encoding
   fits in its old block, otherwise it moves and the old block is freed. The
   ROM grows (#218) only when no free space fits. A full repack would break
   hacks whose own code points at data addresses and would make a one-level
   edit export as most of the ROM. The GFX arena note already shows the cost
   of even a contiguous relay: one pixel in the first file exported 102,185
   changed bytes (vanilla, one machine).
2. **Adopt existing conventions before adding ours.** When a known hook is
   present, write data in its format and read through it. Install our own hook
   only on a ROM that has none of the kind needed. #637 and #876 are the first
   worked cases (the background-image hook).
3. **Edits are stored per resource, not as finished bytes.** The project holds
   the user's edits, so the copyright position stays near today's op exception
   (question 3).
4. **The build is deterministic.** Same project, same base ROM, byte-identical
   output. No clock, no random, no iteration over an unordered map.
5. **Hooks are layers.** A hook is installed only when an edit needs it, is
   recorded with its signature so it is never installed twice, and is undone
   like any other layer.

Two further rules follow from the Safety section and are stated here so the
questions below can lean on them:

6. **Refuse before guessing.** Where the build cannot prove it understands a
   resource's layout on this ROM, that resource is read-only. It is never
   relocated on a guess.
7. **A move is all or nothing.** A resource is moved only if every pointer to
   it that the build knows of is rewritten in the same build. If a pointer
   cannot be located or reached, the move is refused.

## Open question 1: how hook bytes are produced

A hook is a few bytes of 65816 code that make the game read a table we placed.
The first needed one is the sprite pointer: replace the 2-byte `Ptrs05EC00`
read plus the hard-set bank with a full 3-byte read, at the site traced in
SMWDisX `bank_05.asm:7253-7258`.

Options:

- **A. Hand-assembled stubs.** Each hook is a byte string in source, with a
  unit test that pins its exact bytes and a documented SMWDisX trace of the
  site it patches and the registers and flags it must preserve.
- **B. Bundle an assembler (Asar is the community standard).** Hooks are
  written as assembly source and assembled at build time.
- **C. Hybrid.** Stubs now, an assembler adopted at a stated trigger.

**[PROP] C, starting as A.** While hooks are few, a stub is a handful of bytes,
and a byte-level test is a stronger statement than "the assembler produced
something". The trace of the site is needed under every option, so A costs
nothing B does not also cost. Revisit trigger: the fifth hook, or any single
hook longer than about 64 bytes, whichever comes first. Both thresholds are
judgement, chosen so that review of hand-encoded branches stays tractable; they
are not measured.

Trade-offs of bundling an assembler, to be weighed at the trigger:

- **Licence.** Asar is third-party code shipped inside a product that already
  keeps `THIRD_PARTY_LICENSES.md`. Its licence terms are UNCONFIRMED here and
  must be read from its repository before a decision; this document does not
  assert them.
- **Packaging.** It is a native binary (or a build of one), so Electron needs
  one per platform, signing and notarising concerns, and a spawn path that
  follows the hidden-process rule. A WebAssembly build, if one exists, would
  avoid per-platform binaries; UNCONFIRMED.
- **Determinism.** Rule 4 needs the assembler's output to be reproducible
  across versions; that means pinning an exact version and testing it.
- **Benefit.** Source-form hooks are easier to review than byte strings once
  there are many, and a label-based hook survives a relocated target without a
  hand-computed offset.

The unit test for a stub is not enough by itself; the Safety section adds the
boot check.

## Open question 2: the catalogue

Which resources are in scope first, and how the build finds each one's address
and size on a hack that already moved things.

Order, **[PROP]**:

1. **Sprite lists and Layer 1 object lists.** They unblock #24. Both are
   pointer-indexed per level.
2. **GFX files**, because #218 and the painter need them.
3. **Music last.** It needs a different treatment (below).

What the static trace supports:

| Resource    | Pointer table                                                                    | Entry                  | Notes                                                                                                         |
| ----------- | -------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sprite list | `Ptrs05EC00`, `bank_05.asm:8708-9220`, 512 entries                               | 2 bytes                | Bank hard-set to `$07` (`:7253-7258`); needs a hook to leave it.                                              |
| Layer 1     | `Layer1Ptrs`, `bank_05.asm:7680-8192`, 512 entries                               | 3 bytes                | Loaded at `:7235-7239`, index is level times 3 (`:7229-7233`). Full pointer, any bank.                        |
| Layer 2     | `Layer2Ptrs`, `bank_05.asm:8194-8707`, 512 entries                               | 3 bytes                | Loaded at `:7241-7246`.                                                                                       |
| GFX file    | `GFXFilesLow` `bank_00.asm:6415`, `GFXFilesHigh` `:6467`, `GFXFilesBank` `:6519` | three tables, 50 files | Used by `PrepareGraphicsFile` (`bank_00.asm:6571-6591`).                                                      |
| BGM         | `LevelMusicTable`, `bank_05.asm:513-520`                                         | 8 ids                  | The bank upload is hard-set (`UploadMusicBank1`, `bank_00.asm:145-151`, to `MusicBank1`, `bank_0E.asm:2353`). |

Two ROM facts that were UNCONFIRMED in the brief are settled by the lines
above. The Layer 2 bank byte is the third byte of the table entry, read
directly into `Layer2DataPtr+2` (`bank_05.asm:7245-7246`); unlike sprites, no
bank is hard-set for Layer 1 or Layer 2. And `CODE_00B8DE`
(`bank_00.asm:6294-6302`) is a loop that reads bytes until `$FF` and
dispatches on the top three bits of a header byte, which matches the LC_LZ2
description in [../rom/gfx-decompressors.md](../rom/gfx-decompressors.md);
that is a static reading, not a run.

**Address discovery.** Follow the ROM's own pointers; never hard-code a vanilla
address for a hack.

- Read the table the game reads. The build resolves the table's own location
  through the code that indexes it, using the fingerprint convention below, so
  a hack that moved the table is followed.
- **Size** of a block: for object and sprite lists, parse to the list
  terminator; for GFX, decompress to the end-of-stream marker
  (`bank_00.asm:6299`). The size is what the resource occupies, not the
  distance to the next block.
  [../rom/map-data-mechanics.md](../rom/map-data-mechanics.md) shows hack
  blocks that a stock walker overruns, so a size that disagrees with the next
  block's start is a refusal, not a clamp.
- **Known hooks** are detected by signature and read through. The convention
  is already in the repo: a SHA-256 of a fixed span from a traced site, with
  operand bytes that legitimately vary masked or checked as a call
  ([../rom/gfx-decompressors.md](../rom/gfx-decompressors.md),
  [../rom/level-table-gate.md](../rom/level-table-gate.md)). Patterns over 32
  bytes are stored as the digest, not the bytes (copyright rule). Example: the
  per-slot sprite bank table that all four corpus hacks carry
  ([../rom/map-data-mechanics.md](../rom/map-data-mechanics.md), scope: that
  note's four-hack corpus) is a known hook; with it present, sprite lists may
  live in any bank and the build writes that table instead of installing ours.
- **Unrecognised layout on a hack: that resource is read-only.** A different
  or modified table, an unfamiliar replacement of the loading code, or a size
  that does not parse all lead to the same answer: the build refuses to
  relocate it. Reading it for display may still work; writing does not.

**Scope rule (D51): vanilla first.** The first implementation targets vanilla
and refuses everything else per resource. Hack support grows one known hook at
a time, each with its signature and its tests.

**Music** is last because songs are not simple pointer-indexed blocks: the
bank upload is fixed in code, the level-to-song mapping is a separate 8-entry
table, and where credits music comes from is UNCONFIRMED. It needs its own
trace before it is scheduled.

Trade-off: starting with sprite and object lists delays GFX and music, but it
is the smallest set that makes "save a modified level" real, and it exercises
every part of the pipeline (parse, encode, place, pointer, hook) once.

## Open question 3: how an edit is stored

Options:

- **A. Semantic ops per resource, replayed over base content at build time.**
  Examples: add sprite id X at (x, y) to sprite list 105; move object 7;
  set pixel (x, y) of tile T in GFX file 14 to color index C.
- **B. Store the resource's new encoded form.** Each edit layer holds the
  finished bytes of the resource.
- **C. Store a decoded copy of the resource** (the list of objects, the tile
  bitmap) in the project.

**[PROP] A.**

- _Copyright._ B and C put whole ROM-derived resources in the project, a far
  worse position than today's op exception, which is limited to two or three
  bytes per op ([project-format.md](project-format.md), "The copyright
  position"). A stores what the user did. Added content is the user's own; the
  base content is never stored, only referenced by resource id and rebuilt
  from the ROM the user owns. That keeps the op exception where it is today.
- _Undo and portability._ A semantic op can carry the value it replaced
  (`old`), as byte ops do, so undo works on a clone. The `old` of a pixel op
  is a small color index; of a list op, the removed entry. These are
  ROM-derived but of the same order of size as today's exception. Where the
  old value would be a whole block (deleting a level's sprite list), the op
  should instead be invertible from the base alone and carry no copy.
- _GFX._ Pixel ops are applied to the decoded tile bitmap and the build
  re-encodes. [../gfx-arena-budget.md](../gfx-arena-budget.md) records that an
  encoder which walks the original command stream reproduces unedited files
  byte for byte (50 vanilla files, one machine), while a from-scratch greedy
  encoder came out 9.8% larger. So the build's GFX encoder must be the
  structure-preserving one; that is a requirement on the encoder, not on the
  op format.
- _Cost._ Every resource kind needs its own op set and a reducer (pure,
  I/O-free, like `PaletteOp.ts`). That is more design up front than B. It is
  also the only option where two layers that edit different parts of one
  resource compose, and where undoing the first leaves the second meaningful.
- _Addressing._ Ops address by resource id plus a position inside the resource
  (list index, tile and pixel coordinates), never by ROM address. A layer
  records the resource's base fingerprint so that replay over a different base
  is refused instead of silently misapplied.

## Open question 4: migration of palette layers

Existing projects hold byte-op layers; palette edits are the only kind. A
palette color is a fixed-size, fixed-address word.

Options:

- **A. Convert on load.** Each existing palette byte-op layer is read as a
  palette-resource edit (set color N of palette P). The on-disk layer files
  are left untouched and stay readable.
- **B. Mixed stack.** The stack holds both byte-op layers and resource layers;
  byte ops are applied after layout. Needs a refusal when a byte op targets
  bytes inside a resource that moved.
- **C. Rewrite the files** to the new format on first open.

**[PROP] A, converting in memory, never rewriting files.**

- A palette op never changes size and never moves, so it converts without
  loss: address and old/new words map to a palette index and a color. A layer
  whose address cannot be mapped to a known palette slot is refused, not
  dropped.
- Not rewriting keeps a project written by today's build opening in today's
  build, and keeps the portable-undo property of old layers.
- B is still needed as a rule, not as the design: any raw byte op that
  survives conversion is checked against the final layout, and a build in
  which a byte op targets a moved resource fails with a message naming the
  layer. B alone is rejected because it makes every future build carry two
  semantics, and because "byte ops after layout" silently changes the meaning
  of old layers when a resource later gains a size-changing edit.
- C is rejected because it makes old projects unreadable by older builds for
  no gain.

Conversion is tested on synthetic palette layers (no ROM): convert, build, and
compare to the old applier's result byte for byte; plus a planted defect (wrong
palette index) that must turn the comparison red.

## Open question 5: free space

Options:

- **A. Honour RATS tags on read; write a RATS tag on every block we allocate.**
- **B. Own side table** in the project listing what the build allocated.
- **C. Both:** RATS in the ROM for other tools, plus a record in the project.

RATS is a community convention for marking used space in an SMW ROM: a block
begins with a short ASCII marker, a size field and its complement, then the
data. Tools that insert code or data write one so later tools skip the block.
This document takes the idea from the convention's own published spec, not
from any editor's behaviour; the exact field layout is UNCONFIRMED here and
must be copied from that spec when the code is written.

**[PROP] A, with the project recording nothing extra.** The ROM must remain
self-describing: someone who opens the exported result in another tool must
see our blocks as used, and our project cannot travel with it. B alone fails
that. A also needs nothing from the project, which keeps the export story
unchanged. The cost is a few bytes per allocated block and a scan on every
build.

**How the build finds free space.**

- _Vanilla._ The candidates are the fill runs SMWDisX lists as free
  (`freespace.txt`, for example the run at file offsets `$05FD0D..$05FFFF`
  that [../gfx-arena-budget.md](../gfx-arena-budget.md) already uses). Each
  candidate must also read as all fill in the ROM, must not be referenced by
  any pointer the build knows, and must not cross a bank boundary (the loaders
  advance 16 bits and never carry into the bank byte, `bank_05.asm:689-695` as
  quoted in map-data-mechanics). A longer fill run is not evidence that nothing
  else owns it, so only the listed runs count. Placement honours per-resource
  bank rules: sprite lists stay in bank `$07` until the sprite hook is
  installed, then may go anywhere.
- _Hack._ Free space cannot be known from the disassembly. The candidates
  are, in order: (1) the old block of a resource this build is moving;
  (2) space appended past the end of the ROM, which cannot collide with
  anything (the #218 path); (3) nothing else by default. Fill runs inside a
  hack are never claimed on a guess, and RATS-tagged blocks are never
  allocated into. A user-confirmed fill run could be added later as an
  explicit choice; it is not proposed here.
- _Order._ The allocator is deterministic: candidates are sorted by address and
  the first that fits wins. First-fit is simple and reproducible; best-fit can
  come later if fragmentation shows up in measurements.

The vanilla free total is small (14517 unreferenced bytes in banks `$06` and
`$07`, per the map-data note and with its caveat), so expansion is expected to
be the usual path for any real editing session. That makes #218 part of the
design's critical path, not an afterthought.

## Safety

A broken hook crashes the game. It does not draw one wrong tile. This section
is a requirement on every resource and hook, and on any later implementation
PR.

1. **Boot check per hook.** Every hook has a check that loads the built ROM
   in the libretro core, reaches the point where the moved data is read, and
   confirms the moved data loads. The core is the oracle; the project's rule
   (derive state from the core, never write through it) applies.
2. **The check must be shown able to fail.** A committed test plants a broken
   hook (wrong target, wrong register width, missing restore) and proves the
   boot check goes red. A check that has only ever passed does not count.
3. **Synthetic fixtures for relocation and pointer rewrites.** CI has no ROM.
   Tests build the pointer tables, lists and a toy loader in the test and
   assert: the moved block is where the pointer says, every pointer was
   rewritten, nothing else changed, a block that does not fit is refused, and
   a missing pointer refuses the move (rule 7). Deleting the rewrite or the
   refusal must turn at least one test red.
4. **Corpus tests use `describe.skipIf`**, never cases generated from a corpus
   listing. Counts are reported with and without the corpus; identical counts
   mean a test is not registering.
5. **Determinism.** Building the same project twice, and in a different
   process, gives byte-identical output. The test compares full byte arrays,
   and a planted defect (iteration order dependent on insertion order, or a
   timestamp written into a block) must turn it red. Claims carry their scope:
   "N runs, one machine", never a bare "deterministic".
6. **Signature drift.** A hook's signature is recorded with the layer. A later
   build that finds the signature at the site but different bytes refuses, so
   a hook edited by another tool is not overwritten.
7. **Copyright.** No ROM-derived bytes are committed. Matched patterns over 32
   bytes are digests, and a hook stub contains only code this project wrote.

## Re-scoping of the dependent issues

**#24, save a modified level back to the ROM.** It stops being "write bytes at
the level's addresses". It becomes the first consumer of the build: the
editor emits sprite and Layer 1 object ops on resources, and Save runs the
build. It must not ship on byte ops. Scope for the first slice is vanilla,
sprite and Layer 1 lists, with the sprite hook; hack ROMs refuse per
resource.

**#57, free space manager.** It is the allocator described in question 5, not
a separate UI feature. First slice: the deterministic first-fit allocator over
the vanilla candidate set, RATS read and write, and the expansion tail. Any
view of free space is a reader of the allocator's state.

**#178, relocate shared sprite pointers before editing.** One case of rule 7.
Where two levels share one sprite block, editing one must either give it a
private copy or refuse; the build finds the sharing by comparing pointer
targets across the whole table, not by assuming it. The fix is part of the
pointer rewrite, not a pre-pass in the editor.

**#218, ROM expansion.** The build's last resort, and on a hack the usual
route. It owns growing the file, the header and checksum consequences, and the
rule that expanded space is claimed (RATS-tagged) so other tools do not reuse
it. Its measurement that GFX has 0.70% headroom on vanilla and none on two
hacks is the main reason the design cannot treat expansion as rare.

## Unconfirmed facts

- Asar's licence terms, and whether a WebAssembly or prebuilt native build is
  available for every Electron target. Check its repository before deciding at
  the question 1 trigger.
- The exact RATS tag layout (field order and the complement check). Take it
  from the convention's own spec when writing the reader.
- Where credits music comes from; music cannot be scheduled without it.
- Whether the vanilla ROM holds anything beyond what `freespace.txt` lists as
  free at its end. The list's final range ends at `$0FFFFF`, which is
  consistent with a 512 KB ROM, but that is the list's own bound, not a read of
  the ROM.
- Whether any sprite-pointer reader other than the one at
  `bank_05.asm:7253-7258` exists (for example in the overworld or in a boss
  room). A hook is only complete if every reader is covered; the first sprite
  hook needs a search of the disassembly for all of them.
- The same question for Layer 1 and GFX pointer readers: the traces cited
  above are the main load sites, not a proven complete list of readers.
- That first-fit is adequate; no fragmentation measurement exists.

Settled during this write-up, by static reading of SMWDisX only: the Layer 2
bank byte comes from the table entry (`bank_05.asm:7245-7246`), and
`CODE_00B8DE` is the LC_LZ2 loop (`bank_00.asm:6294-6302`).

## Related reading

- [project-format.md](project-format.md) - the layer stack this builds on
- [overview.md](overview.md) - the edit model and where bytes may live
- [../gfx-arena-budget.md](../gfx-arena-budget.md) - the GFX numbers
- [../rom/map-data-mechanics.md](../rom/map-data-mechanics.md) - map data and the sprite bank hook
- [../rom/level-table-gate.md](../rom/level-table-gate.md) - the existing hook detection
- [../testing.md](../testing.md) - copyright rule, synthetic fixtures, corpus gating
