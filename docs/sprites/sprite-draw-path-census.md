# Sprite draw-path census: how far can a table-driven engine reach?

Read-only measurement. Nothing in any repo or worktree was modified.

Sources, both read-only:

- ROM: `C:\Projects\hackbench\test\roms\Super Mario World (USA).vanilla.sfc`, headerless, 524288 bytes, SHA of length verified at read time.
- Disassembly: `C:\Projects\SMWDisX`, with `SMW_U.sym` used to bind labels to SNES addresses.

## The four numbers

**1. Of the 201 sprite ids in the MAIN handler pointer table at `$01:85CC`:**

| class | count |
|---|---|
| SHARED (reaches `SubSprGfx0Entry0`, `SubSprGfx1` or `SubSprGfx2Entry1`) | **104** |
| BESPOKE (own OAM tile-write loop, no shared routine on any path) | **86** |
| NEITHER (no `OAMTileNo` write reachable at all) | **10** |
| UNDETERMINED | **1** |

Split of the 104 SHARED by routine: `SubSprGfx2` only 64, `SubSprGfx1` only 11, `SubSprGfx0` only 4, `SubSprGfx1`+`SubSprGfx2` 17, `SubSprGfx0`+`SubSprGfx2` 8. No id reaches all three.

The 104 is not 104 clean wins. **46 of the 104 are hybrids**: the routine that calls the shared draw routine also writes `OAMTileNo` itself, so the shared call draws part of the sprite and bespoke code draws the rest. `$C2` Blurp and `$BE` Swooper are the clearest examples, both `JSL GenericSprGfxRt2` immediately followed by their own `STA OAMTileNo+$100,y` (`bank_03.asm:565` and `bank_03.asm:1084`). **58 of the 104 are pure**, in the sense that the calling routine writes no tile of its own.

**2. Ids behind a shared bank-dispatch stub: 37 behind `Bank3SprHandler`, 53 behind a multi-id stub in total.**

`Bank3SprHandler` (`bank_01.asm:1126`) is a two-instruction `JSL Bnk3CallSprMain` / `RTS` thunk, and it is not the only one. Four more thunks are shared by more than one id:

| thunk | target | ids |
|---|---|---|
| `Bank3SprHandler` | `Bnk3CallSprMain` (`bank_03.asm:4305`) | 37 |
| `Chucks` | `ChucksMain` | 8 |
| `InvisSolid_Dinos` | `InvisBlk_DinosMain` | 3 |
| `BanzaiBnCGrayPlat` | `Banzai_Rotating` | 3 |
| `JumpingPiranha` | `JumpingPiranhaMain` | 2 |
| **total** | | **53** |

`InvisBlk_DinosMain` and `Banzai_Rotating` re-dispatch on `SpriteNumber` exactly as `Bnk3CallSprMain` does, so they have the same two failure modes the brief describes.

Two wider figures matter for the "identity by pointer" half of the problem:

- **82 of 201** MAIN entries are two-instruction `JSL`/`RTS` thunks (34 distinct thunk labels, 29 of them used by a single id). Any offset anchored past the MAIN pointer lands inside a four-byte stub for all 82, not only the 37.
- **126 of 201** ids share their MAIN pointer value with at least one other id. There are only **104 distinct pointer values** for 201 ids. Identity-by-pointer fails for 126 ids, and removing the dispatch stubs does not fix it, because plain handlers like `Spr0to13Start` (8 ids), `WallFollowers` (6) and `Platforms` (4) collide the same way.

**3. Of the 24 appearance classes that hardcode tile literals in TypeScript, 7 are in the SHARED set.**

Counting by sprite id rather than by class: the 24 classes cover 36 distinct ids, of which **16 are SHARED and 20 are BESPOKE**. Of those 16, only 9 are pure (non-hybrid): `$08`-`$0C`, `$10`, `$3D`, `$83`, `$84`.

| fully SHARED (7 classes) | ids | hybrid |
|---|---|---|
| `WingedSpriteAppearance` | `$08 $09 $0A $0B $0C $10 $83 $84` | 0/8 |
| `ChainsawAppearance` | `$65 $66` | 2/2 |
| `DryBonesAppearance` | `$30 $32` | 2/2 |
| `LineBrownPlatAppearance` | `$62` | 1/1 |
| `LineCheckerPlatAppearance` | `$63` | 1/1 |
| `RopeMechanismAppearance` | `$64` | 1/1 |
| `RipVanFishAppearance` | `$3D` | 0/1 |

The other 17 are all BESPOKE: `BallAndChain $9E`, `BanzaiBill $9F`, `BouncinChuck $93`, `CharginChuck $91`, `ClappinChuck $95`, `HammerBroPlatform $9C`, `Keyhole $0E`, `PitchinChuck $98`, `PuntinChuck $97`, `SplittinChuck $92`, `SumoBrother $9A`, `SuperKoopa $71 $72 $73`, `Thwomp $26`, `VolcanoLotus $99`, `WhistlinChuck $94`, `Wiggler $86`, `WoodSpike $AC $AD`.

This is the number that should drive the decision. The strongest argument for the engine was the 24 tile-literal classes, and **the engine as designed reaches 7 of them**. The eight Chuck variants, which are the single biggest cluster of hardcoded tile literals in the TypeScript, all draw through `CODE_02CA27`, a bespoke loop, and the engine cannot touch any of them.

**4. Of the 104 SHARED, 16 are already covered, so 88 remain, in 50 families.**

All 16 currently-covered ids (`$00`-`$07`, `$0F`, `$11`, `$13`, `$14`, `$1F`, `$2C`, `$4D`, `$4E`) land in the SHARED set. That is a useful check on the method: zero false negatives against the known-good set.

Grouping the 88 by the routine that actually calls the shared draw routine:

- 15 multi-id families covering 53 ids
- 35 singletons
- 45 of the 88 are hybrids

Restricting to the 43 uncovered ids that are both SHARED and pure, which is the genuinely tractable set: **26 families, 9 of them multi-id covering 26 ids, and 17 singletons.**

| ids | routine | sprite ids |
|---|---|---|
| 5 | `CODE_018BDE` / `CODE_018BEC` (the `Spr0to13Gfx` blob) | `$08 $09 $0A $0B $0C` |
| 4 | `CODE_01B10A` (fish) | `$15 $16 $17 $18` |
| 4 | `CODE_01BA53` (net koopas) | `$22 $23 $24 $25` |
| 3 | `CODE_02BC00` (dolphins) | `$41 $42 $43` |
| 2 | `ClassicPiranhas` | `$1A $2A` |
| 2 | `CODE_01F8C9` (eerie) | `$38 $39` |
| 2 | `CODE_01D5B3` (parachute) | `$3F $40` |
| 2 | `CODE_02E0CD` (jumping piranha) | `$4F $50` |
| 2 | `Flying_Block` | `$83 $84` |
| 1 each | 17 singletons | `$0D $10 $1B $1C $1D $1E $27 $2B $2F $35 $3D $47 $48 $4A $4C $51 $C5` |

The `$08`-`$0C` family extends the existing `$00`-`$07`/`$0F`/`$11`/`$13` descriptor factory, since they share `Spr0to13Gfx`. That is the one genuinely cheap extension. After it, the largest new family is four ids, and 17 of 26 families are singletons.

## Indirection depth

Distinct named routines on the shortest path from the MAIN table entry to the shared routine, for the 104 SHARED:

| depth | ids |
|---|---|
| 2 | 14 |
| 3 | 22 |
| 4 | 22 |
| 5 | 15 |
| 6 | 26 |
| 7 | 5 |

The `$00`-`$03` shell-less Koopa case the brief describes measures at depth 7: `ShellessKoopas > CODE_018908 > CODE_018913 > CODE_018B03 > Spr0to13Gfx > CODE_018BDE > SubSprGfx2Entry1`, with a parallel path through `CODE_018BEC` to `SubSprGfx1`. The runtime selection between `SubSprGfx1` and `SubSprGfx2Entry1` is real: 25 of the 104 SHARED ids reach two different shared routines on different paths, so a descriptor for those must carry both and a predicate, not one routine id.

Nothing is shallower than depth 2. Every SHARED id costs at least one `CodeRef` hop.


## Per-id table

Columns: stub = behind `Bank3SprHandler`; depth = distinct named routines on the shortest path to the shared routine; hyb = the calling routine also writes `OAMTileNo`; cov = already covered by the 16.

| id | MAIN target | stub | resolved handler | class | draw routine | depth | hyb | cov |
|---|---|---|---|---|---|---|---|---|
| $00 | ShellessKoopas |  | ShellessKoopas | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 7 |  | Y |
| $01 | ShellessKoopas |  | ShellessKoopas | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 7 |  | Y |
| $02 | ShellessKoopas |  | ShellessKoopas | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 7 |  | Y |
| $03 | ShellessKoopas |  | ShellessKoopas | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 7 |  | Y |
| $04 | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $05 | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $06 | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $07 | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $08 | GreenParaKoopa |  | GreenParaKoopa | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 5 |  |  |
| $09 | GreenParaKoopa |  | GreenParaKoopa | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 5 |  |  |
| $0A | RedVertParaKoopa |  | RedVertParaKoopa | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  |  |
| $0B | RedHorzParaKoopa |  | RedHorzParaKoopa | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 7 |  |  |
| $0C | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  |  |
| $0D | Bobomb |  | Bobomb | SHARED | G1+G2 via Bobomb,CODE_018BEC | 2 |  |  |
| $0E | Keyhole |  | Keyhole | BESPOKE | CODE_01E23A |  |  |  |
| $0F | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $10 | WingedGoomba |  | WingedGoomba | SHARED | G2 via CODE_018DAC | 3 |  |  |
| $11 | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $12 | Return01F87B |  | Return01F87B | NEITHER | - |  |  |  |
| $13 | Spr0to13Start |  | Spr0to13Start | SHARED | G1+G2 via CODE_018BDE,CODE_018BEC | 6 |  | Y |
| $14 | SpinyEgg |  | SpinyEgg | SHARED | G0 via CODE_018C44 | 3 |  | Y |
| $15 | Fish |  | Fish | SHARED | G2 via CODE_01B10A | 4 |  |  |
| $16 | Fish |  | Fish | SHARED | G2 via CODE_01B10A | 4 |  |  |
| $17 | GeneratedFish |  | GeneratedFish | SHARED | G2 via CODE_01B10A | 4 |  |  |
| $18 | JumpingFish |  | JumpingFish | SHARED | G2 via CODE_01B10A | 4 |  |  |
| $19 | PSwitch |  | PSwitch | NEITHER | - |  |  |  |
| $1A | ClassicPiranhas |  | ClassicPiranhas | SHARED | G1 via ClassicPiranhas | 2 |  |  |
| $1B | Bank3SprHandler | B3 | Football | SHARED | G2 via Football | 3 |  |  |
| $1C | BulletBill |  | BulletBill | SHARED | G2 via BulletBill | 2 |  |  |
| $1D | HoppingFlame |  | HoppingFlame | SHARED | G2 via CODE_018F49 | 3 |  |  |
| $1E | Lakitu |  | Lakitu | SHARED | G1 via Lakitu | 2 |  |  |
| $1F | Magikoopa |  | Magikoopa | SHARED | G1 via CODE_01BF16 | 3 |  | Y |
| $20 | MagikoopasMagic |  | MagikoopasMagic | BESPOKE | MagiKoopasMagicGfx |  |  |  |
| $21 | PowerUpRt |  | PowerUpRt | SHARED | G2 via PowerUpRt | 2 | Y |  |
| $22 | ClimbingKoopa |  | ClimbingKoopa | SHARED | G1 via CODE_01BA53 | 4 |  |  |
| $23 | ClimbingKoopa |  | ClimbingKoopa | SHARED | G1 via CODE_01BA53 | 4 |  |  |
| $24 | ClimbingKoopa |  | ClimbingKoopa | SHARED | G1 via CODE_01BA53 | 4 |  |  |
| $25 | ClimbingKoopa |  | ClimbingKoopa | SHARED | G1 via CODE_01BA53 | 4 |  |  |
| $26 | Thwomp |  | Thwomp | BESPOKE | CODE_01AF8F |  |  |  |
| $27 | Thwimp |  | Thwimp | SHARED | G0 via CODE_01B006 | 3 |  |  |
| $28 | BigBoo |  | BigBoo | SHARED | G2 via CODE_01FA09 | 6 | Y |  |
| $29 | KoopaKid |  | KoopaKid | BESPOKE | CODE_01FEDE |  |  |  |
| $2A | ClassicPiranhas |  | ClassicPiranhas | SHARED | G1 via ClassicPiranhas | 2 |  |  |
| $2B | SumosLightning |  | SumosLightning | SHARED | G0 via CODE_02DEB0 | 5 |  |  |
| $2C | YoshiEgg |  | YoshiEgg | SHARED | G2 via CODE_01F78D | 3 | Y | Y |
| $2D | Return0185C2 |  | Return0185C2 | NEITHER | - |  |  |  |
| $2E | WallFollowers |  | WallFollowers | SHARED | G2 via CODE_02BE4E | 6 | Y |  |
| $2F | SpringBoard |  | SpringBoard | SHARED | G0 via CODE_01E6F0 | 3 |  |  |
| $30 | DryBonesAndBeetle |  | DryBonesAndBeetle | SHARED | G2 via DATA_01E43C | 3 | Y |  |
| $31 | DryBonesAndBeetle |  | DryBonesAndBeetle | SHARED | G2 via DATA_01E43C | 3 | Y |  |
| $32 | DryBonesAndBeetle |  | DryBonesAndBeetle | SHARED | G2 via DATA_01E43C | 3 | Y |  |
| $33 | Fireballs |  | Fireballs | SHARED | G0+G2 via CODE_01E164,CODE_01E198 | 5 | Y |  |
| $34 | BossFireball |  | BossFireball | BESPOKE | CODE_01D4A8 |  |  |  |
| $35 | Yoshi |  | Yoshi | SHARED | G2 via CODE_01EF18 | 4 |  |  |
| $36 | DATA_01E41F |  | DATA_01E41F | UNDETERMINED | - |  |  |  |
| $37 | Boo_BooBlock |  | Boo_BooBlock | SHARED | G2 via CODE_01FA09 | 5 | Y |  |
| $38 | Eerie |  | Eerie | SHARED | G2 via CODE_01F8C9 | 3 |  |  |
| $39 | Eerie |  | Eerie | SHARED | G2 via CODE_01F8C9 | 3 |  |  |
| $3A | WallFollowers |  | WallFollowers | SHARED | G2 via CODE_02BE4E | 6 | Y |  |
| $3B | WallFollowers |  | WallFollowers | SHARED | G2 via CODE_02BE4E | 6 | Y |  |
| $3C | WallFollowers |  | WallFollowers | SHARED | G2 via CODE_02BE4E | 6 | Y |  |
| $3D | RipVanFish |  | RipVanFish | SHARED | G2 via RipVanFishMain | 4 |  |  |
| $3E | PSwitch |  | PSwitch | NEITHER | - |  |  |  |
| $3F | ParachuteSprites |  | ParachuteSprites | SHARED | G0+G2 via CODE_01D5B3 | 4 |  |  |
| $40 | ParachuteSprites |  | ParachuteSprites | SHARED | G0+G2 via CODE_01D5B3 | 4 |  |  |
| $41 | Dolphin |  | Dolphin | SHARED | G1 via CODE_02BC00 | 6 |  |  |
| $42 | Dolphin |  | Dolphin | SHARED | G1 via CODE_02BC00 | 6 |  |  |
| $43 | Dolphin |  | Dolphin | SHARED | G1 via CODE_02BC00 | 6 |  |  |
| $44 | TorpedoTed |  | TorpedoTed | BESPOKE | TorpedoGfxRt |  |  |  |
| $45 | DirectionalCoins |  | DirectionalCoins | SHARED | G2 via CODE_02E245 | 6 | Y |  |
| $46 | DigginChuck |  | DigginChuck | BESPOKE | CODE_02CA27 |  |  |  |
| $47 | SwimJumpFish |  | SwimJumpFish | SHARED | G2 via CODE_02E727 | 5 |  |  |
| $48 | DigginChucksRock |  | DigginChucksRock | SHARED | G2 via CODE_02E7BD | 5 |  |  |
| $49 | GrowingPipe |  | GrowingPipe | BESPOKE | CODE_02E902 |  |  |  |
| $4A | GoalSphere |  | GoalSphere | SHARED | G2 via GoalSphere | 2 |  |  |
| $4B | PipeLakitu |  | PipeLakitu | BESPOKE | CODE_02E9EC |  |  |  |
| $4C | ExplodingBlock |  | ExplodingBlock | SHARED | G2 via CODE_02E41F | 5 |  |  |
| $4D | MontyMole |  | MontyMole | SHARED | G0+G2 via CODE_01E343,CODE_01E3EF | 4 |  | Y |
| $4E | MontyMole |  | MontyMole | SHARED | G0+G2 via CODE_01E343,CODE_01E3EF | 4 |  | Y |
| $4F | JumpingPiranha |  | JumpingPiranha | SHARED | G0+G2 via CODE_02E0CD | 5 |  |  |
| $50 | JumpingPiranha |  | JumpingPiranha | SHARED | G0+G2 via CODE_02E0CD | 5 |  |  |
| $51 | Bank3SprHandler | B3 | Ninji | SHARED | G2 via Ninji | 3 |  |  |
| $52 | MovingLedge |  | MovingLedge | BESPOKE | CODE_02E637 |  |  |  |
| $53 | Return0185C2 |  | Return0185C2 | NEITHER | - |  |  |  |
| $54 | ClimbingDoor |  | ClimbingDoor | BESPOKE | ClimbingDoor |  |  |  |
| $55 | Platforms |  | Platforms | BESPOKE | CODE_01B344 |  |  |  |
| $56 | Platforms |  | Platforms | BESPOKE | CODE_01B344 |  |  |  |
| $57 | Platforms |  | Platforms | BESPOKE | CODE_01B344 |  |  |  |
| $58 | Platforms |  | Platforms | BESPOKE | CODE_01B344 |  |  |  |
| $59 | TurnBlockBridge |  | TurnBlockBridge | BESPOKE | CODE_01B710 |  |  |  |
| $5A | HorzTurnBlkBridge |  | HorzTurnBlkBridge | BESPOKE | CODE_01B710 |  |  |  |
| $5B | Platforms2 |  | Platforms2 | BESPOKE | CODE_01B344 |  |  |  |
| $5C | Platforms2 |  | Platforms2 | BESPOKE | CODE_01B344 |  |  |  |
| $5D | Platforms2 |  | Platforms2 | BESPOKE | CODE_01B344 |  |  |  |
| $5E | OrangePlatform |  | OrangePlatform | BESPOKE | CODE_01B344 |  |  |  |
| $5F | BrownChainedPlat |  | BrownChainedPlat | BESPOKE | CODE_01C795 |  |  |  |
| $60 | PalaceSwitch |  | PalaceSwitch | BESPOKE | CODE_02CD91 |  |  |  |
| $61 | FloatingSkulls |  | FloatingSkulls | SHARED | G2 via CODE_02EDF6 | 6 | Y |  |
| $62 | LineFuzzy_Plats |  | LineFuzzy_Plats | SHARED | G2 via CODE_01DBD4 | 4 | Y |  |
| $63 | LineFuzzy_Plats |  | LineFuzzy_Plats | SHARED | G2 via CODE_01DBD4 | 4 | Y |  |
| $64 | LineRope_Chainsaw |  | LineRope_Chainsaw | SHARED | G2 via CODE_01DBD4 | 6 | Y |  |
| $65 | LineRope_Chainsaw |  | LineRope_Chainsaw | SHARED | G2 via CODE_01DBD4 | 6 | Y |  |
| $66 | LineRope_Chainsaw |  | LineRope_Chainsaw | SHARED | G2 via CODE_01DBD4 | 6 | Y |  |
| $67 | LineGrinder |  | LineGrinder | SHARED | G2 via CODE_01DBD4 | 5 | Y |  |
| $68 | LineFuzzy_Plats |  | LineFuzzy_Plats | SHARED | G2 via CODE_01DBD4 | 4 | Y |  |
| $69 | Return01D6C3 |  | Return01D6C3 | NEITHER | - |  |  |  |
| $6A | CoinCloud |  | CoinCloud | SHARED | G2 via ADDR_02EF1C | 6 | Y |  |
| $6B | PeaBouncer |  | PeaBouncer | BESPOKE | CODE_02CEFC |  |  |  |
| $6C | PeaBouncer |  | PeaBouncer | BESPOKE | CODE_02CEFC |  |  |  |
| $6D | InvisSolid_Dinos |  | InvisSolid_Dinos | BESPOKE | CODE_039E5F |  |  |  |
| $6E | InvisSolid_Dinos |  | InvisSolid_Dinos | BESPOKE | CODE_039E5F |  |  |  |
| $6F | InvisSolid_Dinos |  | InvisSolid_Dinos | BESPOKE | CODE_039E5F |  |  |  |
| $70 | Pokey |  | Pokey | SHARED | G2 via CODE_02B681 | 6 | Y |  |
| $71 | RedSuperKoopa |  | RedSuperKoopa | BESPOKE | CODE_02ECF7 |  |  |  |
| $72 | YellowSuperKoopa |  | YellowSuperKoopa | BESPOKE | CODE_02ECF7 |  |  |  |
| $73 | FeatherSuperKoopa |  | FeatherSuperKoopa | BESPOKE | CODE_02ECF7 |  |  |  |
| $74 | PowerUpRt |  | PowerUpRt | SHARED | G2 via PowerUpRt | 2 | Y |  |
| $75 | FireFlower |  | FireFlower | SHARED | G2 via PowerUpRt | 3 | Y |  |
| $76 | PowerUpRt |  | PowerUpRt | SHARED | G2 via PowerUpRt | 2 | Y |  |
| $77 | Feather |  | Feather | BESPOKE | CODE_01C670 |  |  |  |
| $78 | PowerUpRt |  | PowerUpRt | SHARED | G2 via PowerUpRt | 2 | Y |  |
| $79 | GrowingVine |  | GrowingVine | SHARED | G2 via GrowingVine | 2 | Y |  |
| $7A | Bank3SprHandler | B3 | Firework | BESPOKE | CODE_03C96D |  |  |  |
| $7B | GoalTape |  | GoalTape | BESPOKE | CODE_01C12D |  |  |  |
| $7C | Bank3SprHandler | B3 | PrincessPeach | BESPOKE | PrincessPeach |  |  |  |
| $7D | BalloonKeyFlyObjs |  | BalloonKeyFlyObjs | BESPOKE | CODE_01C61A, PowerUpGfxRt |  |  |  |
| $7E | BalloonKeyFlyObjs |  | BalloonKeyFlyObjs | BESPOKE | CODE_01C61A, PowerUpGfxRt |  |  |  |
| $7F | BalloonKeyFlyObjs |  | BalloonKeyFlyObjs | BESPOKE | CODE_01C61A, PowerUpGfxRt |  |  |  |
| $80 | BalloonKeyFlyObjs |  | BalloonKeyFlyObjs | BESPOKE | CODE_01C61A, PowerUpGfxRt |  |  |  |
| $81 | ChangingItem |  | ChangingItem | SHARED | G2 via PowerUpRt | 3 | Y |  |
| $82 | BonusGame |  | BonusGame | BESPOKE | CODE_01DF4E |  |  |  |
| $83 | Flying_Block |  | Flying_Block | SHARED | G2 via Flying_Block | 2 |  |  |
| $84 | Flying_Block |  | Flying_Block | SHARED | G2 via Flying_Block | 2 |  |  |
| $85 | InitFlying_Block |  | InitFlying_Block | NEITHER | - |  |  |  |
| $86 | Wiggler |  | Wiggler | BESPOKE | CODE_02F12D |  |  |  |
| $87 | LakituCloud |  | LakituCloud | BESPOKE | CODE_01E901 |  |  |  |
| $88 | WingedCage |  | WingedCage | BESPOKE | ADDR_02CCD0 |  |  |  |
| $89 | Layer3Smash |  | Layer3Smash | NEITHER | - |  |  |  |
| $8A | YoshisHouseBirds |  | YoshisHouseBirds | BESPOKE | CODE_02F3EA |  |  |  |
| $8B | YoshisHouseSmoke |  | YoshisHouseSmoke | BESPOKE | CODE_02F47C |  |  |  |
| $8C | SideExit |  | SideExit | BESPOKE | CODE_02F4EB |  |  |  |
| $8D | GhostHouseExit |  | GhostHouseExit | BESPOKE | CODE_02F5DA |  |  |  |
| $8E | WarpBlocks |  | WarpBlocks | NEITHER | - |  |  |  |
| $8F | ScalePlatforms |  | ScalePlatforms | BESPOKE | MushroomScaleGfx |  |  |  |
| $90 | GasBubble |  | GasBubble | BESPOKE | CODE_02E3F5 |  |  |  |
| $91 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $92 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $93 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $94 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $95 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $96 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $97 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $98 | Chucks |  | Chucks | BESPOKE | CODE_02CA27 |  |  |  |
| $99 | VolcanoLotus |  | VolcanoLotus | BESPOKE | VolcanoLotusGfx |  |  |  |
| $9A | SumoBrother |  | SumoBrother | BESPOKE | CODE_02DE5B |  |  |  |
| $9B | HammerBrother |  | HammerBrother | BESPOKE | CODE_02DB08 |  |  |  |
| $9C | FlyingPlatform |  | FlyingPlatform | BESPOKE | CODE_02DC5D |  |  |  |
| $9D | BubbleWithSprite |  | BubbleWithSprite | SHARED | G2 via CODE_02D8BB | 5 | Y |  |
| $9E | BanzaiBnCGrayPlat |  | BanzaiBnCGrayPlat | BESPOKE | CODE_02D5E4 |  |  |  |
| $9F | BanzaiBnCGrayPlat |  | BanzaiBnCGrayPlat | BESPOKE | CODE_02D5E4 |  |  |  |
| $A0 | Bank3SprHandler | B3 | CODE_03DFCC | BESPOKE | CODE_03AF59 |  |  |  |
| $A1 | Bank3SprHandler | B3 | BowserBowlingBall | BESPOKE | BowserBallGfx |  |  |  |
| $A2 | Bank3SprHandler | B3 | MechaKoopa | BESPOKE | CODE_03B37F |  |  |  |
| $A3 | BanzaiBnCGrayPlat |  | BanzaiBnCGrayPlat | BESPOKE | CODE_02D5E4 |  |  |  |
| $A4 | FloatingSpikeBall |  | FloatingSpikeBall | BESPOKE | CODE_01B344 |  |  |  |
| $A5 | WallFollowers |  | WallFollowers | SHARED | G2 via CODE_02BE4E | 6 | Y |  |
| $A6 | WallFollowers |  | WallFollowers | SHARED | G2 via CODE_02BE4E | 6 | Y |  |
| $A7 | IggysBall |  | IggysBall | SHARED | G2 via IggysBall | 2 | Y |  |
| $A8 | Bank3SprHandler | B3 | Blargg | SHARED | G2 via CODE_03A062 | 4 | Y |  |
| $A9 | Bank3SprHandler | B3 | Reznor | BESPOKE | ReznorPlatGfxRt |  |  |  |
| $AA | Bank3SprHandler | B3 | Fishbone | SHARED | G2 via FishboneGfx | 4 | Y |  |
| $AB | Bank3SprHandler | B3 | RexMainRt | BESPOKE | RexGfxLoopStart |  |  |  |
| $AC | Bank3SprHandler | B3 | WoodenSpike | BESPOKE | WoodSpikeGfx |  |  |  |
| $AD | Bank3SprHandler | B3 | WoodenSpike | BESPOKE | WoodSpikeGfx |  |  |  |
| $AE | Bank3SprHandler | B3 | FishinBoo | BESPOKE | CODE_039191 |  |  |  |
| $AF | Boo_BooBlock |  | Boo_BooBlock | SHARED | G2 via CODE_01FA09 | 5 | Y |  |
| $B0 | Bank3SprHandler | B3 | BooStream | SHARED | G2 via BooStream | 3 | Y |  |
| $B1 | Bank3SprHandler | B3 | CreateEatBlock | SHARED | G2 via CreateEatBlock | 3 | Y |  |
| $B2 | Bank3SprHandler | B3 | FallingSpike | SHARED | G2 via FallingSpike | 3 | Y |  |
| $B3 | Bank3SprHandler | B3 | StatueFireball | BESPOKE | CODE_038F2F |  |  |  |
| $B4 | Grinder |  | Grinder | BESPOKE | CODE_01DBA2 |  |  |  |
| $B5 | Fireballs |  | Fireballs | SHARED | G0+G2 via CODE_01E164,CODE_01E198 | 5 | Y |  |
| $B6 | Bank3SprHandler | B3 | ReflectingFireball | SHARED | G2 via CODE_038FF2 | 4 | Y |  |
| $B7 | Bank3SprHandler | B3 | CarrotTopLift | BESPOKE | CODE_038D34 |  |  |  |
| $B8 | Bank3SprHandler | B3 | CarrotTopLift | BESPOKE | CODE_038D34 |  |  |  |
| $B9 | Bank3SprHandler | B3 | InfoBox | SHARED | G2 via InfoBox | 3 | Y |  |
| $BA | Bank3SprHandler | B3 | TimedLift | BESPOKE | CODE_038E2E |  |  |  |
| $BB | Bank3SprHandler | B3 | GreyCastleBlock | BESPOKE | CODE_038EB4 |  |  |  |
| $BC | Bank3SprHandler | B3 | BowserStatue | BESPOKE | CODE_038B57 |  |  |  |
| $BD | Bank3SprHandler | B3 | SlidingKoopa | SHARED | G2 via CODE_038964 | 4 | Y |  |
| $BE | Bank3SprHandler | B3 | Swooper | SHARED | G2 via Swooper | 3 | Y |  |
| $BF | Bank3SprHandler | B3 | MegaMole | BESPOKE | MegaMoleGfxLoopSt |  |  |  |
| $C0 | Bank3SprHandler | B3 | GrayLavaPlatform | BESPOKE | CODE_03873A |  |  |  |
| $C1 | Bank3SprHandler | B3 | FlyingTurnBlocks | BESPOKE | CODE_0386A8 |  |  |  |
| $C2 | Bank3SprHandler | B3 | Blurp | SHARED | G2 via Blurp | 3 | Y |  |
| $C3 | Bank3SprHandler | B3 | PorcuPuffer | BESPOKE | CODE_0385B4 |  |  |  |
| $C4 | Bank3SprHandler | B3 | GreyFallingPlat | BESPOKE | CODE_038492 |  |  |  |
| $C5 | Bank3SprHandler | B3 | BigBooBoss | SHARED | G2 via CODE_0383A0 | 5 |  |  |
| $C6 | Bank3SprHandler | B3 | DarkRoomWithLight | BESPOKE | CODE_03C4A5 |  |  |  |
| $C7 | Bank3SprHandler | B3 | InvisMushroom | NEITHER | - |  |  |  |
| $C8 | Bank3SprHandler | B3 | LightSwitch | SHARED | G2 via CODE_03C22B | 4 | Y |  |

## Method

**Step 1, the pointer table, read from the ROM.** `CallSpriteMain` is at `$01:85C3` (`bank_01.asm:893`). Its prologue is `STZ.W SpriteXMovement` (3 bytes), `LDA.B SpriteNumber,X` (2), `JSL ExecutePtr` (4), so the table begins at `$01:85CC`, which is file offset `0x85CC` in LoROM with no header. I read 402 bytes there and decoded 201 little-endian bank-`$01` pointers. All 201 resolved to a named label in `SMW_U.sym`, and the resulting id-to-label list matches the `dw` list in `bank_01.asm:897-1098` entry for entry. 104 distinct pointer values.

**Step 2, a line-level control flow graph.** I built a CFG over all 13 `bank_*.asm` files, 64092 code nodes. Node per code line; fallthrough to the next code line with `db`/`dw`/`dl`/`incbin` blocks acting as barriers; `RTS`/`RTL`/`RTI` terminate; `JSR`/`JSL` add both a call edge and a return-side fallthrough; `JMP`/`JML`/`BRA`/`BRL` replace fallthrough; conditional branches add both. `JSL ExecutePtr` and `JSL ExecutePtrLong` are expanded into the `dw`/`dl` table that follows them, 85 dispatch sites in total. asar anonymous labels (`+`, `++`, `-`, `--`) are resolved to the nearest matching anchor in the same file.

**Step 3, classification.** Forward reachability from each id's resolved handler to the line of `SubSprGfx0Entry0`/`Entry1` (`bank_01.asm:3853`/`3855`), `SubSprGfx1` (`bank_01.asm:3920`), `SubSprGfx2Entry0`/`Entry1` (`bank_01.asm:4144`/`4148`). Ids reaching none of those, but reaching a `STA OAMTileNo` outside the shared bodies, are BESPOKE. Ids reaching neither are NEITHER.

**Step 4, the bank-3 chain.** `Bnk3CallSprMain` is a `CMP`/`BNE`/`JSR` chain, not a table. I parsed it and recovered 36 explicit id-to-routine mappings; the 37th id, `$A0`, is the unmatched fallthrough at `bank_03.asm:4521-4523` (`JSL CODE_03DFCC` / `JSR CODE_03A279` / `JSR CODE_03B43C`, the Bowser fight). Each bank-3 id was analysed from its own routine, not from the shared stub.

### Things this measurement found and corrected

**The brief names three shared routines; there are six entry points.** `GenericSprGfxRt0` (`bank_01.asm:61`), `GenericSprGfxRt1` (`bank_01.asm:3912`) and `GenericSprGfxRt2` (`bank_01.asm:2393`) are `PHB`/`PHK`/`PLB`/`JSR`/`PLB`/`RTL` trampolines around `SubSprGfx0Entry0`, `SubSprGfx1` and `SubSprGfx2Entry1`. Every caller outside bank 1 uses these. `GenericSprGfxRt2` alone has 28 call sites from banks 00, 02 and 03. A grep for `JSR SubSprGfx` finds none of them, which would have undercounted SHARED by roughly a third.

**A false-positive bridge, found and removed.** Four ids reached `SubSprGfx2Entry1` only through `DrawMarioAndYoshi`: `$5F` BrownChainedPlat and `$9E`/`$9F`/`$A3` BanzaiBnCGrayPlat. These sprites carry Mario, so they call Mario's drawing code, which draws Yoshi through the shared routine. That is not the sprite drawing itself. Excluding that one routine drops SHARED from 108 to 104. It is the only bridge of its kind I found: reverse reachability from the shared routines covers 992 of 8365 labels, and no label with more than 40 callers sits inside that set, so there is no high-fan-in utility silently connecting everything.

**Two parser defects that changed the answer.** A first label-level pass mis-handled asar local labels, so `  + RTS` was not recognised as a terminator and spurious fallthrough edges appeared, and separately `BRA +` targets crossing a global-label boundary were dropped entirely, which hid `$0B` RedHorzParaKoopa and `$28` BigBoo. Fixing the second in the label-level graph over-corrected to 180 SHARED, because an edge to an anchor deep inside a routine was modelled as an edge to that routine's start. The line-level CFG has neither problem and lands at 104, agreeing with the conservative first pass on the count while correcting its membership.

### Validation

**ROM against disassembly text, call-site counts.** I scanned all 524288 ROM bytes for `JSR` (`$20`), `JMP` (`$4C`), `JSL` (`$22`) and `JML` (`$5C`) opcodes targeting each shared routine's address, requiring the same bank for the bank-local forms, and compared with a text grep of the disassembly:

| routine | address | ROM | disassembly |
|---|---|---|---|
| `SubSprGfx0Entry0` | `$01:9CF3` | 6 | 6 |
| `SubSprGfx0Entry1` | `$01:9CF5` | 1 | 1 |
| `SubSprGfx1` | `$01:9D67` | 10 | 10 |
| `SubSprGfx2Entry0` | `$01:9F09` | 2 | 2 |
| `SubSprGfx2Entry1` | `$01:9F0D` | 35 | 35 |
| `GenericSprGfxRt0` | `$01:8042` | 2 | 2 |
| `GenericSprGfxRt1` | `$01:9D5F` | 1 | 1 |
| `GenericSprGfxRt2` | `$01:90B2` | 28 | 28 |

All eight match exactly. For these call sites the disassembly text is faithful to the ROM.

**Citations in the brief, checked.** `SubSprGfx0Entry0` at `bank_01.asm:3853`, `SubSprGfx1` at `3920`, `SubSprGfx2Entry1` at `4148`, `RexGfxRt` at `bank_03.asm:2884`, `Bank3SprHandler` label at `bank_01.asm:1126`: all correct as given.

**Hand audits, 5 of 5 passed.** `$22` ClimbingKoopa via `CODE_01BA53` (`bank_01.asm:7985` `JSR SubSprGfx1`), `$2B` SumosLightning via `CODE_02DEB0` (`bank_02.asm:12552` `JSL GenericSprGfxRt0`), `$C5` BigBooBoss via `CODE_0383A0` (`bank_03.asm:413` `JSL GenericSprGfxRt2`), `$0E` Keyhole bespoke via `CODE_01E23A` (`bank_01.asm:13277` and `13279`, two `STA OAMTileNo` writes), `$AB` Rex bespoke via `RexGfxLoopStart` inside `RexGfxRt` (`bank_03.asm:2901`).

**Known-good set.** All 16 ids the engine already covers classify SHARED. No false negatives on that set.

### What this method cannot see

- **It measures reachability, not execution.** The CFG is a sound over-approximation: it follows both sides of every branch and has no path conditions. SHARED means "some path from the handler reaches a shared draw routine", not "the sprite draws through it on a normal frame". The `DrawMarioAndYoshi` bridge is the case where that mattered and I removed it; there may be others I did not recognise, and a second reviewer should scan the per-id paths for the same shape.
- **The hybrid split is the weakest number.** I counted an id as hybrid when the routine that calls the shared draw routine also contains a `STA OAMTileNo` anywhere in its body, which does not prove both run on the same frame. The 46 is an upper bound. `$C2` and `$BE` are hand-confirmed; the rest are not.
- **Anchoring on MAIN is structurally incomplete, and `$3E` proves it.** Both `$19` and `$3E` point at `$01:E75B`, whose entire body is `LDA $1564,x / CMP #$01 / BNE +` and message-box bookkeeping (ROM bytes `BD 64 15 C9 01 D0 0C ...`, matching the disassembly exactly). Nothing in the MAIN handler for `$3E` draws anything, yet `PSwitchAppearance` exists in the TypeScript and the P-switch plainly appears on screen. Whatever draws it is outside the MAIN table, so a census anchored on MAIN cannot classify it. I did not trace that other path, and I do not know how many of the 10 NEITHER ids are in the same position rather than genuinely invisible. This is a hole in the question as posed, not only in my answer.
- **`$36` is UNDETERMINED for a concrete reason.** Its MAIN pointer targets `$01:E41F`, whose bytes are `08 F8 02 03 04 04 04 04 04 04 04 04`, a `db` table (`bank_01.asm:13516`), not code. Executing it is undefined. The disassembly comments the id as unused. Static analysis cannot say what runs, so it is not NEITHER and not BESPOKE.
- **Indirect jumps.** The CFG contains exactly one `JMP (...)` node, which I treated as a terminator. That one site is unresolved.
- **Dead code.** The reachability analysis makes no liveness judgement. An id classified SHARED via a path that the game never takes would be counted SHARED.
- **Bespoke routine names are heuristic.** For a BESPOKE id I report the enclosing label with the most `OAMTileNo` writes on the reachable set. Where the disassembly has no meaningful name, that is a `CODE_xxxxxx` label, and where a sprite has several draw states it may not be the one a reader would call "the" graphics routine. `CODE_01B7DE`/`CODE_01B7F0`, which write only `OAMTileSize`, appear on almost every sprite's reachable set and were excluded as noise.
- **One disagreement worth recording.** The 24-of-40 tile-literal figure reproduces independently, but `RipVanFishAppearance` is borderline: its `RIP_VAN_FISH_FRAMES` constants are commented as mirroring `SprTilemap[$E2..$E5]` yet are literals in the `.ts`. Scored YES. It is also one of the 7 SHARED classes, so excluding it would make the headline 6 of 24, not 7.

## Verdict

**Full replacement of the 40 bespoke classes is not viable on this evidence, and the measurement makes the reason concrete rather than impressionistic.**

The engine reaches 104 of 201 ids at best. That number is the ceiling, not the target. Subtract the 16 already covered and the 46 hybrids, and the clean remaining reach is **43 ids**. Those 43 sit in 26 families, 17 of which are singletons. Past the one cheap extension (`$08`-`$0C`, which folds into the existing `Spr0to13Gfx` factory), the work is a long tail of one-offs, which the brief correctly identifies as the condition under which this does not pay.

The decisive finding is question 3. The case for the engine rested on the 24 classes that hardcode tile literals, and the engine reaches 7 of them, 9 ids of 36 cleanly. The eight Chuck variants are the densest concentration of hardcoded tile data in the TypeScript and every one of them draws through `CODE_02CA27`, a bespoke loop. `Thwomp`, `Wiggler`, `SuperKoopa`, `SumoBrother`, `VolcanoLotus`, `WoodSpike`, `Keyhole`, `BallAndChain` and `BanzaiBill` are likewise all bespoke. Porting three shared routines does not remove the tile literals that motivated the project.

Question 2 is a smaller obstacle than framed, and a different one. The 37 behind `Bank3SprHandler` are not the boundary. 82 MAIN entries are four-byte thunks and 126 of 201 ids share a pointer value with another id, so identity-by-pointer is broken for most of the table whether or not anyone decides to walk a dispatch chain. That is an argument for keying descriptors on sprite id directly and resolving the handler by following the chain, which is mechanical: I recovered all 37 bank-3 mappings by parsing the `CMP`/`BNE` chain, and the four other multi-id stubs behave the same way. This part is tractable. It is just not where the value is.

**Realistic reach as currently designed: around 104 ids of 201 for "draws through a shared routine at all", but only about 43 ids of genuinely incremental descriptor work, concentrated in nine small families plus seventeen singletons, and displacing 7 of the 40 bespoke classes.** The honest framing is that this is a worthwhile incremental tool for a specific third of the sprite table, not a replacement architecture. If it is built, it should be scoped and justified as the former, and the 86 bespoke ids should be accepted as permanent rather than treated as a backlog. The one thing I would change about the plan regardless of the decision: the `$3E` result shows the MAIN table is not the whole draw surface, and that gap should be closed before anyone commits to a coverage target expressed as a fraction of 201.
