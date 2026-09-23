# Sprite $2C, Yoshi Egg: resting-frame render trace

Derived ROM knowledge behind `buildYoshiEggLayout` in `src/rom/SpriteTileLoader.ts`
and the `$2C` branch in `src/rom/model/SpriteFactory.ts`. The code carries
one-line citations and points here.

Evidence scope: line numbers are `C:\Projects\SMWDisX` at the revision checked
out while this was written. Opcode bytes were read back from
`test/roms/Super Mario World (USA).vanilla.sfc` (US 1.0, headerless, 524288
bytes). Not checked against other regions.

## Why $2C cannot go through the generic path

`buildSpriteLayout` handles sprites `$00..$53` by reading `SprTilemapOffset`
and `Sprite166EVals`. For `$2C` both inputs are dead, and one of the two live
inputs is the sprite's X position, which `buildSpriteLayout` is not given. So
`$2C` is deliberately absent from `SPRITE_LOW_RANGE_OVERRIDES`: there is no
base-char patch that would fix it.

## Dispatch

`InitYoshiEgg` (`bank_01.asm:463`) runs `INC SpriteMisc187B,X` at spawn, so
`YoshiEgg` (`bank_01.asm:16039`) enters its non-zero arm.

That arm is not permanent. `bank_01.asm:16050` runs `STZ SpriteMisc187B,X`
once `SubHorizPos` reports Mario within +/-$20 pixels horizontally
(`bank_01.asm:16044-16049`), after which the handler takes the zero arm into
`CODE_01F799` (`bank_01.asm:16064`) for good. `CODE_01F799` is the hatch
sequence, gated by `SpriteMisc1540`, a one-shot timer armed by that same
proximity check and not by `EffFrame`.

The editor models the state before Mario arrives: a single resting frame, no
idle animation, hence `StaticSpriteAppearance` with no `tickAnimation`. No new
appearance class is needed.

## Char is a literal, not a table read

`CODE_01F78D` (`bank_01.asm:16057`) is five instructions:

```
JSR SubSprGfx2Entry1
LDY.W SpriteOAMIndex,X
LDA.B #$00
STA.W OAMTileNo+$100,Y
RTS
```

Read back at file offset `$00F78D` (LoROM `$01:F78D`) the bytes are
`20 0D 9F | BC EA 15 | A9 00 | 99 02 03 | 60`, matching instruction for
instruction.

`SubSprGfx2Entry1` (`bank_01.asm:4148`) writes exactly one OAM entry: one tile
number (`bank_01.asm:4160`, from `SprTilemap`), one X, one Y, one attribute,
and the large-size bit in `OAMTileSize+$40` (`bank_01.asm:4179-4181`). It is a
single 16x16 OBJ, not four 8x8 entries, so the one `STA OAMTileNo+$100,Y` in
`CODE_01F78D` overwrites the whole tile number that `SprTilemap` supplied.

Therefore the resting char is the immediate `$00`, unconditionally. Modelling
it as `SprTilemap[SprTilemapOffset[$2C]]` happens to agree in the vanilla US
ROM, but it is wrong on any ROM that edits either table: the game would still
draw `$00` while the editor drew something else. The layout hardcodes `$00`.

## Attribute: palette, flip and priority

`InitYoshiEgg` (`bank_01.asm:463-472`):

```
LDA.B SpriteXPosLow,X
LSR A / LSR A / LSR A / LSR A
AND.B #$03
TAY
LDA.W YoshiPal,Y
STA.W SpriteOBJAttribute,X
```

`YoshiPal` (`bank_01.asm:460`, data at `461`) is `db $09,$07,$05,$07`.

Two things follow.

**The palette depends on where the egg was placed.** Index is
`(SpriteXPosLow >> 4) & 3`, so the color cycles across every four 16-pixel
columns. In vanilla that is CGRAM rows 12, 11, 10, 11. `Sprite166EVals[$2C]`
(`$3B`, low nibble `$0B`, CGRAM row 13) never reaches the screen.

**The byte is stored unmasked.** The normal spawn path `LoadSpriteTables`
(`bank_07.asm:972`) applies `AND #$0F` at `bank_07.asm:978` before storing to
`SpriteOBJAttribute`, which is why flip and priority are zero for ordinary
sprites. `InitYoshiEgg` has no such mask, so all eight bits of the `YoshiPal`
byte are live in the OAM attribute (`vhoopppc`):

| bits | meaning | effect for $2C |
|---|---|---|
| 7 | V-flip | passes straight through to the OBJ |
| 6 | H-flip | **cancels** the mirror, see below |
| 5-4 | OAM priority | not modelled, see below |
| 3-1 | OBJ palette | CGRAM row `8 + bits` |
| 0 | char high bit | `+$100` |

Vanilla's four entries are all below `$10`, so today only the low nibble
matters. The derivation is written out anyway because a hack that edits
`YoshiPal` changes what the game draws.

### The H-flip is an EOR, not an ORA

`SubSprGfx2Entry1` (`bank_01.asm:4166-4174`):

```
LDA.W SpriteMisc157C,X
LSR A
LDA.B #$00
ORA.W SpriteOBJAttribute,X
BCS +
EOR.B #!OBJ_XFlip
+ ORA.B _4
  ORA.B SpriteProperties
  STA.W OAMTileAttr+$100,Y
```

`!OBJ_XFlip = %01000000` (`rammap.asm:527`). `ZeroSpriteTables`
(`bank_07.asm:933`) clears `SpriteMisc157C` at `bank_07.asm:940`, and neither
`InitYoshiEgg` nor `YoshiEgg` writes it, so bit 0 is clear, the `BCS` is not
taken, and the `EOR` always runs.

Because it is `EOR` and not `ORA`, an attribute that already has bit 6 set
comes out with it **clear**. The model is
`flipX = ((attr ^ $40) & $40) !== 0`, not a hardcoded `true`.
`flipY = (attr & $80) !== 0`.

A ROM whose `YoshiPal` entry is `$49` renders the egg unmirrored in game.
Hardcoding `flipX: true` would mirror it in the editor with every test green,
which is why `YoshiEggLayout.test.ts` exercises attribute bytes with bits 4-7
set rather than only the vanilla values.

### Priority is out of scope

Bits 5-4 are live in the OAM attribute, and `ORA SpriteProperties`
(`bank_01.asm:4173`) ORs the global priority byte in on top. Neither is
modelled: `SpriteSubtile` has no priority field and no other layout in
`SpriteTileLoader.ts` models one (see the comment above
`buildSpriteLayout`'s palette derivation). This is a pre-existing limit of
the loader, not something specific to `$2C`, so `$2C` follows it.

## Corner expansion

A 16x16 OBJ with base char `N` occupies VRAM chars `N`, `N+1`, `N+$10`,
`N+$11`. H-flip swaps the columns and mirrors each 8x8; V-flip swaps the rows
and flips each 8x8. That is `CORNER_OFFSETS` in `SpriteTileLoader.ts`, shared
with the wide-sprite path. With base char `$00` the four resting corners are
`$00, $01, $10, $11` reordered per the flip, plus `$100` when the attribute's
bit 0 is set, plus the loader's `$400` OBJ char base.
