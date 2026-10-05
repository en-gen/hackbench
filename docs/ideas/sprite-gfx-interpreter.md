# Running a sprite's own routines instead of describing them

Feasibility spike, 2026-10-05. Branch `feature/sprite-interpreter-spike`.
Prototype: `src/rom/spriteInterp/` (`Cpu65816.ts`, `spriteRun.ts`).
Measurement and pins: `test/suite/unit/spriteInterp/` (`spike.test.ts`
writes the full tables to `$SPIKE_OUT`).

## Evidence scope

Everything below was RUN, not read, unless it says "read". One machine,
`vanilla.sfc` for the per-id numbers, the six corpus files for section 3's
cross-cart row. Sprite slot 0, `$1692` = 0, sprite placed at level (128,128),
camera (0,0), Mario at the same X as the sprite, one emulator-free concrete
65816 core (about 700 lines after formatting). No hardware or emulator capture was compared.
The only oracle is the table engine, itself a static trace (see
`sprite-engine-divergence.md`). ROM/ASM facts are cited `SMWDisX file:line`
and were read raw with `sed`/`grep`, not through `smw-mcp` (logged in
`smw-mcp/docs/query-log.md`). Nothing ROM-derived is committed.

## Verdict in three lines

1. It works far better than expected: 197 of the 201 table ids run INIT and
   MAIN to completion on a general 65816 core, 174 of them draw on the first
   pass, and 14 of the 16 descriptor sprites reproduce the engine's parts
   exactly once past start-up timers.
2. It must be a SIBLING of `interpret.ts`, not a generalization of it: the
   65-opcode, unknown-tracking, closed-RAM design refuses all 201.
3. Owner ruling (overrides the whether question): drawing and placement are
   interpreted from ROM code, because hacks carry custom sprites; no per-sprite
   tables, no INIT-delta table. Section 7 is therefore HOW, and the measurements
   say it is buildable.

## 1 Can `interpret.ts` be generalized

No, and the reason is structural, not a missing-opcode list.

| Property | `interpret.ts` (Layer 1 handlers)                                                     | Needed for a sprite                                                                      |
| -------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Values   | unknown (`null`) propagates; refuses at a branch, index, pointer or tile write        | concrete: a sprite reads Mario, camera and timers before its first draw call             |
| RAM      | closed set: direct page, a few named cells, two Map16 buffers; any other read refuses | 143 distinct WRAM cells read in MAIN, 57 in INIT (section 1.1), plus its own tables      |
| `JSL`    | only the `ExecutePtrLong` hash                                                        | `ExecutePtr` (16-bit table) at the top of every dispatch, plus the shared draw routines  |
| Output   | writes to the Map16 buffers                                                           | writes to OAM `$0300-$03FF`, size table `$0460`                                          |
| Opcodes  | 65 cases                                                                              | 140 distinct opcodes executed over the 197 completing sprites; 79 of them outside the 65 |

`Cpu65816.ts` is the sibling: every opcode and mode except decimal ADC/SBC,
`COP`, `BRK`, `WDM`, `STP`, `WAI`, `XCE`, `RTI` (these refuse and name the
opcode). The shared GFX routines are not modelled: `JSR`/`JSL` into
`GetDrawInfo`, `SubSprGfx0/1/2` and `SubOffscreen` just execute the cart's own
bytes, so a hack that edits them is read as edited. That is the property the
owner's ruling wants (key on the resolved pointer, run what is there).
Hardware: `$2000-$5FFF` reads 0 and writes are counted; the CPU multiply and
divide unit (`$4202-$4206`, `$4214-$4217`) is modelled because sprite `$5F`
needs it (`SMWDisX bank_01.asm:10346-10358`).

Seeding is what the game's own spawn path does, run as code: set `$9E`, `$14C8`
= 1, position, `$15E9` = slot, then `JSL InitSpriteTables` ($07:F7D2, which
runs `ZeroSpriteTables` and `LoadSpriteTables`, so the OAM attribute `$15F6`
and the six tweaker bytes come from the cart's own tables), then `JSR
$0180D2` (OAM index and timer decrements, bank_01.asm:139-171) and `JSR
HandleSprite` ($018127). OAM entries are read back from `$0300-$03FF` where a
tile byte was written, and large OBJs are split into four 8x8 parts exactly
the way `SpriteDrawEngine.largeObj` does so the two outputs are comparable.

### 1.1 What a routine reads before it writes (inputs)

Measured as "WRAM read before anything in the run wrote it", over the 197
completing sprites, MAIN pass after INIT (count = sprites that read it):

| Input                                                 | RAM                                   | Sprites                |
| ----------------------------------------------------- | ------------------------------------- | ---------------------- |
| sprite lock                                           | `$9D`                                 | 197                    |
| sprite number, slot                                   | `$9E`, `$15E9`                        | 197, 181               |
| `$15AC` (turn timer), `$1692` (sprite memory setting) |                                       | 197, 197               |
| camera X / Y low and high                             | `$1A`, `$1B`, `$1C`, `$1D`            | 186, 186, 183, 181     |
| sprite position highs / lows                          | `$14D4`, `$14E0`, `$D8`, `$E4`        | 179, 176, 171, 164     |
| sprite properties (priority)                          | `$64`                                 | 160                    |
| TrueFrame                                             | `$13`                                 | 157                    |
| ScreenMode (vertical level)                           | `$5B`                                 | 139                    |
| Mario position, "next" and "now"                      | `$94-$97`, `$D1-$D4`                  | 101, 95, 88            |
| Yoshi / net / powerup / animation / duck              | `$187A`, `$13F9`, `$19`, `$71`, `$73` | 104, 96, 100, 100, 100 |
| EffFrame                                              | `$14`                                 | 37                     |
| level length                                          | `$5D`                                 | 94                     |

The brief's "frame counter `$13`/`$14`": it is `$13` almost everywhere; `$14`
only 37 sprites. `$157C` (facing), `$1602` (frame), `$15EA` (OAM index) are NOT
inputs: INIT or `CODE_0180D2` writes them first. Facing is derived, not seeded
(section 5). Below `$14`, reads fall to 15 sprites or fewer each (`$148B/$148C` 15,
`$1490` 13, `$13E3` 11): the long tail is interaction code.

## 2 Does INIT run first, and can it run in the same core

Yes to both. INIT is the same dispatch (`CallSpriteInit`, bank_01.asm:225) and
INIT ran inside all 197 completing runs (the 4 refusals are in section 3). It matters: re-running every drawing sprite with the INIT pass
skipped (status forced to 8) changes the output of 32 of 174 (18%): 9 tiles,
8 positions, 7 draw nothing, 6 part counts, 2 palettes. Examples:
the Yoshi egg (`$2C`), the climbing-net Koopas (`$22-$25`), the four platforms
(`$55 $57 $5C $63`). So INIT is not optional.

## 3 Coverage on `$00-$C8`

Vanilla, 201 ids, first MAIN pass after INIT:

| Result                                       | Count   |
| -------------------------------------------- | ------- |
| ran INIT and MAIN to completion (no refusal) | **197** |
| refused                                      | **4**   |
| completed and wrote at least one OAM tile    | **174** |
| completed, nothing drawn on pass 1           | 23      |

The 4 refusals, all honest:

| Id                                           | Reason                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `$36`                                        | `COP` (`$02`): its handler is `DATA_01E41F`, data not code (the `CallSpriteMain` table row "36 - Unused", bank_01.asm) |
| `$B6`                                        | `COP` after the `Bnk3CallSprMain` chain's tail block; I did not trace why                                              |
| `$33` Fireball, `$B3` Bowser statue fireball | 400,000-step budget: the routine waits on state the seed lacks (Mario, level)                                          |

The 23 that draw nothing on pass 1: 4 draw after N further passes (`$49` at 6,
`$4D` and `$4E` at 3, `$7A` at 5); 19 never draw within 400 passes (`$12` and
others that are unused or invisible by design, `$19` message box, `$1F`
Magikoopa (teleports to Y=176, hidden), `$35` Yoshi, and unlisted ones in
`spike.test.ts` output). I did not investigate the 19 beyond that. It is
unknown how many are "legitimately invisible" versus "seed is missing".

Cost: steps per sprite (setup + INIT + MAIN, pass 1) median 609, p95 1,270,
max 3,077. A full 201-id sweep is not a performance concern.

Opcodes the existing interpreter lacks, ranked by sprites that execute them
(of 201 runs): `PLY $7A`, `JML [abs] $DC` (both from `ExecutePtr` itself),
`LDA dp,X $B5`, `PHX $DA`, `PLX $FA`, `STZ abs $9C`: all 201. Then `PHP $08`
187, `STZ abs,X $9E` 186, `CMP dp $C5` 186, `ADC abs,Y $79` 185, `PLP $28`
185, `LDY abs,X $BC` 184. This ranking is nearly useless: the top six block 201
because they sit in `ExecutePtr` and `CODE_0180D2`, which every sprite runs. A
greedy "add the most common missing opcode" order unblocks 2 of 197 sprites
after 5 opcodes, 4 after 20, 8 after 30, and needs all 77 non-dispatch
opcodes for 197. Separately, `JSL` to anything but the `ExecutePtrLong` hash
refuses at the first dispatch, and every unmodelled RAM read refuses.
(Method: opcode bytes taken from the `case 0x..` list of `interpret.ts`'s own
`switch`, so this ignores mode restrictions inside a case; the true blocked
set is a superset.)

Sprites that cannot be completed this way, read from RAM writes during the run
(OAM is fine; the PIXELS come from hardware uploads):

| Id                               | What                                                                             | Evidence                              |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| `$2D` baby Yoshi, `$33` fireball | write `DynGfxTilePtr` (`$0D85-$0D98`), tiles DMA'd per frame (rammap.asm:1321)   | 4 writes each, `$02:EA41`, `$01:E1AB` |
| `$9B` Hammer Brother             | writes `DynPaletteTable` (`$0682`), CGRAM upload (rammap.asm:1155,1164)          | 20 writes, `$03:DFD2`                 |
| `$35` Yoshi, Mario, cape         | same dynamic-tile scheme, but `$35` drew nothing in my run so it is not measured | n/a                                   |
| `$5F` brown chained platform     | uses the multiply unit, not a blocker once `$4216` is modelled                   | 38 register writes                    |

For these the OAM entries are still valid; what the interpreter cannot give is
the char data behind a tile number, which the GFX decoder already supplies from
the sprite set. The engine's `dynamicCgram` `PaletteNote` covers `$9B`-style
cases already; the interpreter would need the same note.

IMPORTANT, a false-confidence measurement: "completes" is not "correct". Ids
`$C9-$FF` are past the 201-entry pointer table, so the dispatch reads whatever
bytes follow it as pointers, and the interpreter completes **55 of 55** of them
and draws 43. A refusal-free run proves nothing about meaning; the guard must be
that the id is inside the table and the resolved pointer lands in code.

Cross-cart (all six files, ids `$00-$C8`): 197 completions and 174 drawing
on each. Vanilla and magic have no moved pointers; the four hacks move 1 or 2
INIT/MAIN pointers each, and all four differ from vanilla in the first 9 bytes
of `CallSpriteMain` (read): three start with a `22 xx xx xx` JSL hook, Seven
Vanilla Levels differs only in the ninth byte. The core ran them unmodified. The identical counts show the core copes with a
hacked dispatcher; they do NOT show those ids render correctly in the hack.

## 4 Interpreted OAM against the 16 descriptors

Engine side: `drawSpriteParts` with `spriteX` 0x80, `marioX` 0x80,
`romFrame` 0. Interpreter side: `runSprite(id)`, parts normalized to the engine's
`EnginePart` (char with the OBJ base and char-high bit, palette row, flips,
dx/dy from the sprite origin). Compared as sorted sets.

| Run             | Exact match                                         | Mismatch |
| --------------- | --------------------------------------------------- | -------- |
| Pass 1          | **9 of 16** (`$00 $03 $04 $07 $0F $11 $13 $14 $2C`) | 7        |
| After 16 passes | **14 of 16** (all but `$1F`, `$2C`)                 | 2        |

Pass-1 mismatches, classified:

- **Start-up phase, 4** (`$01 $02 $05 $06`, red and blue Koopas, shelled and
  not). The sprite starts in a different animation frame (tile pair +2): `$1602`
  = 2 for passes 1 to 8, then 0, which is the engine's frame 0. A timer INIT
  seeds, not a defect in either side. They match after settling.
- **Hidden at start, 3** (`$1F`, `$4D`, `$4E`). No OAM on pass 1.
  `$4D`/`$4E` draw from pass 3 and then match the engine. `$1F` Magikoopa never
  draws in 400 passes (teleports off screen, Y=176).
- After 16 passes `$2C` Yoshi egg becomes a mismatch because the egg wobble
  starts (`$151C` = 45, tile pair advances); the engine's frame 0 is the pose
  before it. That is animation, not disagreement.

Frame-counter sweep: `$13`=`$14`=f for f in 0..63, one pass each, matched against
the engine at the same `romFrame`. 32 of 64: `$00 $01 $02 $03 $04 $07 $0F $11
$13 $14`. 64 of 64: `$2C`. 0 of 64: `$05 $06 $1F $4D $4E`. I did not explain the
32 of 64 pattern or adjudicate any sweep frame against the ROM; treat these as
descriptive.

Planted defects (`spriteRun.test.ts`): NOP out `SubHorizPos`'s `BPL` ($01:AD3E)
and the Goomba's parts change; NOP out the `STA` that writes its tile and no OAM
remains. `Cpu65816.test.ts` pins an index-register `PHX/PLY` width bug that I
actually had during the spike (a wrong width left every dispatch landing on
`$FF:0000`). Neither proves value correctness of every opcode; opcode flag
semantics beyond what the 197 runs exercised are untested.

## 5 The "first frame" rule as seeded state

The map rule is: frame 0 of the sprite's own sequence, facing derived from
Mario's start. As seeded state:

- Facing is not seeded. INIT calls `FaceMario`/`SubHorizPos`
  (bank_01.asm:6124-6134), which reads `PlayerXPosNow` (`$D1/$D2`) minus the
  sprite X. Seed Mario's X (both `$94` and `$D1`; I seeded only `$94` first and
  got the wrong facing on every sprite) and facing falls out. Mario at or right
  of the sprite is `$157C` = 0, matching the engine's `marioX >= spriteX`.
- Frame is not seeded either. `$1602` is written by the routine from timers
  and `$13`/`$14`. "Frame 0" is therefore a POLICY: run INIT, then N MAIN
  passes with `$13` ticking, and read the result. N=1 shows the first drawn
  frame; N=16 clears start-up timers for all 16 descriptor sprites but two. The
  honest framing is "the cart's own sprite, N frames after spawn", and the UI
  (or the descriptor) owns N. Sprites whose frame advances only on the ground
  (walkers: `$1570` stays 0 with no floor) hold their frame without Map16.
- Intent frames (`$4D` rubble, `$2C` egg before wobble) still need data. The
  interpreter can say what the sprite does at pass N, not what the map should
  SHOW. That is the line between augment and replace.

## 6 Custom (PIXI) sprites: notes only

No PIXI cart is in the corpus (ids `$C9-$FF` behave identically on vanilla and
on the four hacks, apart from one id on Seven Vanilla Levels), so this is
untested. What a PIXI sprite needs:

- Its code lives in freespace behind PIXI's own per-sprite tables; PIXI hooks
  `CallSpriteMain` and INIT dispatch in place. The core runs the cart's entry
  bytes, so the hook should run unmodified: section 3 shows it running a hacked
  entry. Needed: `JSL`/`JML [dp]` (have), freespace banks (LoROM only today;
  SA-1 carts need remapped RAM and are out).
- Per-instance data: PIXI sprites read "extra bytes" and extra property bytes
  from level sprite data, copied to RAM at load. The seeder must read the
  level's sprite list; `$00-$C8` runs need none.
- Tweaker bytes come from PIXI's table read by `LoadSpriteTables`-style code in
  the cart (run, not modelled).
- Graphics: tiles come from an inserted ExGFX file chosen by the level's SP
  slots; OAM tile numbers are valid, pixels come from the existing GFX path.
- Some PIXI sprites use `$7E`-bank scratch RAM and SA-1-style `$3xxx` mirrors:
  the second kills the approach for SA-1 carts.

## 7 How to build it (the interpreter path)

Ruling: no hardcoded per-sprite data from the disassembly. The measurements
support that: 199 of 201 INITs and 197 of 201 full INIT+MAIN runs complete on
a general core with no per-id code. So the question is the build, not the choice.

1. **Entry and seeding (generic only).** Spawn the way the game does:
   `InitSpriteTables`, then INIT (status 1), then N MAIN passes, all by
   running the cart's bytes from the resolved MAIN/INIT pointers. The seed is
   the table in section 1.1 and nothing per id. A sprite that needs a special
   seed to look right is a finding to fix in the generic seed, never a table.
2. **Placement comes from INIT, then GFX.** Position shifts such as `$4F`'s
   (+8, -1) come out of the INIT pass: 27 ids move the sprite and the core
   yields each shift by running INIT (section 8). Draw offsets come from the
   OAM the MAIN pass writes. The map layer reads `(INIT-shifted origin, OAM
parts)`, so the owner's `$4F` half-tile error disappears with no table.
3. **Guards, because completion is not correctness.** Id inside the pointer
   table; resolved pointer in code; step budget; refusal reported with its
   reason and shown as "appearance unverified" (today's honest degrade). The
   `$C9-$FF` result (55 of 55 complete, 43 draw, all meaningless) is why.
4. **When the table engine goes.** Not at the start. Phase A: interpreter
   runs beside the engine for the 16 descriptor sprites and must match (14 of
   16 settled, 9 of 16 at pass 1, with the 5 mismatches each explained in
   section 4); the engine stays the fallback. Phase B: when the interpreter
   covers the engine's cases and the settle policy (N passes, section 5) is
   decided, descriptors are deleted and `SPRITE_DRAW_DESCRIPTORS` with them.
   What cannot be derived from running code, "which pose to show" (the `$4D`
   rubble, the egg before it wobbles), is a UI/policy choice of N, not
   per-sprite data.
5. **Custom sprites** fall out for LoROM non-SA-1 carts (section 6): the same
   path runs their freespace code. What blocks it: SA-1, per-instance extra
   bytes that need the level sprite list, dynamic GFX and CGRAM uploads
   (OAM is right, pixels need the existing GFX path; `$2D $33 $9B`).

The "no custom renderer" ruling holds: no sprite-specific code path exists.

Expected size, estimates not measurements: hardened core 500 lines; service
(seeding, settle policy, guards, 16-bit `$13/$14`) 250; mapping to `EnginePart`
plus palette and dynamic-GFX notes and wiring 350; tests (synthetic per opcode
and mode, planted defects, 197-id sweep pinned, descriptor comparison) 700;
docs 200. About 2,000 lines, about a week, plus the phase B deletion.
Open risks: 19 sprites draw nothing in 400 passes, unexplained; the level seed
(Mario position, Map16 under the sprite) is a UI decision `SpriteRenderContext`
already anticipates; HiROM and SA-1; no comparison to a live core, so "matches
the engine" means two static derivations agree.

## 8 INIT position adjustments (added at the owner's request)

Question: which INIT routines move `$E4/$14E0/$D8/$14D4`, by how much, and does
running INIT in the core reproduce it. Method: INIT only (no MAIN pass) at 5
seeds, (X,Y) = (`$080`,`$080`), (`$1B5`,`$14C`), (`$2F3`,`$003`), (`$3D0`,`$1A7`,
Mario X `$10`), (`$1FF`,`$0FF`, Mario X `$5FF`), reading the 16-bit position
before and after. Vanilla, slot 0. 27 of the 197 completing ids move the sprite
at all; the other 170 leave it alone. `$4F` gives (+8, -1), which is exactly
`InitPiranha` (bank_01.asm:880-889), so the core reproduces the owner's finding
by running the cart's own INIT; pinned in `spike.test.ts`.

Constant across the first four seeds (dx, dy in pixels):

| Ids                   | dx   | dy   | Note                                  |
| --------------------- | ---- | ---- | ------------------------------------- |
| `$1A $4B $4F $50 $9A` | +8   | -1   | `InitPiranha`-style; Y borrow handled |
| `$0E $8E`             | +8   | 0    |                                       |
| `$26 $A6`             | +8   | 0    |                                       |
| `$3C $BC`             | 0    | +1   |                                       |
| `$52`                 | 0    | -1   |                                       |
| `$5B $5D`             | 0    | +24  |                                       |
| `$5F`                 | +120 | +104 | chain platform centre                 |
| `$63 $64`             | +2   | 0    |                                       |
| `$6C`                 | -8   | 0    |                                       |
| `$2A $AA`             | +8   | -17  |                                       |
| `$54`                 | +8   | +7   |                                       |

(`$AA` and `$2A` share one INIT, as do `$9A`/`$1A` and so on: aliases via the
shared handler, not separate code.) Not constant:

- **Low-byte-only add.** Every `+8` row gives -248 at X low `$FF` (seed 5): the
  add is on `SpriteXPosLow` and the carry into `$14E0` is dropped, so the
  delta is +8 only while X low < `$F8`. That is ROM behaviour as run, and a
  table that stores "+8" is wrong at those columns unless it also drops the
  carry. Likewise `$2A` dy is -17 on the low byte only (65519 at Y low `$03`).
- **State-dependent, no constant:** `$29`/`$A9` (Koopa Kid: delta differs
  at every seed, no simple form) and `$65-$68` (X snaps to a column: deltas 15
  or -241 depend on the low nibble, and -64 at seed 1), so they are alignment
  rules, not offsets.

INIT counts (vanilla, INIT only, no MAIN): 199 of 201 INITs run to completion
(`$33` and `$B3` hit the step budget); 27 of them move the sprite, and the core
yields all 27 shifts by running INIT, no table. Under the ownership ruling the
shifts come from this path. The `$29`/`$A9` and `$65-$68` rows show why a table
could never have covered them (state-dependent: they need code). Evidence limit:
five seeds, one slot, vanilla; a delta driven by Mario or level state beyond
those seeds could hide.

## 9 Proposed generic sprite model, version 1

Owner scope: three fields. Everything the interpreter emits per placed sprite
(id, extra bits, level position) is the key; the model is:

| Field                            | Shape                                                                                                          | Filled today                                                                                             | Evidence                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anchor** (position after INIT) | `{x, y}` 16-bit, plus the raw placement it started from                                                        | **199 of 201** (INIT alone; `$33`, `$B3` refuse)                                                         | section 8; 27 ids shift it                                                                                                                                                                 |
| **Parts**                        | list of `{char, size 8/16, dx, dy, flipX, flipY}` from OAM; 16x16 also split to four 8x8 as `EnginePart` does  | **174 of 201** on pass 1, **178** within 400 passes (`$49 $4D $4E $7A` appear later), 19 never, 4 refuse | section 3; 9 of 16 descriptors exact on pass 1, 14 of 16 settled                                                                                                                           |
| **Palette**                      | CGRAM row per part, `8 + ((attr >> 1) & 7)`, plus char-high bit and priority bits from the same attribute byte | **174 / 178**, same sprites as Parts                                                                     | row is in the OAM attribute the cart wrote; `$15F6` is seeded by running `LoadSpriteTables` then INIT; INIT changes the row for at least 2 sprites (skip-INIT run differs by palette only) |

Palette caveat: this gives the ROW, not the colours. `$9B` writes
`DynPaletteTable` at runtime (20 writes, bank_03.asm:10212): row known,
colours unknown, so the model carries `colours: 'runtime'` for it. Only 1 of
197 completing sprites showed a runtime CGRAM write; `$2D` and `$33` show
runtime GFX pointer writes, which affect pixels, not rows.

What cannot be data, and how it is marked. Measured by running each completing
sprite with Mario at X `$010` and at X `$1FF` (sprite at `$080`):

| Field                            | Changes with Mario's side | Of 197             |
| -------------------------------- | ------------------------- | ------------------ |
| Anchor                           | 0                         | independent in all |
| Palette row per part             | 0                         | independent in all |
| Parts (mostly flipX, tile order) | 71                        | dependent: facing  |

So Anchor and Palette are pure data. Parts are data PLUS a facing input: the
model stores parts for one declared seed and a `dependsOn: ['marioX']` set,
derived mechanically by the two-run diff above (same method flags any future
input), never from a per-id list. Sprites that read other state (`$14`, 37;
`$187A`, 104; section 1.1) are marked by the same diff over that input, which
was not run here. A frame sequence from N passes is also an input-dependent
view: ground walkers hold one frame without Map16 (section 5).

Later (not in v1, one line each; none measured beyond what is stated):
identity (id, extra bits, resolved INIT/MAIN, vanilla vs custom): pointers are
read today, vanilla-vs-custom is `describeHandlerProvenance`; frame sequences
over N passes: runs today, adjudication is open; properties from the sprite
tweaker tables: `LoadTweakerBytes` fills them in the run (`$1656-$190F`);
resource needs (chars, CGRAM rows, runtime uploads): dynamic writes detected
for 3 ids (section 3); observed side effects (spawned sprites, scroll or
layer RAM writes, map writes): the core sees every WRAM write but nothing
records them yet; per-field provenance and failure reason: refusal reason and
address are already returned per run.

## 10 Interpret versus transpile to JS

Not built: I did not transpile any routine, so nothing below about a
transpiler is measured; the interpreter numbers are.

Shared either way: the opcode decoder and operand lengths, M/X flag tracking
(needed to size immediates; the interpreter uses live flags, a transpiler needs
them per basic block and must fork or version a block that is reached with
both widths), and resolving `ExecutePtr`-style jump tables (a transpiler needs
the table at translate time; vanilla's dispatch is `JSL ExecutePtr` plus an
inline word table, which is the recognizable shape `interpret.ts` already
hashes).

What transpiling adds: code generation per basic block; a sandbox, because a
hack ROM is untrusted and generated JS is code execution (the interpreter's
loop is bounded by a step budget and cannot escape its WRAM array; generated JS
needs `Function` isolation or a worker plus a budget check at every back edge);
and a policy for unresolved indirect jumps (`JMP (abs,X)`, `JML [dp]`), which
the interpreter simply executes and a transpiler must either trap or
translate lazily. It also needs self-modifying-code detection: RAM-resident
code cannot be translated once.

What it buys: speed and readable output. Speed is not a need here: the full
201-id vanilla sweep (setup + INIT + MAIN, 942,748 instructions) took 82 ms on
one machine including allocating 201 cores, so the interpreter already runs
about 11 million instructions per second against a median of 609 per sprite.
Debuggable output is real value, but a per-instruction trace
(`Cpu.trace`) already gives a readable listing.

Recommendation: interpret, and keep the decoder and flag tracking in shared
modules so a transpiler can be added later behind the same entry if a use
appears (for example whole-level simulation, which this spike did not measure).
Do not build a transpiler for sprite INIT and GFX: the sandboxing and
indirect-jump work buys speed the workload does not need.

## 11 Prior art (from the owner's survey; not re-checked here)

Taken as reported, no links verified by me. No maintained standalone 65816 core
for JS or WASM exists, which supports extending `Cpu65816.ts` rather than
adopting one.

- Test data: SingleStepTests/65816 (github.com/SingleStepTests/65816), per-opcode
  JSON cases. Licence unverified: use as test data for full opcode and M/X
  coverage, do not vendor. This is the missing oracle for the untested flag
  semantics noted in section 4.
- CPU references to consult if stuck, MIT: angelo-wf/SnesJs (archived),
  DirtyHairy/yasnes (TypeScript), angelo-wf/LakeSnes (C).
- Read for ideas only, never copy: mstan/snesrecomp (PolyForm Noncommercial).
  Its jump tables need hand-written per-bank config; ours resolve targets at
  run time (`ExecutePtr` runs as code), so that cost does not arise.
- snesrev/smw is a hand port: reference only.

Folded into the recommendation: extend our interpreter, do not transpile
(agrees with section 10). Add a differential oracle on a dev machine, our
OAM output against bsnes or snes9x for the same spawn state, which would
replace "two static derivations agree" with a live comparison.

## 11 The runner (step 2, #584), accuracy rounds

Code: `src/rom/sprites/interp/` (`SpriteBus`, `SpriteSeed`, `SpriteDispatch`,
`SpriteRunner`), on the SingleStepTests-clean core `src/rom/cpu/Cpu65816.ts`.
Graders: `test/suite/unit/sprites/spriteGrade.captures.test.ts` (Mesen
`layers_v5` level-load captures, shape tier) and `spriteTrace.test.ts` (Mesen
`sprite-trace` call replay, exact tier). Both are `describe.skipIf` on their
fixtures and the vanilla ROM, and are ORACLES ONLY: the captures never feed
the runner. Evidence scope: one machine, vanilla, Mesen 2.x.

How it runs (no per-id code anywhere): the ROM's own dispatch is read for the
two pointer tables (HandleSprite's status table gives CallSpriteInit, whose
inline table is INIT; HandleSprite's `JMP` gives CallSpriteMain, whose inline
table is MAIN; each shape is byte-checked and refused when it differs); an id
past the 201-entry table, or a pointer below `$8000`, is refused before
anything runs. Then the game's own sprite loop (`$01:808C`) runs once for INIT
and N times for MAIN. It must be the loop and not `HandleSprite`: the loop
sets DB to bank 1, and routines read bank-1 tables through DB.

### 11.1 Grading definitions

Layers_v5 tier, one verdict per recorded sprite (rounds 0 to 7: best of the
passes; from 12.2 the chosen frame against every recorded frame), offsets
relative to the sprite's own position at the recorded draw; priority bits not
compared. `exact` same tile, size, palette/flip bits and offsets. `shape`
same pieces and arrangement, offset from the sprite differs (the sprite moved,
or ground contact the capture had and the seed lacks). `close` same tile
multiset, offsets or flips differ. `wrong` drew, nothing matches. `refused`,
`empty` as the runner reports. The captures record the FIRST ON-SCREEN draw of
a free-moving sprite with Mario elsewhere, so `shape` and `close` are mostly
tier-2 differences (position, frame, Mario's side), not decode errors.

### 11.2 Rounds, level-load tier (layers_v5, 1,957 recorded vanilla sprites, ids $00-$C8)

Seed column: G = generic seed only (placement, camera, Mario from the record);
L+M = plus the level-state cells of 11.4 and the Map16 tables; W = plus the
whole low-WRAM image (oracle seed, an upper bound, not a runtime input).

| Round | Change                                                     | Seed | exact | shape | close | wrong | refused | empty |
| ----- | ---------------------------------------------------------- | ---- | ----- | ----- | ----- | ----- | ------- | ----- |
| 0     | `HandleSprite` called directly, DB 0                       | G    | 325   | n/a   | 104   | 1,404 | 115     | 9     |
| 1     | call the game's sprite loop (DB 1)                         | G    | 559   | n/a   | 313   | 965   | 113     | 7     |
| 2     | add `shape` verdict                                        | G    | 559   | 221   | 92    | 965   | 113     | 7     |
| 3     | OAM mirror is 64 entries; the high table was read as OAM   | G    | 917   | 497   | 171   | 251   | 113     | 8     |
| 4     | seed the whole low WRAM                                    | W    | 952   | 512   | 176   | 229   | 35      | 53    |
| 5     | W plus Map16 tables                                        | W+M  | 984   | 584   | 72    | 228   | 35      | 54    |
| 6     | level cells + status 9 allowed + status 0 is "erased"      | G    | 956   | 497   | 171   | 251   | 78      | 8     |
| 6     | same                                                       | L    | 987   | 503   | 176   | 227   | 0       | 64    |
| 6     | same, plus Map16                                           | L+M  | 1,022 | 573   | 78    | 219   | 0       | 65    |
| 7     | INIT re-runs while status stays 1; counters tick per frame | G    | 956   | 511   | 154   | 250   | 56      | 30    |
| 7     | same                                                       | L+M  | 1,034 | 581   | 63    | 214   | 0       | 65    |
| 7     | same, 64 MAIN passes instead of 16                         | L+M  | 1,215 | 570   | 30    | 137   | 0       | 5     |

Lines of code added: round 0 to 3 about 1,680 (runner, bus, dispatch, seed,
graders, synthetic cart and tests, doc); rounds 4 to 7 about 440 more (180 of them the spawn grader).

Rounds 0 and 1 pre-date the `shape` verdict (counted in `wrong`/`close`). Round
3's class was an attribution bug (a spurious tile at "OAM 91"). Best-of-N
passes is lenient on frame choice: 16 to 64 passes moves 181 sprites from
`empty`/`wrong` to `exact`, mostly sprites that start hidden (the podoboo waits
32 frames before it shows).

### 11.3 Exact tier: call replay against Mesen (`sprite-trace`)

Each recorded INIT or MAIN call (WRAM image and registers at entry, every
write the call made) is replayed on the core: 1,110 of 1,122 calls over 77
sprite ids are write-for-write equal (hardware multiply included; PPU writes
the recorder dropped are not compared; a swapped adjacent pair from 16-bit
read-modify-write order, which the core does not model, counts as equal).
The 12 misses are state the fixture does not carry (WRAM above `$2000` except
Map16: `$7F:9BFA`, `$7F:837D`). Planted defect: NOPing HandleSprite's first
instruction makes all 20 sampled calls diverge.
Before the Map16 tables were loaded the same replay was 614 of 1,122: sprite
block contact (`$1693`, `$18D7`) reads them. This tier proves the core, bus and
dispatch; it says nothing about seeding, which 11.2 and 11.5 grade.

### 11.4 Level state a sprite reads (found by measurement)

`RunOptions.trackInputs` records the WRAM a run reads before anything wrote
it. Over the 1,957 recorded sprites the level-derived cells (not the sprite's
own slot, Mario or the camera) are: `$5B` ScreenMode, `$5D` LevelScrLength,
`$64` SpriteProperties, `$85` LevelIsWater, `$86` LevelIsSlippery, `$190E`
SpriteBuoyancy, `$1692` SpriteMemorySetting, `$82-$83` SlopesPtr, `$148B/C`
RNGCalc, and the Map16 tables (`$7E:C800`, `$7F:C800`). They are the
`LevelState` fields of `SpriteSeed`. Seeding only these, with Map16, is as good
as seeding the whole low WRAM (1,034 against 984 exact in the same round).

### 11.5 Spawn tier (sprite-spawn, 201 ids, slot 0, 16 passes each)

One id per run at a fixed placement, so the comparison is absolute OAM, with the
seed turned into a `SpriteSeed` from the fixture's own baseline (level `$0BD`).
Graded from each call's write log, not hardware OAM: hardware OAM lags the
mirror by one frame (the NMI copies the mirror first), which an earlier version
of the grader got wrong and scored 0 exact.

| Measure                                                                  | Result                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| anchor (position after INIT) equal to the recorded one                   | 198 of 201                                                                                                   |
| the other 3                                                              | refused, and Mesen's own INIT never returned (`$33`, `$A0`) or its MAIN hung (`$36`, COP)                    |
| MAIN passes recorded and graded                                          | 3,216 of 3,216 slots; 101 have no recorded call (the harness ran 16 frames in all, so INIT retries use some) |
| exact (every owned OAM entry equal in slot, X, Y, tile, attribute, size) | 2,714                                                                                                        |
| exact, both empty                                                        | 276                                                                                                          |
| close (same tiles, a position or flip differs)                           | 11                                                                                                           |
| wrong                                                                    | 66                                                                                                           |
| refused, agreeing with Mesen                                             | 48 (3 ids x 16)                                                                                              |

The 66 wrong and 11 close passes are 7 ids: `$1E` Lakitu (Mesen shows the
cloud, we show Lakitu: a state difference), `$2B`, `$2D` baby Yoshi, `$3E` and
`$80` (pass 0 only: we draw, Mesen's first call writes nothing), `$61` floating
skulls (Mesen writes one of the four entries), `$82` bonus game (50 entries
against 5). None was investigated beyond this; the cause is not known.

### 11.6 Remaining failure classes, ranked

1. Sprite state that depends on Mario or the level and is not in the seed
   (Boo `$37`, Rip Van Fish `$3D`, Lakitu `$1E`, fish out of water): the
   layers_v5 `wrong` and `close` rows. Tier 2 by design.
2. Movers and ground contact: `shape` verdicts (offset from the sprite differs
   by a constant per id), because the capture caught the sprite after it moved.
3. Which frame to show (`N` passes): `empty` at 16 passes, `exact` at 64.
4. Spawn-mode oddities above (7 ids), cause not known.
5. Not run: SA-1, HiROM (refused by a mapping check only), custom sprites.

### 11.7 Risks

- The three fixed entry points (`$01:808C`, `$01:8127`, `$07:F7D2`) are the
  game's own loop in vanilla; a hack that moves them is refused by the shape
  check, not followed. The sprite loop (12.3) and HandleSprite are
  byte-checked, and so are InitSpriteTables at `$07:F7D2` and GetRand at
  `$01:ACF9` (13.1), each before it is called.
- `dependsOn` is only `marioX`; RNG and the frame counters are inputs too and
  are not diffed. Measured, not claimed: 71 of 197 depended on Mario in the
  spike.
- Spawn fixtures use level `$0BD` state; the layers_v5 tier seeds from each
  map's level-load image. Neither proves custom (hack) sprites.
- The core does not store 16-bit read-modify-write high-byte first; the same
  bytes land, in a different order. Nothing here observes the order.

## 12 Follow-up rounds (2026-10-05): provenance, frame policy, spawn classes

### 12.1 Provenance of every seed value

The runner reads nothing from a capture. Rounds 4 to 7 in 11.2 used capture
values inside the GRADER only (an "oracle seed", an upper bound). The runtime
seed is now:

| Value                                                             | Source                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `$5B` `$5D` `$64` (level header cells)                            | the ROM's own header parse, run on the core (`LevelLoader.ts`, CODE_05D8B7 then CODE_05801E)         |
| `$82-$83` slope pointer, `$1692` sprite memory, `$190E` buoyancy  | same run (tileset code, sprite header byte)                                                          |
| `$85` `$86` water and slippery                                    | same run, via the Mario-entrance routine CODE_00A635                                                 |
| Map16 low and high tables `$7E:C800`, `$7F:C800`                  | same run: every Layer 1 object expanded by the ROM's own object handlers                             |
| `$71` `$76` `$19` `$187A` `$13F9` `$73` (Mario entrance and form) | CODE_00A635                                                                                          |
| the level's own sprite list                                       | the ROM's loader spawns it; the runner zeroes all 12 status bytes so only the sprite under test runs |
| placement, camera, Mario X/Y, `$13/$14`, pass count               | the caller's seed (a fixture or UI supplies them)                                                    |
| `$148B/C` RNGCalc                                                 | the ROM's own GetRand, run once on the core (see below)                                              |
| `$76` Mario direction                                             | the loaded image's value; the seed default is a fallback                                             |

RNGCalc: its only writer is CODE_01AD07 (bank_01.asm:6101-6121), and one GetRand call from zero leaves 6 and 3, which is what every level-load capture held (98 of 98 maps). An earlier version of this table called it a constant with no ROM source; that was wrong.

Measured against Mesen (sprite-trace, vanilla): every header and entrance
cell equal on every map that recorded a WRAM image; both Map16 tables
byte-identical on 88 of 154 maps, 3 more differ only past the level's end, 63
differ inside the level (cause not investigated; Mesen may have captured after
in-level changes). Accuracy delta of ROM seed against oracle seed, layers_v5,
chosen-frame policy: exact 932 against 914, shape 572 against 563, wrong 300
against 344. Spawn tier: identical (both 2,714 exact before the grouping fix
below). Test: `ROM-run level loader against Mesen level state`.

### 12.2 Frame policy and set-membership grading

The model carries `chosen`: the first pass at or after INIT that draws at least
one tile, within a cap of 64. Grading: the chosen frame's parts must equal SOME
frame Mesen recorded for that sprite (all recorded frames, not one).

Layers_v5, 1,957 recorded sprites, ROM seed unless stated:

| Policy and seed                             | exact | shape | close | wrong | refused | empty |
| ------------------------------------------- | ----- | ----- | ----- | ----- | ------- | ----- |
| chosen frame, ROM seed (headline)           | 932   | 572   | 136   | 300   | 0       | 17    |
| chosen frame, oracle seed                   | 914   | 563   | 131   | 344   | 0       | 5     |
| chosen frame, generic seed (no level state) | 931   | 469   | 130   | 343   | 56      | 28    |

The 280 sprites between chosen and best-of-64 are animation phase: Mesen's
recorded frames come later than the first draw (Rip Van Fish asleep is tile
`$AE` first, `$8C/$8E` later). That is a frame-choice policy gap, not a seed
gap.

### 12.3 Sprite-loop entry check

`resolveLoop` byte-checks the loop at `$01:808C` (PHB PHK PLB, then the
`LDX #$0B / STX $15E9 / JSR setup / JSR handle / DEX / BPL` countdown) and takes
the setup and HandleSprite addresses from its two JSR operands. A different
shape is refused with a reason. Planted: a countdown of `$0A` instead of `$0B`
refuses (synthetic cart test).

### 12.4 The seven unexplained spawn ids

Replaying each recorded call on the core from Mesen's own pre-call state (WRAM
image plus the harness's high-WRAM blocks) is write-for-write equal for all
seven: none is a core or bus bug. After two grader fixes the status is:

| Id                | Class                                                                                                                                                                                                                                                | Evidence                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `$1E` `$61` `$82` | grader bug: sprites that spawn others log extra calls in the same frame; I had read only one call per frame                                                                                                                                          | after grouping every call of a frame, all three are exact in 16 of 16 passes |
| `$3E` `$80` `$2D` | grader bug: status-9 sprites log their calls as `other`, not `main`, so I was a frame early                                                                                                                                                          | exact after finding the first non-INIT call                                  |
| `$2B`             | seed gap: Mesen enters its first MAIN with about 1,000 cells of state in `$1BB4-$1DD3` and `$1693/$1928` that our run does not have (written by code outside the sprite loop in frame 0); 15 of 16 passes draw nothing in Mesen and one tile in ours | cause of those cells not identified                                          |

Spawn tier now: 2,776 exact, 276 exact-empty, 15 wrong (all `$2B`), 48 refused
and agreeing with Mesen, 101 unrecorded; anchors 198 of 201, the other 3
agreeing refusals. A Boo (`$37`) mismatch with the ROM seed was the Mario
direction `$76`, found by `trackInputs` and now seeded.

### 12.5 Largest remaining class (Mario and level dependent)

Seed-gap ranking by reads of cells the seed lacks (`SPRITE_GRADE_INPUTS`):
`$13/$14` frame counters, `$D1/$D3/$D4` Mario position (both are fixture
seeds, differing from where Mesen's Mario was at draw time), `$71` (now
ROM-derived), `$148B/C` (constant). So the Mario and level cells are no longer
the lead class: after them, 572 `shape` and 300 `wrong` verdicts are sprite
position and animation phase at the instant Mesen drew (the sprite had moved
or fallen: a Koopa at `y` 353 in Mesen against 368 in ours), which the level
captures cannot settle because Mario and the sprite were free-running. The
next fixture that would settle it is a per-frame sprite-position log, which the
spawn fixtures carry only for level `$0BD`.

## 13 Review round (adversarial review of 3da8f52b)

### 13.1 What changed

- Every fixed entry is byte-checked and refused with a reason when it differs:
  the sprite loop (already), InitSpriteTables `$07:F7D2`, GetRand `$01:ACF9`,
  and the level loader's four: the bytes leading into the mid-routine entry
  (`$05:D8AE`, "an entry that exists is not an entry that is reached"), the
  entry `$05:D8B7`, `$00:A635` and `$05:801E`. The loader also runs under the
  same instruction guard as the runner (no BRK/COP/WDM/STP, no leaving ROM).
- Corpus: all four hacks (Grand Poo World 2, Grand Poo World 1.2, Invictus,
  Seven Vanilla Levels) now REFUSE the loader with a reason; before, it returned
  "ok" with values from a path the hack had rerouted. The first failing check is
  not the same for each (see 14.1: the lead-in check this paragraph first used
  was replaced). Vanilla and the magic ROM load. Test: `level loader on the
hack corpus`.
- OAM: the whole mirror `$0200-$03FF` is read (128 entries, one size byte each
  at `$0420`), not only `$0300`. `SpritePart.oam` is now 0-127. Sprites that
  draw into the first page (vanilla `$1E`, `$7B`, `$87`, `$8A`) were being
  dropped; `$8A` drew only there and got a false "drew no OAM tile".
- `$76` is written from the seed only when no loaded image supplies it.
- RNG derived by GetRand (12.1). `LevelState.rng` is gone.
- `wramBase`, `map16` and `blocks` are gone from `SpriteSeed`. Oracle images
  are built in test support (`oracleImage.ts`) and passed through the one
  whole-WRAM entry, `loaded`.
- Doc cites: CODE_0584E3 is called at bank_05.asm:428 (defined 523), CODE_0581FB
  at 253.

### 13.2 Graders can fail

Each tier asserts floors and has a planted-defect run (ExecutePtr `$00:86DF`
patched to RTL: nothing runs, the exact count collapses). Floors are the
measured count minus about 3%. Mutants applied to the runner, one at a time:

| Mutant                   | Went red in                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| X not set to the slot    | synthetic (InitSpriteTables stores through X), captures floor (exact 936 to 515) |
| level sprites not zeroed | synthetic (two slots draw different OAM entries), captures floor (936 to 748)    |
| INIT retry removed       | synthetic (id 13), spawn (refused-differs 48), captures (refused 22)             |
| frame counter not ticked | synthetic (id 14), spawn floor (exact 2,792 to 2,164)                            |
| RNG not derived          | synthetic (id 15), spawn floor (2,792 to 2,647)                                  |
| execution guard removed  | synthetic (id 11 jumps to `$7E:0000`; COP id 4)                                  |
| loader skips `$00:A635`  | synthetic loader (`$71` stays 0)                                                 |

### 13.3 Headline numbers re-derived (vanilla, one machine)

Layers_v5, 1,957 sprites, 64 passes, chosen-frame policy, set membership:

| Seed                                   | exact | shape | close | wrong | refused | empty |
| -------------------------------------- | ----- | ----- | ----- | ----- | ------- | ----- |
| ROM-run level loader (headline)        | 936   | 572   | 136   | 300   | 0       | 13    |
| oracle (capture level cells and Map16) | 942   | 565   | 131   | 318   | 0       | 1     |
| generic (placement only)               | 951   | 469   | 130   | 327   | 56      | 24    |

Delta from the `$0200` page fix on the headline row: exact 932 to 936, empty 17
to 13 (the four are sprites that draw only there). Spawn tier (201 ids, 16
passes): 2,792 exact (was 2,776), 260 exact-empty (was 276), 15 wrong (all
`$2B`), 48 refused and agreeing with Mesen, 101 unrecorded; anchors 198 of 201.
The ROM seed beats the generic seed on `shape` (572 against 469) and has no
refusals; it trails the generic seed by 15 exact, a seed difference I did not
investigate.

## 14 Review round 2

### 14.1 The loader checks the path it models

The loader sets `SublevelCount` ($141A) to 1 (a sublevel entry), so it follows
the sublevel branch of CODE_05D796, not the overworld lead-in at `$05:D8AE-D8B6`
that 13.1 byte-checked. Round 1's attribution ("all four first fail on Lunar
Magic's JSL at `$05:D8B1`") described that lead-in, which the sublevel path
never executes; it was the wrong thing to check and is gone. Now checked, in
order: GM11's three calls (`$00:96F4` JSL CODE_05D796, `$00:9705` JSR CODE_00A635,
`$00:9716` JSL CODE_05801E), the GM11 code between them (`$00:96F8` and `$00:9708`;
the music upload between the first two is not modelled and not checked),
CODE_05D796's prologue and sublevel branch (`$05:D796`), the JMP into the pointer
loader (`$05:D83B`), and the four entries of 13.1. The first failure per corpus ROM:

| ROM                   | First failing check                    |
| --------------------- | -------------------------------------- |
| Grand Poo World 2 1.1 | GM11 code at `$00:9708`                |
| Grand Poo World 1.2   | pointer loader at `$05:D8B7`           |
| Invictus 1.0          | GM11 code at `$00:9708`                |
| Seven Vanilla Levels  | GM11 code at `$00:9708` (its JSL hook) |

Witness: vanilla with `$05:D83B` = `4c 00 80` refuses. None of the four fails on
`$00:A635` first; the BRA there is never the reported reason now.

### 14.2 GetRand and the FastROM mirror

`checkGetRand` accepts a JSL bank of `$01` or `$81` (36 of 101 SMWC hacks use
the mirror), consistently with `checkInitTables`. Witness: vanilla with
`$01:ACFF` and `$01:AD04` set to `$81` runs and gives the same passes.
Seven Vanilla Levels on ids `$00 $04 $0D $1E $2B $48 $8A`, default seed (its
loader refuses, so generic): before, all seven were refused ("GetRand is not the
two-step shape"); after, all seven run and draw on pass 0 (1, 2, 1, 5, 4, 1 and 1
parts), seed source `generic`.

### 14.3 `seedSource`

The model reports `seedSource`: `'rom-level-load'` when a loaded image was
given, else `'generic'` with `seedReason` (the loader's refusal text when the
caller used `levelSeed`, which runs the loader and records why it refused). A
caller that draws sprites should mark generic-seeded ones unverified.

### 14.4 Mutants M11, M15, M18

Synthetic ids now exercise them: id 17 (an INIT that retries and records `$13`
and `$14` of each call: retry frames must tick), id 18 (tile from `$14`: `$14`
must tick in MAIN), id 19 (writes the tile byte every frame but a Y only on odd
frames: a stale Y from the previous pass must not make it visible, which the
per-pass OAM clear guarantees).

### 14.5 Not on this branch

Loader support for Lunar Magic's `$05:D8B1` hook: 0 of 101 hacks load today,
filed as its own issue. Convention note: the `loaded` seed field takes any
bytes; "captures never become a runtime input" is held by review and by keeping
oracle images in test support, not by the type.

## 15 Step 3: the map editor's sprite layer draws from the interpreter (#585)

`theia/extension/src/node/map-sprites.ts` now serves `interpDrawer`: per map,
`loadLevelState` once (the ROM's own level loader), then per stream sprite one
`runOnce` (INIT plus up to 64 passes, no `dependsOn` second run). Seeds, all
generic: the loader's WRAM; sprite = stream position in level pixels; camera
centred on the sprite and clamped to the map's scroll range; Mario at
`readMarioStartPos` for the slot. The `chosen` frame's OAM parts are drawn at
the anchor INIT left; a 16 x 16 entry is four chars (tile, +1, +$10, +$11). A
refusal or an empty run stays a 16 x 16 marker carrying the interpreter's
reason. Replies are cached per working-copy bytes and map.

Measured (vanilla, one machine, node, cold map, whole layer): `$105` 255-280 ms,
`$106` 130-175 ms, `$00F` ~200 ms, the vanilla map with most sprites (`$120`, 65) ~320 ms. Nothing near the 1 s line; no optimisation made.

Drawn / marker on vanilla: `$105` 31 of 34 (was 0 of 34 by the table engine),
`$106` 21 of 25 (was 15 of 25). The markers are ids `$DA`/`$DB` (past the
201-entry pointer table, refused by the runner) and ids that draw no tile in 64
passes. Placement: `$4F` on `$105` is served at the stream position plus (8,
-1), `(1816, 335)`, `(2232, 319)`, `(4552, 319)`. The `$106` `$05` box is
unchanged `(432,304)-(448,336)`.

Against the table engine over ten vanilla maps (62 sprites the engine draws),
parts relative to each side's own anchor: 25 agree, 36 differ, 1 the
interpreter draws nothing for. Of the 36 differing rows, 19 are tile or flip
(a walk-cycle frame or a facing: the engine's frame-0 pose against the first
drawing pass), 16 are +1 px Y walk-frame offsets (ids `$03`-`$06` on `$11B`, `$008` and
`$006`; these overlap the tile bucket, so the two counts are not disjoint), and `$1F` on
`$11C` is relocation by its own MAIN (x 352 to 304 by pass 1, flipped), which
depends on Mario and the RNG. None is a mis-placement found by this
comparison. The list is pinned per row (verdict, served anchor, a digest of
the interpreter's part keys) in `test/suite/unit/MapSpritesInterp.test.ts`.
Mario's start for a ROM-run seed is the loader's own `$94/$96`; the table
re-derivation (`readMarioStartPos`) is used only for a generic seed; it moved no
pinned row.

Runtime palette: sprite code does not write `$2122` itself; it appends to
WRAM that NMI uploads. No NMI runs on the core, so `Machine.nmi()` models the
palette part of one after every frame (INIT frames and each pass;
`PassResult.palette` is cumulative). Direct `$2121/$2122` writes take effect in
order during the frame. Then `CODE_00A488` walks one list shape for every
source (bank_00.asm:4726-4748): `[byte count, CGRAM color index, colors]`
repeated to a zero count. The source is `PaletteIndexTable` `$0680` (an index
into the three-entry table, bank_00.asm:4709-4712): 0, the default, is
`DynPaletteTable` `$0682` (rammap.asm:1152-1164; Magikoopa's writer
`CODE_01C028`, bank_01.asm:8733-8760), read from where the run began on the
first frame, then `$0681` and the first list byte are cleared
(bank_00.asm:4753-4756); nothing bounds an entry to the 127-byte table, the
DMA reads on past it (only the end of WRAM stops the walk). 6 is the same list
starting at `MainPalette` `$0703` (rammap.asm:1172-1175), whose first bytes are
a header, not color 0 (the overworld writes `$FE, $01` and a terminator at +$100,
bank_04.asm:5585-5590; the level upload zeroes them, bank_00.asm:2047-2048); it
is walked only when the run itself wrote `$0680` (no vanilla sprite bank does),
and leaves the dynamic list for the next NMI. 3, `CopyPalette`, is not
modelled. `$0680` is cleared after (bank_00.asm:4757). The served frame applies
the writes up to its pass, to that sprite only. Before this model the list was
never drained: `$1F` on `$11C` overflowed the table from pass 30 into
`$0701`/`$0703`, and an earlier mirror rule read that as colors 0-7.

Measured on vanilla (196 maps with a sprite stream, every id the interpreter
draws): only `$C5` (boss Big Boo, map `$0E4`) has runtime colors at its served
frame: 8 colors at CGRAM `$F0`. `$1F` (Magikoopa, `$11C`) uploads from pass 2
on, but its first drawing pass (1) comes before the first upload, so the served
frame has none; the run's last upload equals the table engine's resting-entry
splice (test). That is the frame policy's doing (this section notes it), not a missing
route.

Not modelled here: neighbours or player actions (each sprite runs alone).

### 15.1 A refused level loader is shown, flagged

`loadLevelState` now refuses carts whose loader entry points or shape differ
from stock (GPW 1.1/1.2, Invictus, Seven_Vanilla_Levels on the corpus). The map
drawer then seeds each run from placement alone (the map's screen mode and
length, generic defaults for the rest) and sets `MapSpriteDto.unverified` on
EVERY sprite it answers, drawn or marked, plus a map-level `note` and the
sprite toggle's tooltip. Evidence scope, this corpus, one machine: every cart
whose loader refuses also has a `LoadLevel` the map model refuses (512 of 512
maps unavailable), and GPW's `HandleSprite` is not stock either, so the
runner refuses there as well; the path is therefore reached only through the
drawer in tests today. Vanilla `$105`/`$106` counts (31/34, 21/25) and the
engine-vs-interpreter list are unchanged by the review-round merge.
