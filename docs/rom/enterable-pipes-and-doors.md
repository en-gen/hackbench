# Enterable pipes and doors, and which screen exit they use

Evidence scope: vanilla SMW (US), static reading of SMWDisX, every citation re-read
with smw-mcp `get_lines` on 2026-10-17. Nothing here was run in an emulator. Hacked
ROMs that patch the player code or the screen exit loader are not covered. All
citations below are SMWDisX `bank_XX.asm:line`.

## The screen exit rule

1. A **screen exit** files itself under its OWN 5-bit field, object byte 0 & $1F,
   not under the stream screen it sits on. `CODE_0DA512` (bank_0D.asm:1428-1432) masks
   `_A` to 5 bits, uses that as the index into `ExitTableLow` and stores the
   destination there. `_A` is object byte 0 as read by `LoadLevelData`
   (bank_05.asm:679-681).
2. Two screen exits with the same field: the later store overwrites the earlier, so
   the LAST in the stream wins (bank_0D.asm:1428-1432 again).
3. When Mario enters, the high byte of his X position (Y when layer 1 is vertical)
   indexes `ExitTableLow` (bank_05.asm:7095-7100). So every enterable pipe or door on
   screen N leads to screen N's screen exit, whichever stream screen that exit sat on.

Worked example (level data, not code, so no SMWDisX line exists): the #946 spike reported
that vanilla `$00B` has both screen exits on stream screen 7 with own fields 3 (to `$0E1`)
and 7 (to `$0E0`), a side pipe on screen 3 and a down pipe on screen 7; `$022` and `$0D0`
have own fields 6, 15 and 16. These values were carried over from that spike's output and
were NOT re-derived for this doc; treat them as unverified until a test reads them with
`screenExitScreen`.

`LevelParser` exposes the field as `LevelObject.screenExitScreen` (#956, in
`src/rom/LevelParser.ts`); `LevelObject.screen` is the stream counter. The #946 spike
(draft PR #947) read `raw[streamOffset] & 0x1F` itself; use `screenExitScreen` instead.
Not covered: vertical layers swap the low nibbles of `_A` and `_B` before the object
runs (bank_05.asm:654-675, 711-713), which may change the low 5 bits; not read further.

## Which tiles are enterable

The checks compare the low byte of the Map16 tile only (bank_00.asm:13346-13347).

| What                 | Tiles (Map16)                | Rule                                                                                  | Citation                                                            |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Pipe cap, up or down | `$137`, `$138`               | low byte minus $37 under 2 (`CODE_00F3E9`)                                            | bank_00.asm:13205-13211                                             |
| Down entry           |                              | `CODE_00F3E9` called with A=3; table index 3 is down ($04), held button               | bank_00.asm:12310-12311; bank_00.asm:13203; bank_00.asm:13227-13228 |
| Up entry             |                              | called with A=2; index 2 is up ($08)                                                  | bank_00.asm:12259-12260; bank_00.asm:13203                          |
| Side pipe            | `$13F`                       | low byte $3F (`CODE_00F3C4`)                                                          | bank_00.asm:13178-13179                                             |
| Door                 | `$20`                        | always                                                                                | bank_00.asm:12107-12108                                             |
| Door, top half       | `$1F`                        | small Mario only: a nonzero `Powerup` skips it                                        | bank_00.asm:12109-12110, bank_00.asm:12117-12119                    |
| Door                 | `$27`, `$28`                 | only while the blue P-switch timer runs; `$27` also needs small Mario, `$28` does not | bank_00.asm:12111-12119                                             |
| Door                 | `$9C`                        | only when `ObjectTileset` is 1                                                        | bank_00.asm:12101-12105                                             |
| Decorative pipe      | `$133`-`$136`, `$139`-`$13E` | in no list                                                                            |                                                                     |

A `$137`+`$138` pair is one pipe: either half is accepted, within a horizontal window
of a few pixels (bank_00.asm:13212-13216). A `$1F` over a `$20` is one door. Doors also
need the player on the ground and Up pressed (bank_00.asm:12124-12128).

## The page question: answered

The tile fetch (`CODE_00F4CD`, reached from `CODE_00F44D`) stores the low byte, reads
the HIGH byte of the tile, calls `CODE_00F545` and compares A with zero (bank_00.asm:13346-13353). `CODE_00F545`
branches on the page at its start (bank_00.asm:13411-13412), so the caller sees:

- Page 0: Z is normally set (A=0 via bank_00.asm:13459-13460). Exceptions: the P-switch
  rewrites of `$29`, `$2B` and the switch-palace tiles return a nonzero A
  (bank_00.asm:13418-13420, 13438-13440), but the rewritten low byte is `$24` or `$32`,
  neither of which is a pipe or door tile.
- Page 1: A stays nonzero, except `$132` with the blue timer running, which is rewritten
  to `$12B` and returns A=0 (bank_00.asm:13442-13459); `$12B` is not a door tile.

Z set sends the player code to the DOOR check (bank_00.asm:12073-12074); the pipe code
is skipped for page 0 (bank_00.asm:12141, 12195-12196, 12305-12306).

For page 1 the pipe paths have different low-byte bounds:

| Path                                                       | Low byte reached | Page 1 tiles | Citation                                                            |
| ---------------------------------------------------------- | ---------------- | ------------ | ------------------------------------------------------------------- |
| Side pipe (`CODE_00F3C4`)                                  | $11-$6D          | `$111-$16D`  | bank_00.asm:12142-12145, bank_00.asm:12161-12164, bank_00.asm:12169 |
| Up entry (`CODE_00ECFA`)                                   | $11-$6D          | `$111-$16D`  | bank_00.asm:12216-12219, bank_00.asm:12259-12260                    |
| Down entry, second path (`CODE_00ED4A`, bank_00.asm:12303) | $00-$6D          | `$100-$16D`  | bank_00.asm:12308-12311 (upper bound only, no lower bound)          |

So the `$11` lower bound holds for the side pipe and the up entry only; tiles
`$100-$110` reach the down-entry check (bank_00.asm:12308-12311), though none of them is
a pipe cap, so this changes no result for vanilla tile numbers. The solid range
`$111-$16D` is therefore the side-pipe and up-entry range, and `$100-$16D` the
down-entry range.

Consequence: pipes count only on page 1 (`$137`, `$138`, `$13F`; `$037`, `$038`, `$03F`
do not) and doors only on page 0 (`$1F`, `$20`, `$27`, `$28`, `$9C`; `$120` and friends
do not). The #946 spike scanned exactly those tiles. Static reading of the branch
structure; not confirmed by running the player code.

## What this reading does not cover

- Whether `$27`/`$28` or `$9C` tiles in a given map are reachable at play time (the
  P-switch timer, the tileset).
- Layer 2 screen exits, sprite-based entrances, hacked ROMs.
