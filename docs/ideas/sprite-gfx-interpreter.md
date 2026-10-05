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

| Property | `interpret.ts` (Layer 1 handlers) | Needed for a sprite |
|---|---|---|
| Values | unknown (`null`) propagates; refuses at a branch, index, pointer or tile write | concrete: a sprite reads Mario, camera and timers before its first draw call |
| RAM | closed set: direct page, a few named cells, two Map16 buffers; any other read refuses | 143 distinct WRAM cells read in MAIN, 57 in INIT (section 1.1), plus its own tables |
| `JSL` | only the `ExecutePtrLong` hash | `ExecutePtr` (16-bit table) at the top of every dispatch, plus the shared draw routines |
| Output | writes to the Map16 buffers | writes to OAM `$0300-$03FF`, size table `$0460` |
| Opcodes | 65 cases | 140 distinct opcodes executed over the 197 completing sprites; 79 of them outside the 65 |

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

| Input | RAM | Sprites |
|---|---|---|
| sprite lock | `$9D` | 197 |
| sprite number, slot | `$9E`, `$15E9` | 197, 181 |
| `$15AC` (turn timer), `$1692` (sprite memory setting) | | 197, 197 |
| camera X / Y low and high | `$1A`, `$1B`, `$1C`, `$1D` | 186, 186, 183, 181 |
| sprite position highs / lows | `$14D4`, `$14E0`, `$D8`, `$E4` | 179, 176, 171, 164 |
| sprite properties (priority) | `$64` | 160 |
| TrueFrame | `$13` | 157 |
| ScreenMode (vertical level) | `$5B` | 139 |
| Mario position, "next" and "now" | `$94-$97`, `$D1-$D4` | 101, 95, 88 |
| Yoshi / net / powerup / animation / duck | `$187A`, `$13F9`, `$19`, `$71`, `$73` | 104, 96, 100, 100, 100 |
| EffFrame | `$14` | 37 |
| level length | `$5D` | 94 |

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

| Result | Count |
|---|---|
| ran INIT and MAIN to completion (no refusal) | **197** |
| refused | **4** |
| completed and wrote at least one OAM tile | **174** |
| completed, nothing drawn on pass 1 | 23 |

The 4 refusals, all honest:

| Id | Reason |
|---|---|
| `$36` | `COP` (`$02`): its handler is `DATA_01E41F`, data not code (the `CallSpriteMain` table row "36 - Unused", bank_01.asm) |
| `$B6` | `COP` after the `Bnk3CallSprMain` chain's tail block; I did not trace why |
| `$33` Fireball, `$B3` Bowser statue fireball | 400,000-step budget: the routine waits on state the seed lacks (Mario, level) |

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

| Id | What | Evidence |
|---|---|---|
| `$2D` baby Yoshi, `$33` fireball | write `DynGfxTilePtr` (`$0D85-$0D98`), tiles DMA'd per frame (rammap.asm:1321) | 4 writes each, `$02:EA41`, `$01:E1AB` |
| `$9B` Hammer Brother | writes `DynPaletteTable` (`$0682`), CGRAM upload (rammap.asm:1155,1164) | 20 writes, `$03:DFD2` |
| `$35` Yoshi, Mario, cape | same dynamic-tile scheme, but `$35` drew nothing in my run so it is not measured | n/a |
| `$5F` brown chained platform | uses the multiply unit, not a blocker once `$4216` is modelled | 38 register writes |

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

| Run | Exact match | Mismatch |
|---|---|---|
| Pass 1 | **9 of 16** (`$00 $03 $04 $07 $0F $11 $13 $14 $2C`) | 7 |
| After 16 passes | **14 of 16** (all but `$1F`, `$2C`) | 2 |

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

| Ids | dx | dy | Note |
|---|---|---|---|
| `$1A $4B $4F $50 $9A` | +8 | -1 | `InitPiranha`-style; Y borrow handled |
| `$0E $8E` | +8 | 0 | |
| `$26 $A6` | +8 | 0 | |
| `$3C $BC` | 0 | +1 | |
| `$52` | 0 | -1 | |
| `$5B $5D` | 0 | +24 | |
| `$5F` | +120 | +104 | chain platform centre |
| `$63 $64` | +2 | 0 | |
| `$6C` | -8 | 0 | |
| `$2A $AA` | +8 | -17 | |
| `$54` | +8 | +7 | |

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

| Field | Shape | Filled today | Evidence |
|---|---|---|---|
| **Anchor** (position after INIT) | `{x, y}` 16-bit, plus the raw placement it started from | **199 of 201** (INIT alone; `$33`, `$B3` refuse) | section 8; 27 ids shift it |
| **Parts** | list of `{char, size 8/16, dx, dy, flipX, flipY}` from OAM; 16x16 also split to four 8x8 as `EnginePart` does | **174 of 201** on pass 1, **178** within 400 passes (`$49 $4D $4E $7A` appear later), 19 never, 4 refuse | section 3; 9 of 16 descriptors exact on pass 1, 14 of 16 settled |
| **Palette** | CGRAM row per part, `8 + ((attr >> 1) & 7)`, plus char-high bit and priority bits from the same attribute byte | **174 / 178**, same sprites as Parts | row is in the OAM attribute the cart wrote; `$15F6` is seeded by running `LoadSpriteTables` then INIT; INIT changes the row for at least 2 sprites (skip-INIT run differs by palette only) |

Palette caveat: this gives the ROW, not the colours. `$9B` writes
`DynPaletteTable` at runtime (20 writes, bank_03.asm:10212): row known,
colours unknown, so the model carries `colours: 'runtime'` for it. Only 1 of
197 completing sprites showed a runtime CGRAM write; `$2D` and `$33` show
runtime GFX pointer writes, which affect pixels, not rows.

What cannot be data, and how it is marked. Measured by running each completing
sprite with Mario at X `$010` and at X `$1FF` (sprite at `$080`):

| Field | Changes with Mario's side | Of 197 |
|---|---|---|
| Anchor | 0 | independent in all |
| Palette row per part | 0 | independent in all |
| Parts (mostly flipX, tile order) | 71 | dependent: facing |

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
