# Enterable pipes and doors, and which screen exit they use

Evidence scope: vanilla SMW (US), static reading of SMWDisX, each citation re-read
with `get_lines` on 2026-10-16. Nothing here was run in an emulator. Hacked ROMs that
patch the player code or the screen exit loader are not covered.

## The screen exit rule

1. A screen exit files itself under ITS OWN 5-bit field, object byte 0 & $1F,
   not under the screen the object stream is on: `CODE_0DA512`, bank_0D.asm:1428-1432.
   The routine masks the object's first byte to its low 5 bits and uses that as the
   index into `ExitTableLow`, storing the object number there.
2. Two screen exits with the same field: the later store overwrites the earlier, so the
   LAST in the stream wins (same lines).
3. When Mario enters, the high byte of his X position (Y when the map is vertical)
   indexes `ExitTableLow`: bank_05.asm:7095-7101. So every enterable pipe or door on
   screen N leads to screen N's screen exit, whichever stream screen the screen exit sat on.

Vanilla `$00B`: both screen exits sit in the stream on screen 7, with own screen fields
3 (to `$0E1`) and 7 (to `$0E0`). Screen 3 holds a side pipe, screen 7 a down pipe. `$022`
and `$0D0` have own screen fields 6, 15 and 16, the screens of their pipes.

`LevelParser` exposes the field as `LevelObject.screenExitScreen` (#956); `LevelObject.screen`
is the stream counter. Before #956 the #946 spike (draft PR #947) read `raw[streamOffset] & 0x1F`
itself; use `screenExitScreen` instead.

## Which tiles are enterable

| What                 | Tiles (Map16)                                                                                                                                                  | Rule                                                        | Citation                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| Pipe cap, up or down | `$137`, `$138`                                                                                                                                                 | low byte $37 or $38 (subtract $37, accept a result under 2) | bank_00.asm:13205-13216 (`CODE_00F3E9`)                   |
| Down entry           |                                                                                                                                                                | called with A=3, button table index 3 = down ($04)          | bank_00.asm:12308-12312; table `DATA_00F3E5`, 13202-13203 |
| Up entry             |                                                                                                                                                                | called with A=2, index 2 = up ($08)                         | `CODE_00ECFA`, bank_00.asm:12258-12260                    |
| Side pipe            | `$13F`                                                                                                                                                         | low byte $3F                                                | `CODE_00F3C4`, bank_00.asm:13177-13182                    |
| Door                 | `$20` always                                                                                                                                                   | low byte $20                                                | `CODE_00EBDD`, bank_00.asm:12107-12108                    |
| Door, top half       | `$1F`, small Mario only                                                                                                                                        | a nonzero `Powerup` skips it, so big Mario cannot use it    | bank_00.asm:12109-12110, 12117-12119                      |
| Door                 | `$27`, `$28` only while the blue P-switch timer runs; `$27`, like `$1F`, also needs small Mario (it falls into `CODE_00EBFD`'s `Powerup` test); `$28` does not |                                                             | bank_00.asm:12111-12119                                   |
| Door                 | `$9C` only when `ObjectTileset` is 1                                                                                                                           |                                                             | bank_00.asm:12101-12105                                   |
| Decorative pipe      | `$133`-`$136`, `$139`-`$13E`                                                                                                                                   | in no list                                                  |                                                           |

A `$137`+`$138` pair is one pipe (the check accepts either half, with a horizontal
window of a few pixels, bank_00.asm:13213-13216). A `$1F` over a `$20` is one door.
Doors also need the player on the ground and Up pressed (bank_00.asm:12124-12128).
The #946 spike took the up or down direction from the `$135` body beside the cap
(bank_0D.asm:2118-2186), as in round 1.

## The page question: answered

The checks compare the low byte only (`Map16TileNumber`, bank_00.asm:13346-13352), but
they are reached on different paths by page:

- `CODE_00F4CD` stores the low byte, reads the HIGH byte into A and calls
  `CODE_00F545` (bank_00.asm:13346-13351). `CODE_00F545` begins by branching on the page
  (13410-13412): a nonzero page keeps A nonzero on return (or takes the P-switch
  rewrite at 13442-13459); page 0 returns A=0, either at `Return00F594` (13460) when no
  tile matches, or via 13459 (a zero load, reached from `CODE_00F592` or the P-switch rewrite). The caller's compare against zero (13353) therefore sets Z for page 0 and
  clears it for page 1.
- Z set (page 0): `CODE_00EB77` branches to `CODE_00EBDD`, the DOOR check
  (bank_00.asm:12073-12074). The pipe code is skipped for page 0: a branch to
  `CODE_00EC35` (12141) and a jump to `CODE_00EDDB` (12305-12306).
- Z clear (page 1): the side pipe `CODE_00F3C4` is reached only with low byte in
  $11-$6D (12142-12145, 12161-12164, 12169) and the up/down pipe checks when the
  low byte is below $6E (12216-12219, 12308-12310; values $11 and up on the first path), i.e. the solid range `$111-$16D`.

So pipes count only on page 1 (`$137`, `$138`, `$13F`; `$037`, `$038`, `$03F` do not) and
doors only on page 0 (`$1F`, `$20`, `$27`, `$28`, `$9C`; `$120` and friends do not).
The #946 spike scanned exactly those tiles. This is a static reading of the branch structure;
it was not confirmed by running the player code.

## What this reading does not cover

- Whether `$27`/`$28` or `$9C` tiles in a given map are reachable (the P-switch timer,
  the tileset) at play time; they are used as line starts but flagged in a note.
- Layer 2 screen exits, sprite-based entrances, hacked ROMs.
