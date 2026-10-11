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
  Both Grand Poo World ROMs in that corpus have none; Invictus is refused
  outright because it replaces the decompressor.

Some data also cannot move freely because the game's code fixes where it may
live. Sprite data is the clearest case: the pointer is 2 bytes from
`Ptrs05EC00` and the code hard-sets the bank to `$07`
(SMWDisX `bank_05.asm:7253-7258`). Once bank `$07` is full no level can gain
sprites until the code reads a full pointer from a new table.

[../rom/map-data-mechanics.md](../rom/map-data-mechanics.md) measured the same
thing from the other side: on vanilla, adding one object to any of 182 tightly
packed Layer 1 maps corrupts the map stored after it. It also counts 14517
unreferenced bytes in banks `$06` and `$07`, but only in the sense that no L1,
L2 or sprite table pointer reaches them. That is not a free-space figure: the
entrance-scene and Chocolate Island 2 data (for example `CI2Sub2Level6E9FB`,
`bank_06.asm:304`) is reached by other readers (see the reader inventory), and
that data is not reached by the three tables the note scanned, so it plausibly
sits inside the count. Summing the `freespace.txt` runs in banks `$06` and
`$07` (U column, 8 runs) gives 8991 bytes; the 5526-byte difference from 14517
is consistent with that data, but the split is UNCONFIRMED.

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
   order (resource kind in the order palette, Map16, GFX, Layer 1, Layer 2,
   sprite list, then ascending numeric id inside a kind; layers always replay
   in stack order, whatever order the input arrives in): encode it to its ROM form, place it (in place if it fits, otherwise
   in free space), rewrite every pointer to it, and install any code hook the
   new placement needs. Resources that were not edited are not touched.
4. **Working copy.** The result is the working copy that every view already
   reads. The rule in `CLAUDE.md` is unchanged: views never read base bytes.
5. **BPS.** Export Patch diffs the working copy against base. BPS already
   describes a resized ROM
   ([../decisions/2026-10-04-bps-primary-patch-format.md](../decisions/2026-10-04-bps-primary-patch-format.md));
   `src/rom/Bps.ts` writes the target length. The IPS path does not:
   `diffPatches` in `src/project/ExportPatch.ts` compares only up to the
   shorter of the two buffers, so an expanded ROM exported as IPS would lose
   its tail. **[PROP]** Export refuses IPS whenever the working copy's size
   differs from the base, with a message pointing at BPS. That is a small
   change to `ExportPatch.ts` and belongs with the first slice that can grow
   the ROM.

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
5. **A hook is installed only when an edit needs it, never twice, and goes
   away with the edit that needed it.** The issue words this "hooks are
   layers". Whether a hook is a stored layer or derived by the build is open
   question 6, where this document proposes derived and says what that changes.

Two further rules follow from the Safety section and are stated here so the
questions below can lean on them:

6. **Refuse before guessing.** Where the build cannot prove it understands a
   resource's layout on this ROM, that resource is read-only. It is never
   relocated on a guess.
7. **A move is all or nothing, and every reader is proven.** A resource is
   moved only if every reader of it is listed in the reader inventory below
   with an SMWDisX trace, and every one of those pointers is rewritten (or
   covered by a hook) in the same build. A resource with a reader the
   inventory does not list, or one that cannot be rewritten, is refused. A
   block that more than one pointer reaches is **shared**: the build counts
   its readers, edits it only after giving the edited level a private copy,
   and never frees a block that still has a reader.

## Open question 1: how hook bytes are produced

A hook is a few bytes of 65816 code that make the game read a table we placed.
The first one that can be needed is the sprite pointer: replace the 2-byte
`Ptrs05EC00` read plus the hard-set bank with a full 3-byte read, at the site
traced in SMWDisX `bank_05.asm:7253-7258`. It is **not needed by the first
edit slice**: the vanilla fill runs `$07E76F-$07EFFF` and `$07FC90-$07FFFF`
(`freespace.txt`, U column) are in bank `$07`, so early sprite growth fits
without a hook. The hook is its own later slice, built when bank `$07` runs
out. Two things to design in before then, both from the reader inventory:
the Chocolate Island 2 loader inherits its sprite bank from the earlier
hard-set (`bank_05.asm:7558-7559`), so a 3-byte hook must keep bank `$07` for
those loads or move their lists with them; and the sprite loop indexes the
list with an 8-bit `Y` (`bank_02.asm:5250-5253`), so a list, header included,
must stay under 256 bytes. The sprite encoder refuses a longer list; this
limit holds with or without a hook. "Sprite lists may live in any bank" is
therefore true only after a hook exists, and for hacks only where a known hook
is already read through: of the four corpus hacks, `LevelTableGate` accepts
the sprite read on two (see Address discovery below).

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
| Layer 2     | `Layer2Ptrs`, `bank_05.asm:8194-8707`, 512 entries                               | 3 bytes                | Loaded at `:7241-7246`. Two kinds of entry, see the inventory: object streams (any bank) and backgrounds.    |
| GFX file    | `GFXFilesLow` `bank_00.asm:6415`, `GFXFilesHigh` `:6467`, `GFXFilesBank` `:6519` | three tables, 50 files | Used by `PrepareGraphicsFile` (`bank_00.asm:6571-6591`).                                                      |
| BGM         | `LevelMusicTable`, `bank_05.asm:513-520`                                         | 8 ids                  | The bank upload is hard-set (`UploadMusicBank1`, `bank_00.asm:145-151`, to `MusicBank1`, `bank_0E.asm:2353`). |

One ROM fact is settled by a static read: `CODE_00B8DE`
(`bank_00.asm:6294-6302`) is a loop that reads bytes until `$FF` and
dispatches on the top three bits of a header byte, which matches the LC_LZ2
description in [../rom/gfx-decompressors.md](../rom/gfx-decompressors.md);
that is a static reading, not a run. The Layer 2 bank is not a plain third
table byte for most entries; see the inventory.

### Reader inventory

Rule 7 needs every reader of a resource. This is the inventory from a static
read of SMWDisX (U ROM), 2026-10-11. Its completeness scope is exactly this:
a text search of the SMWDisX source tree finds the labels `Layer1Ptrs`,
`Layer2Ptrs` and `Ptrs05EC00` only in `bank_05.asm:7235-7255`, and every store
into `Layer1DataPtr`, `Layer2DataPtr` and `SpriteDataPtr` was listed and
classified (below). A reader that uses a literal address instead of a label,
or that a hack added, would not appear in that search. So the list is not
proven complete (see Unconfirmed facts), and a resource whose reader is not
here is refused.

**Sprite lists.**

- The level loader: 2-byte entry from `Ptrs05EC00`, bank hard-set to `$07`
  (`bank_05.asm:7253-7258`).
- The immediate load of `EmptySprites` (`$07C3EE`, `SMW_U.sym` line 8790) at
  `bank_05.asm:7449-7454`, a literal address rather than a table read. The
  same block is also the target of many `Ptrs05EC00` entries (for example
  `bank_05.asm:8898`, `:8927`, `:8939`), so it is shared.
- Chocolate Island 2 (`ChocIsld2Sprites`, `bank_05.asm:7527-7535`): a 16-bit
  pointer read at `:7558-7559`, bank inherited from the earlier hard-set. Its
  block `CI2Sub8Sprites0CD` is also a `Ptrs05EC00` target
  (`bank_05.asm:8914`), so it is shared.

**Layer 1 object lists.**

- The level loader: full 3-byte entry from `Layer1Ptrs`
  (`bank_05.asm:7235-7239`).
- `PtrsLong05D766` (`bank_05.asm:7057-7063`, read `:7473-7478`): 3-byte
  pointers for the ghost house, castle and no-Yoshi entrance scenes. The
  blocks are in bank `$07` (`bank_07.asm:3`).
- Chocolate Island 2 (`ChocIsld2Layer1`, `bank_05.asm:7515-7524`): 16-bit,
  read at `:7556-7557`, bank inherited from the earlier `Layer1Ptrs` load.
  `CI2Sub8Level0CD` is shared with `Layer1Ptrs` (`bank_05.asm:7886`).

**Layer 2.** Two different things share one table.

- *Object streams*: the entry's third byte is a real bank, any bank works,
  loaded at `bank_05.asm:7241-7246`.
- *Backgrounds*: most entries are `dw <address> : db $FF`. The `$FF` is a
  marker, not a bank. The loader tests for it (`bank_05.asm:32-34`), forces
  the bank to `$0C` (`:48-49`, "All backgrounds are stored in bank 0C"), and
  picks the background's Map16 page by comparing the 16-bit address with
  `DATA_0CE8FE` (`:37-40`). So a background is locked to bank `$0C`, and its
  address carries meaning: moving it across that address changes its Map16
  page. The ending sequence repeats the page compare and the bank `$0C` force
  (`bank_0C.asm:707-719`).
  Backgrounds are therefore a separate resource kind, **not relocatable** in
  the first slices; object streams are. In the U ROM table, a count of lines
  at `bank_05.asm:8195-8707` finds 486 entries of the `$FF` form and 26 `dl`
  long pointers.
- Other readers: `PtrsLong05D778` (`bank_05.asm:7065-7071`, read
  `:7479-7484`, mixing a real long pointer with `$FF` backgrounds) and
  `ChocIsld2Layer2` (`bank_05.asm:7537-7546`, read `:7560-7561`).

**Other stores into the data pointers, found by that search and classified.**
They are not readers of the three level tables, so they do not touch a
resource this document moves, but they are listed so the classification can be
checked. `bank_05.asm:465-470` copies the Layer 2 pointer into Layer 1 ("level
to load" chaining). `bank_00.asm:7180` and `bank_04.asm:5725` point Layer 1 at
block-loading and overworld character data. `bank_0C.asm:696-730` and
`:3315-3329` set both pointers from ending and credits tables
(`DATA_0C93C1`, `DATA_0CAD58`) with bank `$0C`; those streams live in bank
`$0C` and are out of scope. `bank_0D.asm:1415-1427` only advances an existing
pointer.

**GFX files.** The three-table read in `PrepareGraphicsFile`
(`bank_00.asm:6571-6591`). The stream reader carries into the next bank
(`ReadByte`, `bank_00.asm:6405-6413`), unlike the object loaders, so a GFX
stream may legitimately span a bank boundary.

**Shared blocks.** Several pointers can reach one block (the examples above).
The build keeps a reader count per block. Editing a shared block gives the
edited level a private copy; the shared original stays for the other readers
and is never freed while one remains. This is also the detection rule for #178.

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
  note's four-hack corpus) is a known hook. `LevelTableGate` accepts its
  sprite read on two of the four (Grand Poo World 1.2 and Seven Vanilla
  Levels) and refuses it on Grand Poo World 2 and Invictus, whose detours
  branch on live RAM ([../rom/level-table-gate.md](../rom/level-table-gate.md)).
  So with the known hook present, the build writes that table instead of
  installing ours on those two; on the other two, sprite lists are read-only.
- **Unrecognised layout on a hack: that resource is read-only.** A different
  or modified table, an unfamiliar replacement of the loading code, or a size
  that does not parse all lead to the same answer: the build refuses to
  relocate it. Reading it for display may still work; writing does not.

**Scope rule: vanilla first (owner priority).** The first implementation targets vanilla
and refuses everything else per resource. Hack support grows one known hook at
a time, each with its signature and its tests.

**Music** is last because songs are not simple pointer-indexed blocks: the
bank upload is fixed in code, the level-to-song mapping is a separate 8-entry
table, and where credits music comes from is UNCONFIRMED. It needs its own
trace before it is scheduled.

Trade-off: starting with sprite and object lists delays GFX and music, but it
is the smallest set that makes "save a modified level" real, and it exercises
every part of the pipeline except the hook (parse, encode, place, pointer);
the hook follows as its own slice.

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

## Open question 4: migration of existing layers

Existing projects hold three kinds of layer, not one:

- **Palette byte ops**, `{ address, old, new }` (`src/rom/PaletteOp.ts`).
- **Map16 word ops**, the same op shape with a full-word mask
  (`FULL_WORD_MASK`, `theia/extension/src/node/map16-decode.ts:754`). A Map16
  subtile word is real data in all 16 bits, not a color.
- **GFX pixel layers**, `"kind": "gfx"` with `chars` of `{ file, tile, pixels }`
  (`src/project/OpsStore.ts:62-69`, `src/rom/GfxLayer.ts`). These are folded
  by `GfxArena`, which re-lays the whole packed region and rewrites the 150
  pointer bytes on every save ([../gfx-arena-budget.md](../gfx-arena-budget.md)).
  That is exactly what rule 1 forbids for the general case.

Palette and Map16 ops are fixed-size and fixed-address, so they cannot move.
GFX layers are already semantic (they say which pixels the user changed).

Options:

- **A. Convert on load, in memory.** Palette and Map16 ops become resource
  edits (set color N of palette P; set subtile of Map16 tile T). GFX layers
  become GFX-resource pixel ops, which they already nearly are. On-disk files
  are left untouched.
- **B. Mixed stack.** Byte-op layers and resource layers coexist; byte ops are
  applied after layout, with a refusal when one targets a moved resource.
- **C. Rewrite the files** to a new format on first open.

**[PROP] A for all three kinds, converting in memory, never rewriting files.**

- A palette or Map16 op never changes size and never moves, so it converts
  without loss. A layer whose address cannot be mapped to a known palette slot
  or Map16 tile is refused, not dropped.
- Not rewriting keeps a project written by today's build opening in today's
  build, and keeps the portable-undo property of old layers.
- B is kept only as a rule: any raw byte op that survives conversion is
  checked against the final layout, and a build in which a byte op targets a
  moved resource fails with a message naming the layer. B alone is rejected
  because it gives every build two semantics, and "byte ops after layout"
  silently changes the meaning of old layers once a resource gains a
  size-changing edit.
- C is rejected because it makes old projects unreadable by older builds for
  no gain.
- **GfxArena. [PROP] replaced, on a schedule.** Until GFX is migrated (it is
  second in the catalogue), `GfxArena` stays as shipped and is knowingly exempt
  from rule 1. When GFX moves to the build, per-file placement replaces the
  whole-region relay: only an edited file's stream is placed, in place when it
  fits. The structure-preserving encoder in `GfxLayer.ts` and `GfxTable.ts` is
  kept, because it is what makes unedited files reproduce byte for byte. The
  region-wide relay and its 102,185-byte export cost for a one-pixel edit in
  the first file are retired with it.

Conversion is tested on synthetic layers of all three kinds (no ROM): convert,
build, and compare to the old applier's result byte for byte; plus a planted
defect (wrong palette index, wrong Map16 mask) that must turn the comparison
red.

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

- *Vanilla.* The candidates are the fill runs SMWDisX lists as free in
  `freespace.txt`. That file lists SNES addresses (for example `$0BFD0D` to
  `$0BFFFF`, the run that is file offsets `$05FD0D..$05FFFF` in
  [../gfx-arena-budget.md](../gfx-arena-budget.md)), one column per ROM
  version, and its basis for each run is "all `$FF`" in that version. It beats
  a scan for long `$FF` runs because a scan cannot tell fill from data that
  happens to be `$FF` (the GFX note makes the same point). The build uses the
  U column, and refuses J and E ROMs, because the columns differ. Each run
  must also read as all fill in the actual ROM, must not be reached by any
  reader in the inventory, and must lie inside one bank for the loaders that
  do not carry across banks (the object and sprite loaders advance 16 bits,
  `bank_05.asm:689-695` as quoted in map-data-mechanics). That rule is per
  loader: the GFX stream reader does carry (`bank_00.asm:6409-6411`), so a GFX
  block may cross a boundary. The run `$0EF0F0-$0EFFFF` is excluded even
  though the list shows it free, because the corpus hacks keep their sprite
  bank table at `$0EF100`
  ([../rom/level-table-gate.md](../rom/level-table-gate.md)). Placement honours
  per-resource bank rules: sprite lists stay in bank `$07` until the sprite
  hook exists (two of the vanilla runs are in `$07`).
- *Hack.* Free space cannot be known from the disassembly. The candidates
  are, in order: (1) the old block of a resource this build is moving, only
  if no RATS tag and no reader in the inventory claims it (a block another
  tool tagged is never reused, even if our pointer used to point at it);
  (2) space appended past the end of the ROM. Appending is safer than
  anything else, not collision-proof: it changes the header size byte, the
  checksum and the mapping, and stops at the 4 MB ceiling, so #218 owns those
  checks. (3) Nothing else by default. Fill runs inside a hack are never
  claimed on a guess, and RATS-tagged blocks are never allocated into. A
  user-confirmed fill run could be an explicit later choice; it is not
  proposed here.
- *Order.* The allocator is deterministic: candidates are sorted by address and
  the first that fits wins. First-fit is simple and reproducible; best-fit can
  come later if fragmentation shows up in measurements.

The vanilla supply is small. Only the `freespace.txt` runs count as free (two
in bank `$07`, `$07E76F-$07EFFF` and `$07FC90-$07FFFF`, plus the GFX tail); the
14517 figure does not, see the Problem section. So expansion is expected to be
the usual path for a real editing session, and #218 is on the design's
critical path.

## Open question 6: hook model

The issue says "hooks are layers". A stored hook layer leaves three things
undefined: two edit layers that need the same hook, undoing a hook layer while
data that depends on it remains, and where the hook's signature lives.

Options:

- **A. Derived by the build.** The build decides, from the final resource
  content, which hooks it needs and installs them. A hook has no layer of its
  own.
- **B. Stored hook layers.** Installing a hook is an entry in the stack, with
  its site fingerprint recorded in the layer.

**[PROP] A.** It departs from the issue's wording, so this is what is kept:

- _Only when needed._ No resource needs the hook, no hook is written.
- _Never twice._ Before writing, the build fingerprints the site (the
  convention under Address discovery). If our stub or a known foreign hook is
  already there, nothing is written. The fingerprint and the stub bytes live in
  source, tested by the byte-level stub test; the project stores nothing extra
  (the same position as question 5).
- _Two layers, one hook._ Both layers' content is built, the hook is derived
  once. Under B the second layer would have to detect the first's hook or
  install it twice.
- _Undo._ Undoing a layer rebuilds from base. If no remaining content needs the
  hook it is not derived; if other content still does, it is. Under B, undoing
  the hook layer first would leave data pointing at a table the game no longer
  reads, and the stack would need dependency tracking to prevent it.
- _Cost._ The user has no stack item for "this edit needed a code change". The
  build reports it as a note. A project cannot pin a hook that nothing uses,
  which is acceptable because an unused hook has no purpose.
- _Determinism._ The set of hooks is a function of final content, so rule 4
  holds without recording order.

Safety 6 covers a site that matches neither our stub, the base code nor a known
foreign hook: the build refuses and writes nothing there.

## Safety

A broken hook crashes the game. It does not draw one wrong tile. This section
is a requirement on every resource and hook, and on any later implementation
PR.

1. **Boot check per hook.** Every hook has a check that loads the built ROM
   in the libretro core, reaches the point where the moved data is read, and
   confirms the moved data loads. The oracle is concrete: after the level
   loads, read the game's sprite tables and the Layer 1 tilemap out of the
   core's WRAM and compare them with what our own decoder produces for the
   edited content. The project's rule (derive state from the core, never write
   through it) applies. This check needs a ROM and the core, so it cannot run
   in CI: it runs on owner hardware, and its tests use `describe.skipIf`.
   What CI runs instead is everything with a synthetic cart: byte-level stub
   tests, the toy-loader relocation tests (item 3), and a test that the boot
   check's comparison logic itself goes red on a planted mismatch, with no
   core involved.
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
   and the planted defects must be ones that can actually go red: the same
   project built from permuted layer and resource input orders must give
   identical bytes (an order-dependent allocator turns it red), and the clock
   is injected, so a planted version that writes the clock into a block
   differs between two injected times. (Map iteration order and a bare
   timestamp are not valid plants: the first is insertion-ordered, the second
   only differs if the clock ticks.) Claims carry their scope: "N runs, one
   machine", never a bare "deterministic".
6. **Signature drift.** The build fingerprints each hook site before it
   writes. If the site matches the base code or our stub, it proceeds. If it
   matches a known foreign hook, it adopts it (rule 2). If it matches none of
   these, another tool changed it, so the build refuses and writes nothing
   there.
7. **Copyright.** No ROM-derived bytes are committed. Matched patterns over 32
   bytes are digests, and a hook stub contains only code this project wrote.

## Re-scoping of the dependent issues

**#24, save a modified level back to the ROM.** It stops being "write bytes at
the level's addresses". It becomes the first consumer of the build: the
editor emits sprite and Layer 1 object ops on resources, and Save runs the
build. It must not ship on byte ops. Scope for the first slice is vanilla,
sprite and Layer 1 object lists, placed in the vanilla fill runs, with the
sprite-list 256-byte limit enforced and shared blocks copied before editing.
The sprite hook is not in this slice: vanilla bank `$07` has free runs, so no
first edit needs it. It is a later slice, when bank `$07` runs out. Hack ROMs
refuse per resource. Backgrounds (Layer 2 entries ending in `$FF`) are not
editable by relocation.

**#57, free space manager.** It is the allocator described in question 5, not
a separate UI feature. First slice: the deterministic first-fit allocator over
the vanilla candidate set, RATS read and write, and the expansion tail. Any
view of free space is a reader of the allocator's state.

**#178, relocate shared sprite pointers before editing.** One case of rule 7
and the shared-block rule. Many `Ptrs05EC00` entries point at one block
(`EmptySprites`), and `CI2Sub8Sprites0CD` is reached from both
`Ptrs05EC00` and `ChocIsld2Sprites`. The build finds sharing by counting every
reader in the inventory, not only the table, copies a shared block before
editing it, and never frees a block that still has a reader. The fix is part
of the build's pointer handling, not a pre-pass in the editor.

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
- Completeness of the reader inventory. It lists the readers found by static
  reading of the cited regions; a search of the whole disassembly for every
  other reference to these tables and blocks (including the overworld and
  boss rooms) is still to be done and must be a committed trace before any
  resource is moved.
- The exact composition of the 5526 bytes between the map note's 14517
  unreferenced bytes and the 8991 that `freespace.txt` lists in banks `$06`
  and `$07` (entrance-scene and Chocolate Island 2 data is the suspected
  part).
- How the Layer 2 background address range is partitioned between Map16 pages
  beyond the single compare at `DATA_0CE8FE`; relocating backgrounds is out of
  scope until that is traced.
- That first-fit is adequate; no fragmentation measurement exists.

Read statically from SMWDisX only (not run): `CODE_00B8DE` is the LC_LZ2 loop
(`bank_00.asm:6294-6302`).

## Related reading

- [project-format.md](project-format.md) - the layer stack this builds on
- [overview.md](overview.md) - the edit model and where bytes may live
- [../gfx-arena-budget.md](../gfx-arena-budget.md) - the GFX numbers
- [../rom/map-data-mechanics.md](../rom/map-data-mechanics.md) - map data and the sprite bank hook
- [../rom/level-table-gate.md](../rom/level-table-gate.md) - the existing hook detection
- [../testing.md](../testing.md) - copyright rule, synthetic fixtures, corpus gating
