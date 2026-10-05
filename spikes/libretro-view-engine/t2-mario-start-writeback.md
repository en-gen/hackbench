# Writing Mario's Starting Position

Status: research spike (T2), read-only. No code or ROM data was written. Drafted 2026-09-19.

**Evidence scope.** Opened `C:\Projects\SMWDisX\bank_05.asm` (lines 7032-7466,
7080-7164, 9222-9741) and `C:\Projects\SMWDisX\bank_00.asm` (lines 2594-2665,
2600-2665, 4470-4496, 8410-8430, 8560-8580, 9610-9636, 13000-13070). Read
`C:\Projects\SMWDisX\bank_05\MEMO.md` in full per the repo's memo protocol
(no other bank had a task-relevant MEMO). Read `src/rom/L3Loader.ts` in full
and `src/rom/model/MapBuilder.ts`, `src/rom/model/SmwMap.ts`,
`src/rom/ObjectExpander.ts`, `src/rom/RomFile.ts`, `src/rom/addressing.ts`,
`src/rom/LevelParser.ts` (relevant sections). Measured the vanilla ROM at
`C:\Users\engenb\Super Mario World (USA).vanilla.sfc` (524288 bytes,
headerless, confirmed via `len(rom) == 524288`) with an ephemeral Python
script run from the scratchpad directory (not committed, not part of this
deliverable) to read specific bytes for level `$105` and to survey
`DATA_05F600` across all 512 levels. Did NOT trace bank_00's death/respawn
game-mode handlers, the `MidwayFlag` read site (grep found 5 writes to it in
bank_00/bank_05 but no read), or PAL/other-region byte tables. Those gaps are
labeled unverified below.

**Follow-up pass (this revision).** Corrected the sublevel primary-entrance
claim below (§1, §5.1) after re-reading `bank_05.asm:7200-7470` in full,
`rammap.asm` (lines 1-24, 1241, 1965-1999), `bank_0D.asm:1400-1449`,
`bank_00.asm:2594-2670`, `SMW_U.sym`, and `tools/mesen/headless_capture.lua`'s
TRACED MECHANISM comment - citations are inline below. For the
`readMarioStartPos` X-high claim (§6): re-read `src/rom/L3Loader.ts:1-60,
296-322`, `src/rom/SmwRom.ts:1-70`, `src/rom/model/CLAUDE.md`, grepped
`docs/` (no documented deviation found), read the introducing commit
(`git show 100bdda`), and re-ran the `DATA_05F600` survey script with
per-level orientation classification added. For the MEMO's `ShowMarioStart`
claim: re-read `bank_05.asm:7416-7437`, `bank_00.asm:2594-2611`, and
`bank_05\MEMO.md:69-105` directly - confirmed true, already correctly
captured in §5.2 below, no doc change needed there.

## 1. Where the data lives

**Verified.** Mario's primary-entrance start position for level `$N` is built
from per-level attribute bytes plus small ROM-wide shared lookup tables. None
of it is in the 5-byte level header. This matches `bank_05\MEMO.md`'s X-position
snapshot and I independently re-derived the Y side and the shared-byte layout
from `bank_05.asm:7227-7396` (`CODE_05D8B7`/`CODE_05DA17`, called from
`GM11LoadLevel` at `bank_00.asm:2632` via `JSL CODE_05D796`, `bank_00.asm:2644`).

Per-level tables (SNES address + `levelId`, one byte per level, 512 entries,
`$000-$1FF`):

| Table | SNES base | Role |
|---|---|---|
| `DATA_05F000` | `$05F000` | bits 0-3 = Y-table index; bits 4-7 = Layer2 scroll-setting index |
| `DATA_05F200` | `$05F200` | bits 0-2 = X-table index; bits 3-5 = `LevelEntranceType`; bits 6-7 = `Layer3Setting` |
| `DATA_05F400` | `$05F400` | bits 0-1 = Layer2Y-init index; bits 2-3 = Layer1Y(camera)-init index; bits 4-7 = `DisableMidway` (see caveat below) |
| `DATA_05F600` | `$05F600` | bit 7 = `DisableNoYoshiIntro`; bits 5-6 = `ScreenMode`; bits 0-4 = screen number 0-31 |

(`bank_05.asm:7268-7299, 7302-7337`; cross-verified against
`src/rom/L3Loader.ts:79-106` and `src/rom/ObjectExpander.ts:27-45`, which
already port the Layer3Setting/camera-Y reads from these same bytes.)

Shared lookup tables (ROM-wide, not per-level - used by every level via the
index above):

| Table | SNES base | Entries | Role |
|---|---|---|---|
| `DATA_05D730` | `$05D730` | 16 | Y low byte |
| `DATA_05D740` | `$05D740` | 16 | Y high byte |
| `DATA_05D750` | `$05D750` | 8 | X low byte |
| `DATA_05D758` | `$05D758` | 8 | X high byte, **vertical levels only** (values are 0 or 1) |

(`bank_05.asm:7032-7053`.)

Address derivation: SNES `$05F000 + levelId` (etc.) is a plain LoROM address;
convert with the codebase's own `loromToOffset` (`src/rom/addressing.ts:35-51`):
`fileOffset = (bank & 0x7F) * 0x8000 + (addr & 0x7FFF)`, bank = byte 2,
addr = low 16 bits. No copier-header adjustment on this ROM (headerless,
524288 bytes, confirmed).

**Sublevels (`$100-$1FF`) DO have a primary-entrance table entry that the
game uses at runtime - an earlier draft of this doc claimed otherwise, and
that was wrong.** `DATA_05F000`/`DATA_05F200` are read for any 16-bit level
id, not just `$000-$0FF`. `bank_05.asm:7265-7268` does `REP #$10` (XY ->
16-bit) then `LDY.B _E`, loading the `_E`/`_F` direct-page scratch pair
(`rammap.asm:23-24`, consecutive bytes at `$7E000E`/`$7E000F`) as a single
16-bit value: `_E` is the translevel-derived level byte, `_F` is the
overworld-submap flag set from `OWPlayerSubmap` (`bank_05.asm:7221-7226`).
Together they hold the full 0-511 level id, sublevel range included, and
that same `Y` indexes `DATA_05F000,Y`/`DATA_05F200,Y` two lines later.

What gates whether that row is actually used is a session RAM flag,
`UseSecondaryExit`, at `$7E1B93` (WRAM `$001B93` per the compiled symbol
table `SMW_U.sym:12265`, matching an independent `skip`-directive count
through `rammap.asm:1976-1993`). `bank_05.asm:7300-7301` (`LDA.W
UseSecondaryExit` / `BNE +`) skips the whole `DATA_05F000`/`DATA_05F200`
block (`bank_05.asm:7302-7337`) when it is nonzero. Its only writer in the
disassembly is `bank_0D.asm:1438`, inside the screen-exit object parser
`CODE_0DA512` (`bank_0D.asm:1416-1439`). It sits inside `$0000-$1FFF`,
which `ClearMemory` (`bank_00.asm:1241`) wipes; `ClearMemory` runs from
`GM03LoadTitleScreen` (`bank_00.asm:2613-2615`), the same routine an
`OverworldOverride` force-load reuses before falling into `GM11LoadLevel`
(`bank_00.asm:2621-2632`), per `tools/mesen/headless_capture.lua`'s TRACED
MECHANISM comment. So on a fresh boot or an `OverworldOverride` force-load,
`UseSecondaryExit` is zero and the game reads a sublevel's own
`DATA_05F000`/`DATA_05F200` row exactly like a `$0xx` level. It only
becomes nonzero once the screen-exit object parser has run this session (a
pipe/door transition); nothing clears it back to zero except the next
`ClearMemory`.

Once set, the game instead decodes position from whichever secondary
entrance targets the level. `findSecondaryEntranceForLevel`
(`src/rom/L3Loader.ts:134-142`, tracing `bank_05.asm:7117-7136`) scans
`DATA_05F800`/`DATA_05FC00` for an entrance whose target equals the level,
then decodes position from the entrance's row in:

| Table | SNES base | Role |
|---|---|---|
| `DATA_05F800` | `$05F800` | target level, low byte |
| `DATA_05FC00` | `$05FC00` | bit 0 = target level high byte; bits 5-7 = X-table index |
| `DATA_05FA00` | `$05FA00` | bits 0-3 = Y-table index; bits 4-5 = Layer1Y(camera) index; bits 6-7 = Layer2Y index |
| `DATA_05FE00` | `$05FE00` | bits 0-2 = `LevelEntranceType` |

(`bank_05.asm:7080-7162`.) A sublevel can be targeted by more than one
entrance in principle; the read path (and this doc) uses the first match by
scan order, same as the existing `readMarioStartPos`.

## 2. Encoding

**Verified - Map16-grid-granular, not free-pixel.** Every value in the four
shared lookup tables (`D730`, `D740`, `D750`, `D758`) is a multiple of 16 px
(confirmed by reading the table contents, `bank_05.asm:7044-7053`, see
below), so the *representable* positions are always on a 16 px grid. But the
per-level byte does not encode "grid column N" directly - it encodes a
**3-bit index into an 8-entry shared table** for X and a **4-bit index into a
16-entry shared table** for Y. The shared table, not the per-level byte,
fixes which 16-px-aligned offsets exist at all.

X low byte table (`D750`, 8 entries, indexed by `DATA_05F200 & 7`):
`$10, $80, $00, $E0, $10, $70, $00, $E0` → only 5 distinct pixel values exist:
`0, 16, 112, 128, 224`. X high byte: for **vertical** levels, `D758[idx]` is
just `0` or `1` (so X ∈ {that value, that value + 256}); for **horizontal**
levels the high byte is instead `DATA_05F600[levelId] & 0x1F` - a 5-bit
**screen number, 0-31** (`bank_05.asm:7292-7299` sets `ScreenMode` from the
same byte, and `bank_05.asm:7376-7384` writes `PlayerXPosNext+1` from it when
`ScreenMode`'s vertical bit is clear). Final X = `(screenOrHighByte << 8) |
xLow`.

Y low/high byte tables (`D730`/`D740`, 16 entries, indexed by
`DATA_05F000 & 0xF`): low bytes `$00,$30,$60,$80,$A0,$B0,$C0,$E0,$10,$30,$50,
$60,$70,$90,$00,$00`; high bytes are `$00` for indices 0-7 and `$01` for
indices 8-15. Combined, the 16 indices give these absolute Y pixel values (2
are duplicates): `0, 48, 96, 128, 160, 176, 192, 224, 272, 304, 336, 352,
368, 400, 256, 256`. For **vertical** levels there is an additional Y-screen
component: `PlayerYPosNext+1` is set from `DATA_05F600[levelId] & 0x1F`
(0-31) at `bank_05.asm:7386-7395`, overwriting the table-Y-high value from a
provisional read at `bank_05.asm:7341-7348` that only survives for its
`LastScreenVert` side effect. For **horizontal** levels there is no
Y-screen component - the 15 values above are the entire representable Y
range.

## 3. Valid range

**Verified, and this materially affects "move Mario's start position."** The
representable positions are **not** a free 16-px grid over the level. They
are:

- **X**: one of 5 fixed in-screen pixel offsets (`0, 16, 112, 128, 224`,
chosen by a 3-bit index shared by all 512 levels) plus, for horizontal
levels, a per-level screen number 0-31 (each screen is 256 px = 16 Map16
columns wide). For vertical levels X is pinned to one of just two absolute
pixel values (whichever `D758[idx]` gives - 0 or 256).
- **Y**: one of 15 distinct absolute pixel values (`0` through `400`, listed
above) for horizontal levels; for vertical levels, a per-level screen
number 0-31 (each screen is 256 px = 16 Map16 rows tall) plus the same
15-value low-byte set.

Consequently "move Mario one Map16 cell" is only achievable when the target
offset happens to already exist in the 5-value (X) or 15-value (Y) shared
set at the current screen. Moving to an *arbitrary* 16-px cell requires
either widening the shared table (a ROM-wide change affecting every level
that references that index) or repurposing an unused index - see §6 for a
concrete case. Out-of-range levels (`levelId` outside `$000-$1FF`) and index
values are moot: the index fields are only 3 or 4 bits wide, so every
possible byte value already lands in-table; there is no out-of-range case to
special-case on write, only the "which of the fixed offsets is nearest"
problem above.

## 4. What else shares those bytes

**Verified - every position byte is multiplexed with unrelated fields.** A
write must preserve:

- `DATA_05F000`: bits 4-7 select the level's Layer-2 horizontal/vertical
parallax speed (`HorizLayer2Setting`/`VertLayer2Setting`, via `D720`/`D710`,
`bank_05.asm:7268-7277`). Changing only bits 0-3 for a Y move is safe;
touching the byte wholesale is not.
- `DATA_05F200`: bits 3-5 are `LevelEntranceType` (affects how Mario visually
appears - e.g. door vs. pipe vs. walk-in - and interacts with sprite `FaceMario`
facing per `bank_05\MEMO.md`); bits 6-7 are `Layer3Setting` (which Layer-3
tilemap/tide behavior this level uses, `src/rom/ObjectExpander.ts:31-45`).
Only bits 0-2 are the X index.
- `DATA_05F400`: bits 0-3 are Layer1/Layer2 camera-Y init indices (shared,
distinct concern, already ported in `src/rom/L3Loader.ts:227-264`); bits
4-7 are `DisableMidway`, applied only on first overworld entry
(`bank_05.asm:7351-7356`) - **and**, only for castle-type levels on their
very first visit, the SAME nibble is separately reused as the X **screen
number** override (see §5). Editing this byte for a position write is
higher-risk than `DATA_05F000`/`DATA_05F200` because of that reuse.
- `DATA_05F600`: bit 7 is `DisableNoYoshiIntro`; bits 5-6 are `ScreenMode`
(level orientation bits, also consumed by `src/rom/LevelParser.ts` via a
*different* table - see caveat in §5); bits 0-4 are the screen number. A
write that changes the screen number must preserve bits 5-7 exactly.

## 5. Does writing it require anything else to change

**Verified: yes, in three distinct ways, plus one item left unverified.**

1. **Sublevels have their own primary-entry table row; which row governs
depends on session state, not level range.** `DATA_05F000`/`DATA_05F200`
are indexed by the full 16-bit level id (§1), so every sublevel has a row
like a `$0xx` level, gated by `UseSecondaryExit` (`$7E1B93`,
`bank_05.asm:7300-7301`): zero on fresh boot or an `OverworldOverride`
force-load, the game reads the sublevel's own row; once set by an
in-session pipe/door transition (`bank_0D.asm:1438`), it reads the
`DATA_05FA00`/`DATA_05FC00` row for the targeting entrance instead. A
write-back tool for a sublevel's start position has two candidate targets
depending on which state it edits for, and if two entrances target the
same sublevel, editing one leaves the other's row untouched either way.
(`bank_05.asm:7080-7162, 7265-7337`.) `readMarioStartPos`
(`src/rom/L3Loader.ts:296-322`) does not model `UseSecondaryExit` - it
branches on `levelId >= 0x100` and prefers a secondary entrance when one
targets the level, approximating "how a player normally reaches this
sublevel" rather than the ROM's actual runtime check.

2. **A hardcoded "MARIO START!" intro overrides the table on specific
first-time entries.** `CODE_05DA38` (`bank_05.asm:7416-7448`) sets
`PlayerXPosNext = $0030` and `PlayerYPosNext = $0100 | DATA_05D790[X]`
(X chosen 0-5 by matching the level header's tileset nibble against
`DATA_05D760`, or forced when `TranslevelNo ≥ $52`), completely bypassing
`DATA_05F000`/`DATA_05F200` for that entry. This fires only when
**all** of `SublevelCount == 0`, `ShowMarioStart == 0`,
`DisableNoYoshiIntro == 0`, and `SkipMidwayCastleIntro == 0` are true
(`bank_05.asm:7417-7437`) - i.e. the very first time a fresh save enters
that castle/tileset-flagged level from the overworld. Editing the table
position alone will not move Mario's spawn on that one visit; the fixed
`$0030`/`DATA_05D790` values would need to change instead, and
`DATA_05D790` is shared across all matching levels.

**Correction to `bank_05\MEMO.md`:** the MEMO's own note on this routine
says the hardcode applies "when `SublevelCount = 0 && ShowMarioStart !=
0`". Direct reading of `bank_05.asm:7417-7420` shows the opposite - both
`BNE` instructions branch *away from* the hardcode block when their
operand is nonzero, so reaching the hardcode requires `ShowMarioStart ==
0`, not `!= 0`. This is consistent with `GM10FadeToLevel`
(`bank_00.asm:2601-2609`), which shows the "MARIO START!" banner under the
identical all-zero condition. Flagging this for correction in the MEMO;
not fixed here since this task may not modify files outside `spikes/libretro-view-engine/`.

3. **A distinct, narrower override for first-time castle entries.** Inside
the `SublevelCount == 0` branch, if the overworld tile's
`OWLevelTileSettings` bit 6 is set (castle-type), the game sets
`SkipMidwayCastleIntro = 1` and takes `PlayerXPosNext+1` (X screen number)
from `DATA_05F400[levelId] >> 4` instead of `DATA_05F600[levelId] & 0x1F`
(`bank_05.asm:7361-7373`), skipping the normal F600-derived assignment
entirely. A write-back tool that only ever touches `DATA_05F600` would
silently fail to move X for this subset of levels on their first visit.

4. **Unverified: midway-checkpoint respawn.** The Map16 midway-gate tile
handler (`bank_00.asm:13041-13057`, tile `$38`) calls `CODE_00CA2B`
(`bank_00.asm:8575-8577`), which sets `MidwayFlag = 1`, but neither
`bank_00.asm` nor `bank_05.asm` contains a *read* of `MidwayFlag` for
position purposes (grep found only writes). I could not establish,
within this task's scope, whether death/respawn after touching a midway
gate re-derives its position from a ROM table at all, or whether it's a
RAM-only remembered position with no ROM byte to edit. This needs tracing
the death/`GameOver` game-mode handlers in `bank_00.asm`, which I did not
do. Labeled unverified - do not assume the primary-entrance tables above
govern respawn-after-death.

**Bottom line for the question asked:** whenever `UseSecondaryExit` is zero
(fresh boot, `OverworldOverride` force-load, or any entry that hasn't yet
gone through an in-session pipe/door transition - point 1) and not one of
the very-first-visit special cases in points 2-3, `DATA_05F000`/
`DATA_05F200` (plus the shared index tables) is what actually governs
Mario's spawn for *any* level id, sublevel included, and no "ShowMarioStart
flag" needs to be touched to make a write take effect on subsequent visits
- it only needs to be considered because it can make the *first* visit
ignore your edit. Once `UseSecondaryExit` is set, the secondary-entrance
table governs instead.

## 6. Worked example - level `$105`

**Verified against the vanilla ROM.** Level `$105`'s header
(`Layer1Ptrs[$105]` → SNES `$0688DD`, file offset `0x0308DD`) has byte 1 =
`$40`, giving `levelMode = 0x00`, which is horizontal
(`LEVEL_MODE_VERTICAL_TABLE[0] = 0x00`, `src/rom/LevelParser.ts:28-38`).

| Table | SNES addr | File offset | Current byte |
|---|---|---|---|
| `DATA_05F000[$105]` | `$05F105` | `0x02F105` | `$5B` |
| `DATA_05F200[$105]` | `$05F305` | `0x02F305` | `$00` |
| `DATA_05F600[$105]` | `$05F705` | `0x02F705` | `$00` |

Decode: `yIdx = $5B & 0xF = $B (11)` → `D730[11] = $60`, `D740[11] = $01` →
**Y = `$0160` = 352 px**. `xIdx = $00 & 7 = 0` → `D750[0] = $10`; horizontal
level, so X-high = `DATA_05F600[$105] & 0x1F = $00` → **X = `$0010` = 16
px**. (Note: for this specific level the vestigial `D758[0] = $00` the
current `readMarioStartPos` always reads happens to equal the ASM-correct
`F600`-derived screen number, so the read function's known limitation,
below, doesn't manifest here - see caveat.)

**Move one grid cell down (Y +16 px, target 368 px):** achievable. `368 =
0x170` is exactly `D730[12]/D740[12] = $70/$01`. Write `DATA_05F000[$105]`
(file offset `0x02F105`) from `$5B` to **`$5C`** - low nibble `B→C`
(11→12), high nibble (`$5`, the Layer2-scroll-setting index) unchanged.

**Move one grid cell right (X +16 px, target 32 px):** **not achievable**
by editing `$105`'s own bytes. The shared X-low table only contains
`{0, 16, 112, 128, 224}` - there is no index whose value is 32. The nearest
representable rightward step is index 5 (`D750[5] = $70 = 112`), six cells
over, not one. Reaching exactly one cell right would require either
widening the shared 8-entry `D750`/`D758` tables (affecting every level that
uses the newly-repurposed index) or accepting the 96-px jump. This is a real
limitation of the ROM's encoding, not a gap in this analysis.

**Read-path bug, independently confirmed (verified, in scope of "where does
X live"):** `readMarioStartPos` (`src/rom/L3Loader.ts:296-322`) always
computes X-high from `DATA_05D758_ADDR + xIdx` (the 0/1 vertical table) for
both orientations - no orientation branch exists. Per the ASM, horizontal
levels should instead take X-high from `DATA_05F600[levelId] & 0x1F`
(`bank_05.asm:7292-7299, 7375-7384`) - a 0-31 screen number, not 0/1; the
`D758`-derived write at `bank_05.asm:7316` is only provisional for a
horizontal level and gets overwritten by the `F600`-derived value at
`bank_05.asm:7382-7383`.

This is a genuine bug, not an intentional simplification: no doc under
`docs/` or `src/rom/model/CLAUDE.md` records a deliberate deviation, and
the introducing commit (`100bdda`, "Dry Bones $30/$32 layout +
Mario-start-based flip") cites only `bank_05.asm:7302-7316` in its
derivation comment - it never reads as far as the orientation branch at
`7375-7396` that overwrites the value for horizontal levels.
`SMWDisX/bank_05/MEMO.md`'s own reference `mario_spawn_x` pseudocode
(lines 93-100) already branches on `is_vertical` correctly, so the right
algorithm was already documented and simply wasn't ported.

I re-scanned all 512 levels' `DATA_05F600` bytes against the vanilla ROM,
this time also classifying orientation from each level's Layer 1 header
(`isLevelModeVertical`, `src/rom/LevelParser.ts:28-39`): 32 of 512 levels
have a nonzero screen-number field, confirming the earlier draft's count.
Of those 32, **26 are horizontal** (`readMarioStartPos` reads the wrong
X-high byte for all 26, e.g. `$012`, `$0C1`, `$0D0`, `$1FB`) and 6 are
vertical, where `D758` is the ASM-correct source and the existing code is
already right. A write-back implementation should not copy
`readMarioStartPos`'s X-high formula as-is; it should branch on
orientation the way the ASM (and the MEMO's pseudocode) does.

## Write mechanism

No write-back code exists yet anywhere in `src/` - `RomFile.writeAt(snesAddr,
data)` (`src/rom/RomFile.ts:143-154`) is a generic byte-range writer already
present and has zero callers today (confirmed by grep). It is orientation-
and field-agnostic: whatever writes Mario's start position would need to
compute the target byte (preserving the unrelated bits per §4), pick the
nearest representable table index per §2-3, and account for the level-range
and entry-type branches in §5 before calling it.
