# Block contents (acts-like $111-$12D, and $021-$024)

What an item block gives when hit, resolved by `src/rom/BlockContents.ts`
(`resolveBlockContents`). Issue #566. Evidence: a re-read of SMWDisX
(US ROM labels, SMW_U.sym) in 2026-10; nothing here has been confirmed in an
emulator unless stated.

## Mechanism

1. `CODE_00F17F` (`bank_00.asm:12846`) is entered with index = acts-like low
   byte - $11, valid 0-$1C (`bank_00.asm:12827-12831`), and a hit direction Y.
   A gate decides whether this hit opens the block:
   `DATA_00F0EC[Y] & DATA_00F0A4[index]`, zero meaning no (`bank_00.asm:12850-12853`).
   Y = 0 comes from every caller that hits a block from below, not only Mario's
   head bump: `CODE_00EFE8` (`bank_00.asm:12681`) and the sprite-hit callers
   (`bank_01.asm:3049`, `:3543`, `bank_02.asm:2863`) into `CODE_00F160`, `CODE_00ECFA`
   (`bank_00.asm:12262`) into `CODE_00F127`, and the direct entry for tiles $021-$024
   (`bank_00.asm:12211`). Y = 1 and 2 are side hits (mask $01, $02): `CODE_00EC7B`
   (`bank_00.asm:12188-12193`) calls `CODE_00F127` with Y = `DATA_00E90A[PlayerBlockXSide] & 3`
   (`bank_00.asm:11703-11704`). Y = 3 is from above (mask $04, `bank_00.asm:12461`,
   `:12479`). Only Y = 0-3 reach the gate, so mask bits 4-7 never matter. Mask $08
   therefore means "opened by the Y = 0 callers", not only Mario's head bump.
   Every index but these has mask $08 (head bump only): 0, 2 and 4 are $0C
   (head bump and from above), 5 (tile $116) is $0F (also from the sides),
   $19 and $1A (tiles $12A, $12B) are $03, and $21 is $04. A head bump never opens
   $12A or $12B, only a side hit does. The resolver reads this table (`DATA_00F0A4`,
   36 bytes, `bank_00.asm:12758-12763`) from the ROM. Mask bit 3 set gives no
   trigger text. Otherwise the condition says "(only when hit from the side)" (both
   side bits), "from one side" (one of them; which physical side each is was not
   established), "from above", or a combination such as "from one side or above". A
   mask with none of bits 0-3 opens nothing, and a closed gate also drops the
   counter caveat.
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

| Tile                                    | Contents                                                                          | Varies by                                                                  | Sprite                         |
| --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| $111                                    | col%3 = 0 Fire Flower, 1 Feather (both progressive), 2 Star                       | X column, Powerup                                                          | $74 small, else $75 / $77; $76 |
| $112 $113 $115 $116 $11E $129 $12B $12C | none                                                                              | -                                                                          | -                              |
| $114                                    | Directional coins, or a coin once a directional-coin run has started in the level | DirectCoinInit (`bank_02.asm:1162-1172`)                                   | $45                            |
| $117                                    | progressive Fire Flower (a flower block, not a turn block)                        | Powerup                                                                    | $74 / $75                      |
| $118                                    | progressive Feather                                                               | Powerup                                                                    | $74 / $77                      |
| $119                                    | Star                                                                              | -                                                                          | $76                            |
| $11A                                    | col%3 = 0 star-or-coin, 1 1-up, 2 Vine                                            | X column, InvinsibilityTimer                                               | $76 or coin; $78; $79          |
| $11B $123                               | multi-coin                                                                        | MulticoinTimer                                                             | coin art                       |
| $11C $124                               | coin                                                                              | -                                                                          | coin art                       |
| $11D                                    | P-switch                                                                          | colour by column parity (even blue, odd silver; layer 2 depends on scroll) | $3E                            |
| $11F                                    | progressive Fire Flower                                                           | Powerup                                                                    | $74 / $75                      |
| $120 $12A                               | progressive Feather ($12A: side hit only)                                         | Powerup                                                                    | $74 / $77                      |
| $121                                    | Star                                                                              | -                                                                          | $76                            |
| $122                                    | star-or-coin                                                                      | InvinsibilityTimer                                                         | $76 or coin                    |
| $125                                    | col%4 = 0 Key, 1 Flying red coin, 2 Balloon, 3 Green bouncing Koopa               | X column mod 4                                                             | $80 / $7E / $7D / $09          |
| $126                                    | Yoshi egg                                                                         | egg holds Yoshi or a 1-up                                                  | $2C                            |
| $127 $128                               | Green Koopa shell (status 9)                                                      | -                                                                          | $04                            |
| $021 $022                               | coin ($021), 1-up ($022), only when hit from below (see below)                    | head point, Mario moving up                                                | coin art or $78                |
| $023 $024                               | none                                                                              | -                                                                          | -                              |
| $12D                                    | coin until 30 coins are collected, then 1-up                                      | GreenStarBlockCoins                                                        | coin art or $78                |

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

### $021-$024

Page-0 tiles $021-$024 reach `CODE_00F17F` directly (`bank_00.asm:12194-12212`)
when `PlayerYSpeed+1` is negative (Mario moving up), page 0 only, with index = tile - 4:
$1D (coin), $1E (1-up), $1F and $20 (nothing). The call is the one whose
`CODE_00F44D` has just loaded Mario's head point: X advances two per call from
`CODE_00EB77`, and the Y offset at that call is the head's ($10 small, $08 big,
`bank_00.asm:11686-11699`). Hand-traced from the source, not confirmed in an
emulator. The resolver words it "(only when hit from below)". The spin-break entry (index
$21, `bank_00.asm:12471-12472`) gives nothing and is not a tile.

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
- Drawing: `theia/extension/src/node/map-block-contents.ts` still admits only
  $111-$12D (`inRange`), so the Maps view does not yet draw $021 and $022 although the
  resolver resolves them (tracked separately).

## Resolver output

`resolveBlockContents(actsLike, col, tables)` returns `alternatives:
[{when, content}]` (progressive blocks are the Mushroom case), `spriteIds` for
the table engine, `progressive: {small, big}`, `multiCoin`, a `condition` line
for the Properties "Contains" row, and an optional `caveat`. Tables come from
`readBlockContentTables(rom)`; tests pass synthetic bytes.

## Hack tables

The resolver reads every table from the ROM and keys the special cases on the
spawned sprite, as the ROM does (balloon rewrite `bank_02.asm:1199`, P-switch
`bank_02.asm:1228`, Yoshi egg `bank_02.asm:1230`). A SpriteInBlock or
DATA_0288D6 byte of 0 with a live status is what the ROM spawns: sprite $00, read as
"Sprite $00" (the spawn writes SpriteNumber from the table with no zero check,
`bank_02.asm:1150-1151`; a balloon rewrite does the same, `:1209-1212`). The empty
cases are content id 0, which returns before any spawn (`bank_02.asm:1053-1054`,
whatever SpriteInBlock[0] holds), and spawn status 0, which `HandleSprite` erases
(`bank_01.asm:182-183`; the spawn writes the table status as is, `bank_02.asm:1141-1142`,
and the balloon rewrite's own status replaces it, `:1209-1210`). A sprite
produced by the balloon rewrite skips the P-switch and egg handling
(`bank_02.asm:1215-1223`). The directional-coin check (`bank_02.asm:1162-1164`) runs
before the rewrite, while SpriteNumber is still the table's sprite, so a rewrite to
$45 never gets it. Content ids of $11 and up read the bytes that
follow the table (`bank_02.asm:1077-1089`). When the second SpriteInBlock copy
(read while Yoshi is loose, `bank_02.asm:1143-1151`) differs from the first, the
resolver shows both, as "Sprite $43 (Sprite $00 if Yoshi is loose)", lists both
sprites in `spriteIds`, and adds a "Yoshi is loose" alternative; vanilla's copies are identical.
The "X column n of p" text uses the period found in DATA_00F100 and is dropped
when the table has none.

## Display

Maps view, #566 PR B (`theia/extension/src/node/map-block-contents.ts`,
`common/block-indicator.ts`). Owner decisions: spikes #605 (D4), #607
(progressive split), #615 (C4a) and the rulings on #566 and #623.

- The item at 8 x zoom screen pixels in the block's bottom-right quadrant, full
  opacity, no outline; on hover it fills exactly the block (16 x zoom) and never
  leaves it. The 16 x 16 art is scaled nearest-neighbour, as the spikes' CSS did.
- Split indicators: the progressive blocks (mushroom, then flower or feather) and, by the #623 ruling,
  the two-outcome blocks that include a coin ($11A column 0 of 3 and $122: coin, then star; $12D: coin,
  then 1-up). The split runs along the anti-diagonal, bottom-left to top-right (x + y = 15 in the
  16 x 16 art; owner ruling 2026-10-06, so the mirrored feather is not cut along its length). The
  BASE item (the mushroom, or the coin) is the bottom-right half and the UPGRADE (flower, feather,
  star, 1-up) the top-left half, the same at rest and on hover. The line of the owner's L1 pick runs
  along it: black, one art pixel wide, scaling with zoom. It is drawn once per item, clipped to that
  item's own triangle of the line pixel, so a line art pixel is black in each item's triangle where
  that item is opaque (at 2x and 3x a pixel only one item paints shows a black triangle) and clear
  where neither is. The art pixel and the triangle are tested at the screen pixel's centre. The split
  elsewhere is hard: no blending.
- Multi-coin ($11B, $123): the coin with a 5 x 5 white "+" (7 x 7 with a black
  edge) baked into the bottom-right of its 16 x 16 art, its 7 x 7 origin at art pixel (8, 8), one pixel
  in from the corner (owner ruling 2026-10-06), so its centre row and column are art row and column
  11: odd, which centre sampling keeps at 1x (it samples art pixels 2i + 1), where the earlier origin
  (9, 9) put them on 12 and lost them. $11C and $124: the plain coin.
- Each cell resolves for its own X column; the P-switch uses the spawn
  attribute of DATA_028A42.
- Drawn IN the plane of the block's bottom-right subtile priority, at screen resolution
  (owner ruling 2026-10-06): the native composite is untouched; a display canvas over it shows the same
  picture at the zoom, with each indicator's block cell recomposed: its planes scaled by nearest sampling,
  its plane's indicators painted into the plane's copy, then stacked and put through color math as ever. A nearer plane or a sprite covers an
  indicator exactly as it covers its block, and hiding a graphics layer hides its indicators. No Contents toggle.
- Not drawn, with a plain-words note: a Yoshi-loose variant, a block whose item
  graphics are not loaded in this map, a sprite the interpreter refuses or that draws
  nothing in its first frames, a spawn or coin routine that is not the traced one.
- Item art is the sprite run on the 65816 core, as the map's sprite layer does (#585), set up
  by the game's OWN block spawn (owner ruling 2026-10-06, the second bounded exception in
  `.claude/rules/rom-interpretation.md`): the dispatcher `CODE_0288DC` (`bank_02.asm:1097-1119`) and
  `GenSpriteFromBlk` (`:1122-1292`) run on the core, their shapes byte-checked
  (`resolveBlockSpawn`), with the inputs they read seeded generically: the content index `_5` ($05),
  which comes from the resolver (`BlockContent.index`, so the balloon family keeps its own), TouchBlockXPos
  ($9A) and TouchBlockYPos ($98) from the block's position, LayerProcessing ($1933), YoshiIsLoose
  ($18E2) and DirectCoinInit ($1432) cleared, SpriteMemorySetting ($1692) as the level loader left it,
  and DB set to the code's bank. The dispatcher sends the egg, key, vine and balloon through
  `FindFreeSprSlot` and the rest to `GenSpriteFromBlk`'s own countdown; the run reads whichever slot the
  game filled. The code writes the status and number from StatusOfSprInBlk and SpriteInBlock, calls
  InitSpriteTables, places the sprite and writes its cells (rise speed, timers, the P-switch colour, the
  balloon's direction, C2, the egg's contents). The sprite's INIT never runs, so its status handler draws
  it: a status-9 egg is the green stunned egg, a status-9 $04 a shell. Nothing about the spawn is ported in
  `src/`; code that is not the shape checked, a spawn that fills no slot, or one that exceeds the step
  budget refuses with a plain reason and the block is not drawn. The runner takes this as
  `RunOptions.spawn`. Layer 2 blocks are spawned as layer 1 ones: the art does not depend on it.
- The core's first frame is what is drawn (owner ruling 2026-10-06): the mirrored feather and the
  star one pixel wider stay. Real-art line pixel counts on the anti-diagonal, pinned in the corpus
  test: $11F 14, $120 12, $11A column 0 11, $12D 12 (on the old main diagonal: 13, 15, 12, 12).
- Accepted (owner, 2026-10-06): the flying red coin of $125 column 1 ($7E) draws its wings only on
  the core's first frame, and is shown that way.
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
