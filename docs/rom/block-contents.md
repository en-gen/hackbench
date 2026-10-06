# Block contents (acts-like $111-$12D)

What an item block gives when hit, resolved by `src/rom/BlockContents.ts`
(`resolveBlockContents`). Issue #566. Evidence: a re-read of SMWDisX
(US ROM labels, SMW_U.sym) in 2026-10; nothing here has been confirmed in an
emulator unless stated.

## Mechanism

1. A head bump on a page-1 tile reaches `CODE_00F17F` (`bank_00.asm:12846`)
   with index = acts-like low byte - $11, valid 0-$1C (`bank_00.asm:12789-12793`).
2. The selector byte `DATA_00F080[index]` (`bank_00.asm:12751`) is decoded at
   `CODE_00F1BA` (`bank_00.asm:12877-12891`):
   - bit 7 set, `$FF`: green star block (`bank_00.asm:12861-12866`).
   - bit 7 set, `$80`/`$81`: look up `DATA_00F100` (`bank_00.asm:12778`) at
     `(byte & 1) * 16 + (TouchBlockXPos >> 4)`, i.e. map X column mod 16
     (`bank_00.asm:12868-12876`), then decode that value the same way.
   - otherwise content id = byte >> 1, progressive flag = byte & 1.
3. Progressive flag (`bank_00.asm:12878-12891`): content 3 (star) gives a star
   only while `InvinsibilityTimer` is nonzero, else a coin. Any other content
   gives the item when `Powerup` is nonzero (big, cape and fire all count), else
   a Mushroom.
4. Content id to sprite: `SpriteInBlock` (`bank_02.asm:1077`). The second
   17-byte copy, used when `YoshiIsLoose`, is byte-identical, so Yoshi state
   never changes the content. Ids 6 and 7 are coin art with no sprite
   (`bank_02.asm:1055-1070`); id 7 sets `MulticoinTimer` to $FF if it is zero
   (`bank_02.asm:1062-1067`). Spawn status comes from `StatusOfSprInBlk`
   (`bank_02.asm:1086`).

## Resolved table

"col" is the map X column (block X / 16), taken mod 16 where the ROM uses pixel
bits 7-4.

| Tile                                    | Selector | Contents                                                            | Varies by                    | Sprite                         |
| --------------------------------------- | -------- | ------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| $111                                    | $80      | col%3 = 0 Fire Flower, 1 Feather (both progressive), 2 Star         | X column, Powerup            | $74 small, else $75 / $77; $76 |
| $112 $113 $115 $116 $11E $129 $12B $12C | $00      | none                                                                | -                            | -                              |
| $114                                    | $1E      | Directional coins                                                   | -                            | $45                            |
| $117                                    | $05      | progressive Fire Flower (a flower block, not a turn block)          | Powerup                      | $74 / $75                      |
| $118                                    | $09      | progressive Feather                                                 | Powerup                      | $74 / $77                      |
| $119                                    | $06      | Star                                                                | -                            | $76                            |
| $11A                                    | $81      | col%3 = 0 star-or-coin, 1 1-up, 2 Vine                              | X column, InvinsibilityTimer | $76 or coin; $78; $79          |
| $11B $123                               | $0E      | multi-coin                                                          | MulticoinTimer               | coin art                       |
| $11C $124                               | $0C      | coin                                                                | -                            | coin art                       |
| $11D                                    | $14      | P-switch                                                            | colour by column parity      | $3E                            |
| $11F                                    | $05      | progressive Fire Flower                                             | Powerup                      | $74 / $75                      |
| $120 $12A                               | $09      | progressive Feather                                                 | Powerup                      | $74 / $77                      |
| $121                                    | $06      | Star                                                                | -                            | $76                            |
| $122                                    | $07      | star-or-coin                                                        | InvinsibilityTimer           | $76 or coin                    |
| $125                                    | $16      | col%4 = 0 Key, 1 Flying red coin, 2 Balloon, 3 Green bouncing Koopa | X column mod 4               | $80 / $7E / $7D / $09          |
| $126                                    | $18      | Yoshi egg                                                           | egg holds Yoshi or a 1-up    | $2C                            |
| $127 $128                               | $1A      | Green Koopa shell (status 9)                                        | -                            | $04                            |
| $12D                                    | $FF      | coin until 30 coins are collected, then 1-up                        | GreenStarBlockCoins          | coin art or $78                |

Citations per row: selector values `bank_00.asm:12751-12756`; `DATA_00F100`
values `bank_00.asm:12778-12781` ($111 half cycles $05, $09, $06; $11A half
cycles $07, $0A, $10, period 3, restarting each 16 columns); P-switch colour
`CODE_028A2A` / `DATA_028A42` (`bank_02.asm:1280-1295`); Yoshi egg contents
`bank_02.asm:1232-1251` with `DATA_0288A1` (`bank_02.asm:1074`: Yoshi $35, or
1-up $78 when a baby Yoshi sprite $2D exists or `YoshiIsLoose`); shell
`ADDR_028A08` (`bank_02.asm:1260`); green star block counter starts at 30
(`constants.asm:97`, set at `bank_00.asm:1980`) and counts down on coin pickups
(`bank_05.asm:3552-3567`).

### $125

`SpriteInBlock` gives $7D, then `bank_02.asm:1199-1212` rewrites sprite and
status from `DATA_0288D6` / `DATA_0288D9` indexed by `(SpriteXPosLow & $30) >> 4`.
Index 3 reads past both 3-byte tables: the sprite is `DATA_0288D9[0]` = $09 and
the status is the first code byte of `CODE_0288DC` (`bank_02.asm:1097`), $A4,
which `HandleSprite` (`bank_01.asm:181-195`) has no handler for. The resolver
reports sprite $09 with a caveat. The index uses `SpriteXPosLow`, which for a
layer 2 block is minus `Layer23XRelPos` (`bank_02.asm:1184-1198`), so on layer 2
the item depends on scroll position; the resolver gives the layer-1 answer.

## Not confirmed in an emulator

- `$11A` col%3 = 0 and `$122` give a star only while Mario is already invincible,
  otherwise a coin. That is the literal reading of `bank_00.asm:12887-12891`
  and looks backwards for game design; confirm before relying on the wording.
- The behaviour of $125 column 3 at runtime (status $A4).

## Out of scope

- Coin (id 6) blocks in `ObjectTileset` 4 do not give a plain coin: they run a
  bonus-room puzzle using `PBalloonInflating` as a bitmask of blocks hit
  (`bank_00.asm:12902-12906` and the code after `bank_00.asm:12914`). The
  resolver reports Coin.
- Tiles $159 and $15A reach selector indices $22 and $23 (feather, Mushroom)
  through a tileset-gated branch of `CODE_00F160` (`bank_00.asm:12835-12845`,
  after `DATA_00A625`), outside $111-$12D. The resolver returns null for them.

## Resolver output

`resolveBlockContents(actsLike, col, tables)` returns `alternatives:
[{when, content}]` (progressive blocks are the Mushroom case), `spriteIds` for
the table engine, `progressive: {small, big}`, `multiCoin`, a `condition` line
for the Properties "Contains" row, and an optional `caveat`. Tables come from
`readBlockContentTables(rom)`; tests pass synthetic bytes.
