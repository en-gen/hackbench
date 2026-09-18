# Sprite $4D / $4E Monty Mole - ROM derivation

Source of truth for the ASM behind `MontyMoleAppearance`. Code carries a
one-line citation back here rather than a copy of this text.

All line numbers are `C:\Projects\SMWDisX bank_01.asm` at the revision
checked on 2026-09-18. Traced, not copied.

## Handler and state machine

`MontyMole` (13330) dispatches on `SpriteTableC2,X` through a four-entry
jump table at 13335-13338:

| State | Routine | Line | What it does |
|-------|---------|------|--------------|
| 0 | `CODE_01E2E0` | 13340 | hiding; waits for Mario |
| 1 | `CODE_01E309` | 13362 | launch; first state that draws |
| 2 | `CODE_01E37F` | 13426 | airborne |
| 3 | `CODE_01E393` | - | grounded walk |

`InitMontyMole` (730-734) writes only `SpriteMisc151C`. No emerged state
overrides `SpriteOBJAttribute`, so every drawing state shares one palette
and char-high bit.

### State 0: the detection window

```
JSR SubHorizPos       ; 13341  _F = low byte of (MarioX - SpriteX)
LDA _F                ; 13342
CLC / ADC #$60        ; 13343-13344  + 96
CMP #$C0              ; 13345  unsigned compare with 192
BCS CODE_01E305       ; 13346  too far -> stay hidden
```

The branch is NOT taken for `_F` in [-96, +95]: a 192 px window, 96 px
left and 95 px right of the sprite anchor. That is the width of the
editor's detection-zone overlay.

### State 1: the pose the editor draws

`CODE_01E309` (13362) sets `SpriteYSpeed = #$B0` (13367-13368), calls
`FaceMario` (13373), then falls into `CODE_01E343` (13388):

```
LDA SpriteNumber,X / CMP #$4D / BNE +   ; 13389-13391
LDA EffFrame                            ; 13392
LSR A x4                                ; 13393-13396
AND #$01 / TAY                          ; 13397-13398
LDA DATA_01E35F,Y / STA SpriteMisc1602,X ; 13399-13400  tile-quad selector
LDA DATA_01E361,Y / JSR SubSprGfx0Entry0 ; 13401-13402  flip-quad selector in A
```

| Table | Label line | Data line | Bytes | Meaning |
|-------|-----------|-----------|-------|---------|
| `DATA_01E35F` | 13406 | **13407** | `$01,$02` | `SpriteMisc1602` per anim frame |
| `DATA_01E361` | 13409 | **13410** | `$00,$05` | `GeneralSprGfxProp` group per anim frame |

`EffFrame >> 4 & 1` holds each pose for 16 game frames, 32 per cycle.

$4E takes the other branch: `LDA #$03 / STA SpriteMisc1602,X`
(13418-13419) then `JSR SubSprGfx2Entry1` (13420), a single 16x16.

### States 2 and 3: the emerged poses

`CODE_01E3EF` (13488) calls `SubSprGfx2Entry1` (13495). The
`SpriteMisc1602` value in force selects the frame:

| Value | Set by | Line |
|-------|--------|------|
| `$00` | `SetAnimationFrame` | 2089-2096 |
| `$01` | `CODE_01E3E9` | 13483-13485 |
| `$02` | `CODE_01E37F` (state 2) | 13426-13429 |
| `$03` | $4E only | 13418-13419 |

## The two draw routines

### `SubSprGfx0Entry0` (3853) - four independent 8x8 chars

Two caller-supplied selectors:

```
_5 = A on entry                                      ; 3856  flip quad
_2 = (SpriteMisc1602 << 2) + SprTilemapOffset[id]    ; 3865-3869  tile quad
for corner _4 = 3..0:                                ; 3874-3877
  tile  = SprTilemap[_2 + _4]
  attr |= GeneralSprGfxProp[(_5 << 2) + _4]          ; bit6 flipX, bit7 flipY
  pos   = (_0 + GeneralSprDispX[_4], _1 + GeneralSprDispY[_4])
```

The `ASL A / ASL A` pair is at **3866-3867**, inside the
`LDA SpriteMisc1602,X ... STA _2` sequence at 3865-3869. (3862-3863 is
`ADC _1 / STA _1`, the unrelated sprite-Y accumulate at the top of the
routine.) The shift is what makes each animation frame its own 4-byte
quad. Reading the quad at `SpriteMisc1602 = 0` lands on the sprite's
`SubSprGfx2` single-tile frame list instead and renders four unrelated
chars - the defect this branch fixed.

`SpriteOBJAttribute,X` is read at 3870.

### `SubSprGfx2Entry1` (4148) - one hardware 16x16 OBJ

```
tile = SprTilemap[SpriteMisc1602 + SprTilemapOffset[id]]  ; 4154-4159  NO shift
attr = SpriteOBJAttribute,X                                ; 4169
       EOR OBJ_XFlip when SpriteMisc157C bit 0 is clear    ; 4166-4171
size bit: LDA #$02 / ORA SpriteOffscreenX / STA OAMTileSize ; 4179-4181
```

`SpriteOBJAttribute,X` is the same byte `SubSprGfx0Entry0` reads at 3870,
which is why the emerged ghost shares the mound's palette and char-high.

Because the size bit is set, big-tile N covers chars
`N, N+1, N+$10, N+$11`.

## Vanilla table values

Read from `Super Mario World (USA).vanilla.sfc` (headerless), not from
the disassembly:

- `SprTilemapOffset[$4D] = $EA`
- `SprTilemap[$EA..$ED] = $82 $84 $86 $8C` - the four `SubSprGfx2` frames
- `SpriteOBJAttribute[$4D] = $01` - char-high set, palette row 8
- Emerged frame `$02` is big-tile `$86`, chars `$586 $587 $596 $597`,
  which is VRAM slot **SP4** (`VRAM_CHAR_BASE.sp4 = $580`)

## The emerged-pose ghost annotation

State 1 draws a mound of rubble, so every buried mole reads as scenery.
`renderAboveL1` ghosts the emerged pose above it purely so the editor
user can tell what is buried there. The reason is IDENTITY, not
occlusion.

### Occlusion: measured, not assumed

An earlier version of this rationale claimed the mound is buried under
terrain and the L1 pass hides it. That is false.

Evidence scope: 176 `$4D`/`$4E` instances reached through
`buildMapWithGraph` across four ROMs (`Super Mario World (USA).vanilla`,
`Grand Poo World 2 1.1`, `Seven_Vanilla_Levels`, `Invictus 1.0`), one
machine, 2026-09-18. For each, the L1 Map16 tile at the sprite's own cell
and at the cell the ghost draws into was resolved through
`TileBehavior.selectQuad` and tested for any priority subtile.

**Zero placements have a priority subtile in either cell.** So on every
ROM measured, the separate pass is observationally identical to appending
`emergedParts` to `render`. It is kept as the annotation seam, not
because any shipped level needs the lift. See "Known limitations".

### Facing is not modelled

`SubSprGfx2Entry1` takes X-flip from `SpriteMisc157C` (4166-4171), a
runtime value that `FaceMario` (13373) sets from Mario's position at the
moment the mole triggers. There is no static answer in the ROM, so the
editor hardcodes `flipX = false`: one of the two runtime-possible
facings.

The composite is only mirror-symmetric in **sprite set 5**. Measured by
decoding `$586/$587/$596/$597` out of `loadVram(rom, 0, set)` for
`set = 0..15` on the vanilla ROM (SP1-SP4 come from
`SPRITEGFXLIST[spriteSet]` and do not depend on the BG tileset id):

| Sprite set | 0 | 1 | 2 | 3 | 4 | **5** | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Asymmetric px | 32 | 73 | 18 | 13 | 82 | **0** | 13 | 31 | 9 | 91 | 28 | 19 | 56 | 18 | 56 | 19 |

Vanilla gets away with it: all 14 `$4D` and all 21 `$4E` placements sit
in levels `$010` and `$106`, both sprite set 5. Hacks do not: Grand Poo
World 2 puts 16 of its 17 `$4D` in non-set-5 sprite sets,
Seven_Vanilla_Levels 12 of 27, Invictus all 48 - though Invictus replaces
the art, and the same sweep run against its own ROM finds the composite
symmetric in all 16 sets.

This is a claim-scope defect, not a pixel defect. The flip changes only
which way the same four chars face, and the ROM has no static facing to
be faithful to.

### Known limitations

- The pass does not test whether anything actually occludes the sprite,
  so the ghost draws over legitimate foreground when an author puts a
  priority tile in the cell above a mole. No measured placement does
  this (see above), so occlusion logic is not built.
- 4 of the 176 measured placements sit at level row 0, where the ghost's
  `y = -16` falls outside the canvas and `CanvasRenderTarget.blit8x8`
  clips it row by row. Deliberately not clamped: clamping would park the
  ghost on top of the mound, which destroys the one thing the annotation
  is for (telling the two poses apart), and the mound itself is still
  drawn and still selectable. A clipped annotation degrades to the
  pre-annotation behaviour; an overlapping one is worse than nothing.
- The ghost is inside `hitRect`, so clicking or hovering it selects the
  sprite rather than falling through to the L1 tile behind it. It is
  still an annotation, not a second object: it is drawn at
  `EMERGED_ALPHA`, it has no independent identity, and `Sprite.pickAt`
  returns the one mole.

## Editor animation cadence

`tickAnimation` advances a stand-in for `EffFrame` by
`ROM_FRAMES_PER_TICK` game frames per editor tick.

`SPRITE_ANIM_INTERVAL_MS = 125` is the **nominal** tick period, so the
nominal conversion is `125 ms x 60 fps / 1000 = 7.5` game frames.

The realized period is display-dependent. `createRafTimer`
(`src/webview/shared/animTimer.ts`) fires when
`now - lastTickMs >= interval` and then sets `lastTickMs = now`, so it
re-bases on the frame it fires rather than accumulating. Its realized
period is `ceil(interval / frameMs) * frameMs`:

| Refresh | Frame ms | Frames per tick | Realized ms | Game frames per tick |
|---------|----------|-----------------|-------------|----------------------|
| 60 Hz | 16.667 | 8 | 133.33 | 8.0 |
| 120 Hz | 8.333 | 15 | 125.0 | 7.5 |
| 144 Hz | 6.944 | 18 | 125.0 | 7.5 |

An appearance cannot see the refresh rate, so 7.5 is kept: it is the
correct conversion of the interval the editor asks for, and it is exact
on the high-refresh displays where the timer actually hits that interval.
On a 60 Hz display the mound toggles every 284 ms against the ROM's
267 ms, 6.7% slow. Hardcoding 8.0 would be exact at 60 Hz and 6.25% fast
at 120/144 Hz. Neither is right everywhere; the fix is an accumulating
timer (`lastTickMs += interval`), which is a shared change affecting
every animated thing in the editor and is out of scope here.

`RipVanFishAppearance.ts` carries the same nominal constant and the same
display dependence.
