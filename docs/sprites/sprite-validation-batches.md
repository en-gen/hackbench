# Sprite validation batches

Parallelizable agent work for validating and correcting the SMW sprite
rendering across `SpriteMetadata.ts` and `SpriteTileLoader.ts`. Each batch
covers 5 sprite IDs so multiple agent sessions can work in parallel.

Legend:
- `~~$XX~~` - already handled (custom appearance or composite); skip.
- `⚠$XX` - batch-2-researched but code change not yet applied; needs edit.

## Per-agent prompt template

```
Working directory: C:\Projects\hackbench (feature/phase1-rendering branch)
ROM: C:\Users\engenb\Super Mario World (USA).vanilla.sfc
SMW disassembly: C:\Projects\SMWDisX

For each sprite ID in your batch:
1. Read the draw routine in SMWDisX (search for main handler, TileDisp tables,
   and any custom OAM builds).
2. Determine layout: SprTilemap default, TALL (2-tile stack), WIDE (2×2
   quadrants), mixed 8×8+16×16, or custom appearance needed.
3. Verify BASE_TILE / TALL / WIDE / parts entries in
   src/rom/SpriteTileLoader.ts are correct. Cross-check charHigh and palette
   against any ORA-style runtime attr override in the draw routine.
4. Run a Python scan on the ROM to find the first vanilla level containing
   the sprite (use snes-to-offset conversion + parse sprite stream at
   $05EC00 + levelId*2).
5. Report: sprite ID, displayName, layout type, correct BASE_TILE/WIDE/TALL
   entry, needed code changes, test level ID. No code changes yet - batch
   the findings for review.
```

## Batches

| # | Sprite IDs | Notes |
|---|---|---|
| 1 | `$00 $01 $02 $03 $04` | Green/Red/Blue/Yellow Koopa (no shell), Green Koopa |
| 2 | `$05 $06 $07 $08 $09` | Red/Blue/Yellow Koopa, Green Para-Koopa (L), Green Para-Koopa (bouncing) |
| 3 | `$0A $0B $0C $0D $0E` | Red/Red Para-Koopa, Yellow Para-Koopa, Bob-omb, Keyhole |
| 4 | `$0F $10 $11 $12 $13` | Goomba, Para-Goomba, Buzzy Beetle, Unused, Spiny |
| 5 | `$14 $15 $16 $17 $18` | Spiny Egg, Cheep-Cheeps (3 variants), Jumping Cheep |
| 6 | `$19 $1A $1B $1C $1D` | Message Box, Piranha Plant, Football, Bullet Bill, Hopping Flame | ✅ analysed - see notes below |
| 7 | `$1E $1F $20 $21 $22` | Lakitu, Magikoopa, Magic, Moving Coin, Green Net Koopa |
| 8 | `$23 $24 $25 ~~$26~~ $27` | Net Koopas, ~~Thwomp~~, Thwimp |
| 9 | `$28 $29 $2A $2B $2C` | Blue Shell, Spike Top, Piranha (upside-down), Lightning, Yoshi Egg |
| 10 | `$2D $2E $2F $30 $31` | Baby Yoshi, Spike Top, Springboard, Dry Bones, Bony Beetle |
| 11 | `$32 $33 $34 $35 $36` | Dry Bones, Fireball, Boss Fireball, Yoshi, Unused |
| 12 | `$37 $38 $39 $3A $3B` | Boo, Eerie (2), Urchins (2) |
| 13 | `$3C $3D ~~$3E~~ $3F $40` | Urchin, Rip Van Fish, ~~P-Switch~~, Para-Goomba, Para-Bomb |
| 14 | `$41 $42 $43 $44 $45` | Dolphins (3), Torpedo Ted, Directional Coins |
| 15 | `$46 $47 $48 $49 $4A` | Diggin' Chuck, Fish, Chuck's Rock, Pipe, Goal Sphere |
| 16 | `$4B $4C $4D $4E $4F` | Pipe Lakitu, Exploding Block, Monty Moles, Piranha (jumping) |
| 17 | `$50 $51 $52 $53 $54` | Fire Piranha, Ninji, Moving Ledge, Throw Block, Climbing Net Door |
| 18 | `$55 $56 $57 $58 $59` | Checker/Rock platforms, Turn Block Bridge |
| 19 | `$5A $5B $5C $5D $5E` | Turn Block Bridge, Brown Platform, Falling/Orange platforms |
| 20 | `$5F $60 $61 $62 $63` | Brown Chain, Switch, Floating Skull, Line-guided platforms |
| 21 | `$64 $65 $66 $67 $68` | Rope, Chainsaws, Grinder, Fuzzball |
| 22 | `$69 $6A $6B $6C $6D` | Unused, Coin Cloud, Springboards (L/R), Invisible block |
| 23 | `~~$6E~~ ~~$6F~~ ⚠$70 $71 $72` | ~~Dino Rhino~~, ~~Dino Torch~~, ⚠Pokey, Super Koopas |
| 24 | `$73 $74 $75 $76 $77` | Super Koopa, Mushroom, Fire Flower, Star, Feather |
| 25 | `$78 $79 $7A $7B $7C` | 1-Up, Vine, Firework, Goal Tape, Princess |
| 26 | `$7D $7E $7F $80 $81` | Balloon, Flying Red Coin, Flying 1-Up, Key, Changing Item |
| 27 | `$82 ~~$83~~ ~~$84~~ $85 ⚠$86` | Bonus Game, ~~Flying ?-blocks~~, Unused, ⚠Wiggler |
| 28 | `$87 $88 $89 $8A $8B` | Lakitu Cloud, Winged Cage, L3 Smash, Bird, Smoke |
| 29 | `$8C $8D $8E $8F $90` | Side Exit, Ghost Exit, Warp Block, Scale Platforms, Gas Bubble |
| 30 | `⚠$91 $92 $93 $94 $95` | ⚠Chargin' Chuck + variants |
| 31 | `$96 $97 $98 $99 $9A` | Chuck variants, Volcano Lotus, Sumo Brother |
| 32 | `~~$9B~~ ~~$9C~~ $9D $9E ~~$9F~~` | ~~Hammer Bro (composite)~~, Bubble, Ball & Chain, ~~Banzai Bill~~ |
| 33 | `$A0 $A1 $A2 $A3 $A4` | Bowser Activator, Bowling Ball, MechaKoopa, Chain Platform, Spike Ball |
| 34 | `$A5 $A6 $A7 ⚠$A8 $A9` | Sparky, HotHead, Iggy's Ball, ⚠Blargg, Reznor |
| 35 | `$AA $AB $AC $AD $AE` | Fishbone, Rex, Wooden Spikes, Fishin' Boo |
| 36 | `$AF $B0 $B1 $B2 $B3` | Boo Block, Boo Reflection, Eating Block, Falling Spike, Bowser Fireball |
| 37 | `$B4 $B5 $B6 $B7 $B8` | Grinder, Boss Fireballs, Carrot Lifts |
| 38 | `$B9 $BA $BB $BC $BD` | Info Box, Timed Lift, Castle Block, Bowser Statue, Sliding Koopa |
| 39 | `$BE ~~$BF~~ $C0 $C1 $C2` | Swooper, ~~Mega Mole~~, Grey Lava Platform, Grey Turn Blocks, Blurp |
| 40 | `$C3 $C4 ~~$C5~~ $C6 $C7` | Porcu-Puffer, Grey Falling, ~~Big Boo~~, Spotlight, Invisible Mushroom |
| 41 | `$C8` | Light Switch Block (tail of list) |

Generators (`$C9`–`$D9`) and scroll controllers (`$DE`–`$E7`) are skipped - no visuals. Shell aliases (`$DA`–`$DD`) are handled via `resolveShellAlias` in `SpriteTileLoader`.

---

## Batch analysis notes

### Batch 6 - `$19 $1A $1B $1C $1D`

Sources: `bank_01.asm` PSwitch/Pirahna/FootBall/BulletBill/HopFlame handlers;
`SprTilemapOffset` table at `$01:9C7F`; `Sprite166EVals` at `$07:F3FE`; ROM
sprite-stream scan via `find_sprite_levels.py`.

| ID | displayName | Layout | tilemapOffset | tile[0] | charHigh | Palette row | Sample level | Code status |
|----|-------------|--------|--------------|---------|----------|-------------|--------------|-------------|
| `$19` | Message Box | none (invisible in-game) | `$56` | `$A0` | 1 | CGRAM13 | `$0C5` (Intro level) | **needs fix** - renders a stray charHigh tile; should show placeholder |
| `$1A` | Piranha Plant | sub1 TALL 16×32 | `$3A` | `$AC` (top) / `$CE` (bottom) | 0 | CGRAM12 | none - vanilla uses pipe objects, never direct sprite entry | OK - already in `SPRITE_BASE_TILE_OVERRIDES` |
| `$1B` | Football (Chargin' Chuck projectile) | sub2 16×16 | `$46` | `$8A` | 1 | CGRAM8 | none - runtime-spawned by `$91` Chargin' Chuck | OK |
| `$1C` | Bullet Bill | sub2 16×16 | `$47` | `$A6` | 0 | CGRAM9 | none - runtime-spawned by `$D3` cannon generator | OK |
| `$1D` | Hopping Flame | sub2 16×16 | `$69` | `$AE` | 1 | CGRAM10 | `$126` (Outrageous) | OK |

**`$19` Message Box** - `PSwitch` handler (`bank_01.asm`) stores OAM data then
returns immediately without drawing; the sprite is invisible at runtime. The
editor currently falls through to the generic sub2 path and renders tile
`SprTilemap[$56] | charHigh<<8`, which is an unrelated object tile. Correct fix:
add `$19` to `SPRITE_BASE_TILE_OVERRIDES` with a sentinel value (or handle it in
`SpriteFactory`) so it renders as a placeholder box rather than a random glyph.

**`$1A` Piranha Plant** - confirmed TALL (sub1) via `Sprite166EVals[$1A]`; top
tile `$AC` and bottom tile `$CE` are correctly encoded in the existing
`SPRITE_BASE_TILE_OVERRIDES` entry. No fix needed. Vanilla SMW never places `$1A`
as a direct sprite entry anywhere in the 512 level slots (including sub-areas);
pipe-based Piranha Plants are spawned by the pipe object layer instead.

**`$1B` Football** and **`$1C` Bullet Bill** - `find_sprite_levels.py` returns
0 direct placements across all 512 level slots. Football is thrown at runtime by
`$91` Chargin' Chuck; Bullet Bill is fired by the `$D3` cannon generator. Neither
is ever placed as a standalone sprite in vanilla ROM.
