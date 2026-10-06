# Block contents (acts-like $111-$12D)

What an item block gives when hit, resolved by `src/rom/BlockContents.ts`
(`resolveBlockContents`). Issue #566. Evidence: a re-read of SMWDisX
(US ROM labels, SMW_U.sym) in 2026-10; nothing here has been confirmed in an
emulator unless stated.

## Mechanism

1. A head bump on a page-1 tile reaches `CODE_00F17F` (`bank_00.asm:12846`)
   with index = acts-like low byte - $11, valid 0-$1C (`bank_00.asm:12827-12831`).
2. The selector byte `DATA_00F080[index]` (`bank_00.asm:12751`) is decoded at
   `CODE_00F1BA` (`bank_00.asm:12877-12891`):
   - bit 7 set and every other bit set: green star block (`bank_00.asm:12861-12866`).
   - any other byte with bit 7 set: look up `DATA_00F100` (`bank_00.asm:12778`)
     at `(byte & 1) * 16 + (TouchBlockXPos >> 4)`, i.e. map X column mod 16
     (`bank_00.asm:12868-12876`), then decode that value the same way.
   - otherwise content id = byte >> 1, progressive flag = byte & 1.
3. Progressive flag (`bank_00.asm:12878-12891`): content 3 (star) gives a star
   only while `InvinsibilityTimer` is nonzero, else a coin. Any other content
   gives the item when `Powerup` is nonzero (big, cape and fire all count), else
   a Mushroom.
4. Content id to sprite: `SpriteInBlock` (`bank_02.asm:1077`). The second
   17-byte copy, used when `YoshiIsLoose`, is byte-identical, so Yoshi state
   never changes which sprite SpriteInBlock picks (the egg's own hatch contents
   are the exception, see the $126 row). Ids 6 and 7 are coin art with no sprite
   (`bank_02.asm:1055-1070`); id 7 sets `MulticoinTimer` to its start value if it is zero
   (`bank_02.asm:1062-1067`). Spawn status comes from `StatusOfSprInBlk`
   (`bank_02.asm:1086`).

## Resolved table

"col" is the map X column (block X / 16), taken mod 16 where the ROM uses pixel
bits 7-4.

| Tile                                    | Contents                                                            | Varies by                                                                  | Sprite                         |
| --------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| $111                                    | col%3 = 0 Fire Flower, 1 Feather (both progressive), 2 Star         | X column, Powerup                                                          | $74 small, else $75 / $77; $76 |
| $112 $113 $115 $116 $11E $129 $12B $12C | none                                                                | -                                                                          | -                              |
| $114                                    | Directional coins                                                   | -                                                                          | $45                            |
| $117                                    | progressive Fire Flower (a flower block, not a turn block)          | Powerup                                                                    | $74 / $75                      |
| $118                                    | progressive Feather                                                 | Powerup                                                                    | $74 / $77                      |
| $119                                    | Star                                                                | -                                                                          | $76                            |
| $11A                                    | col%3 = 0 star-or-coin, 1 1-up, 2 Vine                              | X column, InvinsibilityTimer                                               | $76 or coin; $78; $79          |
| $11B $123                               | multi-coin                                                          | MulticoinTimer                                                             | coin art                       |
| $11C $124                               | coin                                                                | -                                                                          | coin art                       |
| $11D                                    | P-switch                                                            | colour by column parity (even blue, odd silver; layer 2 depends on scroll) | $3E                            |
| $11F                                    | progressive Fire Flower                                             | Powerup                                                                    | $74 / $75                      |
| $120 $12A                               | progressive Feather                                                 | Powerup                                                                    | $74 / $77                      |
| $121                                    | Star                                                                | -                                                                          | $76                            |
| $122                                    | star-or-coin                                                        | InvinsibilityTimer                                                         | $76 or coin                    |
| $125                                    | col%4 = 0 Key, 1 Flying red coin, 2 Balloon, 3 Green bouncing Koopa | X column mod 4                                                             | $80 / $7E / $7D / $09          |
| $126                                    | Yoshi egg                                                           | egg holds Yoshi or a 1-up                                                  | $2C                            |
| $127 $128                               | Green Koopa shell (status 9)                                        | -                                                                          | $04                            |
| $12D                                    | coin until 30 coins are collected, then 1-up                        | GreenStarBlockCoins                                                        | coin art or $78                |

Citations per row: selector `DATA_00F080` `bank_00.asm:12751-12756`;
`DATA_00F100` `bank_00.asm:12778-12781` (both halves repeat every 3 columns and
restart each 16); P-switch colour
`CODE_028A2A` / `DATA_028A42` (`bank_02.asm:1280-1295`); Yoshi egg contents
`bank_02.asm:1232-1251` with `DATA_0288A1` (`bank_02.asm:1074`: Yoshi $35, or
1-up $78 when a baby Yoshi sprite $2D exists or `YoshiIsLoose`); shell
`ADDR_028A08` (`bank_02.asm:1260`); green star block counter starts at 30
(`constants.asm:97`, set at `bank_00.asm:1979-1981`, the immediate at :1980; the resolver reads it from
the ROM; a start of 0 gives the 1-up at once, `bank_00.asm:12863-12866`)
and counts down on coin pickups (`bank_05.asm:3552-3567`).

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

## Hack tables

The resolver reads every table from the ROM and keys the special cases on the
spawned sprite, as the ROM does (balloon rewrite `bank_02.asm:1199`, P-switch
`bank_02.asm:1228`, Yoshi egg `bank_02.asm:1230`). A zero SpriteInBlock or
DATA_0288D6 entry gives "Nothing". Content ids of $11 and up read the bytes that
follow the table (`bank_02.asm:1077-1089`). When the second SpriteInBlock copy
(read while Yoshi is loose, `bank_02.asm:1143-1149`) differs from the first, the
resolver adds a "Yoshi is loose" alternative; vanilla's copies are identical.
The "X column n of p" text uses the period found in DATA_00F100 and is dropped
when the table has none.

## Display

Maps view, #566 PR B (`theia/extension/src/node/map-block-contents.ts`,
`common/block-indicator.ts`). Owner decisions: spikes #605 (D4), #607
(progressive split), #615 (C4a) and the rulings on #566 and #623.

- The item at 8 x zoom screen pixels in the block's bottom-right quadrant, full
  opacity, no outline; on hover it fills exactly the block (16 x zoom) and never
  leaves it. The 16 x 16 art is scaled nearest-neighbour, as the spikes' CSS did.
- Split indicators: the progressive blocks (mushroom bottom-left, item top-right)
  and, by the #623 ruling, the two-outcome blocks that include a coin ($11A
  column 0 of 3 and $122: coin bottom-left, star top-right; $12D: coin
  bottom-left, 1-up top-right). A hard diagonal from top-left to bottom-right
  with the owner's L1 line: black, one art pixel wide, scaling with zoom. It is
  drawn once per item, clipped to that item's half of the diagonal pixel, so a
  diagonal art pixel is black where either item is opaque and clear where neither is.
- Multi-coin ($11B, $123): the coin with a 5 x 5 white "+" (7 x 7 with a black
  edge) baked into the corner of its 16 x 16 art. $11C and $124: the plain coin.
- Each cell resolves for its own X column; the P-switch uses the spawn
  attribute of DATA_028A42.
- Drawn only for shown layers, so hiding a layer hides its indicators. No Contents toggle.
- Not drawn, with a plain-words note: a Yoshi-loose variant, a block whose item
  graphics are not loaded in the level, a sprite the interpreter refuses or that draws
  nothing in its first frames, a spawn or coin routine that is not the traced one.
- Item art is the sprite run on the 65816 core, as the map's sprite layer does
  (#585), seeded as the block spawn leaves it: `GenSpriteFromBlk`
  (`bank_02.asm:1122-1160`) writes the status from StatusOfSprInBlk and the sprite
  number, then calls `InitSpriteTables`; the sprite's INIT never runs, so its status
  handler draws it (a status-9 egg is the green stunned egg, a status-9 $04 a
  shell). The spawn then writes its own cells (`bank_02.asm:1199-1292`): the rise
  speed, `SpriteMisc154C` and the timers (read from the code's immediates, gated on
  its bytes), and the P-switch colour. Not modelled: the balloon's direction and
  `SpriteTableC2` bump (`:1218`, `:1256`), the egg's contents cell (`:1250`) and
  the tweaker turn timer (`:1274`). The runner takes this as `RunOptions.spawn`.
- The coin is not a sprite: its chars and palette are the immediates of the coin
  draw (`bank_02.asm:3432-3441`), read behind a byte-pattern gate.
- The Theia map view never used `StarOneUpVineBlockBehavior` or
  `KeyCoinBalloonKoopaBlockBehavior` overlays (the reference webview model's);
  they are untouched.
- Evidence scope: item art checked by pixel counts on the vanilla ROM, one
  machine (coin 132 opaque pixels, multi-coin 146, as spike #615 measured); a
  status-9 egg has green pixels and a status-9 $04 differs from status 8.

## Tests

CI has no ROM and the repo carries no vanilla table bytes: the unit tests run
the resolver on made-up tables, and the vanilla results above are asserted only
in the corpus-gated tests of `test/suite/unit/BlockContents.test.ts`.

A ROM that ends before a required table is refused: `readBlockContentTables` returns
`{ kind: 'unavailable', unavailable: reason }` and the resolver passes it through, instead of reading
zeros as "Nothing".

The table reads are not yet gated on the instructions that read them, so a hack that
moves a table is not detected (#632).
