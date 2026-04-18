# SMW ROM Map - ASM Entry Points

Source: SMW Central (smwcentral.net), authoritative community reference.

## Bank $00 - System Init, Main Loop, Core Routines

| Address | Size | Description |
|---------|------|-------------|
| $008000 | 39 | Game starting address. Basic init (disable IRQ/HDMA/DMA, F-blank, stack setup) |
| $008027 | 43 | OAM clear routine upload to $7F8000 |
| $008052 | 25 | Main init (SPC upload, OAM/windowing setup, RAM clear) |
| $00806B | 14 | **Main game loop**. Waits for V-blank, increments frame counter $13 |
| $008179 | 49 | SPC700 I/O transfers (sound) |
| $008A79 | 59 | VRAM register setup for normal levels ($2107=$23, $2108=$33, $2109=$53, $210B=$00, $210C=$04) |
| $0091DB | 1 | Mario/Luigi Start switch |
| $00968E | 32 | Game mode $10 (black period between OW fadeout and Mario Start) |
| $0096AE | 158 | Game mode $03 (Load Title). Music bank at $0096C4, title level at $0096CC |
| $009C6A | 1 | Save menu trigger |
| $009C82 | 3 | Title screen movement disable |
| $009C87 | 1 | Title screen loop control |
| $009C9F | 4 | Title screen sprite disappear on button press |
| $009CAD | 3 | HDMA disable on file menu |
| $009E35 | 2 | Powerup at game start ($19 = #$00 = small Mario) |
| $00A0F9 | 1 | Post-death routine (zero lives) |
| $00A1E3 | 1 | Message box game pause control |
| $00A21F | 1 | Pause disable |
| $00A390 | 1 | Animation disable (including colour 64) |
| $00A635 | 353 | **Level init routine**. Resets timers, clears RAM $71-$93/$13DA-$1410, No-Yoshi setup, entrance actions. $00A6B6=No-Yoshi, $00A6CC=regular level |
| $00AA76 | 1 | Koopa GFX after special world |
| $00AF35 | 4 | Level beat fade-out |
| $00AF39 | 1 | Level beat fade-out (boss warning) |
| $00C0C1 | 58 | **Map16 page 1 tile generation**. $00C0C4=alternate entry (no item memory) |
| $00C0FB | 177 | **Map16 tile graphics change routine**. Used by both $00C074 and $00C0C1 |
| $00C5CE | 3 | HDMA disable on freeze animation |
| $00C9FE | 3 | Normal/secret exit info |
| $00CB0C | 1 | HDMA goal tape fix |
| $00CD4E | 4 | Climb while holding item |
| $00D0D5 | 3 | Yoshi pit loss |
| $00D0D8 | 3 | Life loss handler |
| $00D0F1 | 1 | TIME UP message |
| $00D11A | 1 | Death flip |
| $00D156 | 5 | Mushroom→1up |
| $00D604 | 1 | Ducking disable |
| $00D61C | 2 | Jumping disable |
| $00D63E | 1 | Spin Jump disable |
| $00D645 | 1 | Spin Jump disable (alternate) |
| $00D65E | 10 | Mario jumping routine (sound + Y speed) |
| $00D717 | 1 | Running disable |
| $00D998 | 1 | Swimming Y speed with item |
| $00DA37 | 1 | Underwater ducking disable |
| $00DB9A | 1 | Climbing jump disable |
| $00E35D | 3 | Mario vertical offset while walking |
| $00E364 | 1 | Mario wall-run vertical offset |
| $00E385 | 308 | **Mario GFX routine**. Pose table at $00E3AA, cape powerup at $00E3FE |
| $00EA08 | 3 | Stuck-in-block kill prevention |
| $00EB79 | 2 | Mario interaction field size |
| $00EE69 | 2 | Small Mario spin jump turn blocks |
| $00EEF8 | 3 | Sliding while holding item |
| $00F2BB | 3 | 1up checkpoint re-entry |
| $00F325 | 3 | Moon reappear on re-entry |
| $00F332 | 69 | **Yoshi coin collection handler**. Counter at $00F343, max at $00F34A |
| $00F79D | 13 | Layer 2 horizontal scroll settings |
| $00F7AA | 24 | Layer 2 vertical scroll settings |
| $00FB53 | 5 | Goal point 1UP spawn |

## Bank $01 - Sprites

| Address | Size | Description |
|---------|------|-------------|
| $01836A | 1 | Wooden spike direction |
| $0184C6 | 4 | Lakitu cloud spawn disable |
| $01851C | 3 | Diggin' Chuck direction |
| $01962A | 49 | Bob-omb flash/explode |
| $0196C6 | 1 | Shell hop prevention |
| $019913 | 8 | Sprite kick routine |
| $019FA7 | 5 | P-Balloon timer |
| $01A1E1 | 4 | Throw block flash disable |
| $01A716 | 1 | Blue Koopa shell kick |
| $01A78D | 1 | Blue Koopa shell stop |
| $01AA15 | 1 | Koopa shelless spawn prevention |
| $01AA5C | 1 | Item carry disable |
| $01AEC7 | 1 | Thwomp off-screen drop |
| $01C42C | 3 | Coin/star movement disable |
| $01CACB | 85 | Sprite rotation prep |
| $01CB20 | 51 | Global rotation prep |
| $01CB53 | 330 | **Global rotation routine** |
| $01CCC7 | 35 | Mode 7 rotation prep |
| $01CE3E | 2 | Ludwig appear slowdown |
| $01D6ED | 3 | Line-guided sprite speed |
| $01D77D | 1 | Line-guided speed swap |
| $01D7A1 | 1 | Line-guided speed swap (pair) |
| $01E1F9 | 1 | Multiple key fix |
| $01E20A | 1 | Multiple key fix (pair) |
| $01E20F | 1 | Multiple key fix (pair) |
| $01E522 | 11 | Dry Bones bone throw (level check) |
| $01E59C | 11 | Dry Bones bone throw timer |
| $01EB16 | 4 | Yoshi duck fix |
| $01ED6D | 3 | Yoshi hop stomp glitch fix |
| $01F0BA | 3 | Yoshi tongue freeze glitch fix |
| $01F26A | 9 | Yoshi fire breath (red shell) |
| $01F273 | 9 | Red Yoshi fire breath |
| $01F360 | 3 | Yoshi eat sprite routine |
| $01FC70 | 1 | Iggy/Larry left bound |
| $01FC74 | 1 | Iggy/Larry right bound |
| $01FCC6 | 1 | Iggy/Larry invincibility timer |

## Bank $02 - More Sprites, Blocks

| Address | Size | Description |
|---------|------|-------------|
| $028528 | 103 | Lava splash subroutine. Objects at $028540 |
| $028A03 | 4 | Flying red coin / Yoshi wings |
| $028A08 | 2 | Shell from blocks stun timer |
| $0290C0 | 3 | Turn block spin timer |
| $029FDB | 1 | Fireball object pass-through |
| $02A124 | 31 | Sprite→coin on fireball hit |
| $02A988 | 1 | Koopa shell color after special world |
| $02B495 | 2 | Bullet Bill shooter proximity |
| $02B78D | 1 | Pokey head/body swap |
| $02C7E2 | 6 | Chuck stomp immunity |
| $02D421 | 1 | Layer 3 smasher crash fix |
| $02DA94 | 3 | Amazing Flyin' Hammer Bros turn |
| $02DBD7 | 3 | AFHB platform vertical movement |
| $02DBDA | 3 | AFHB platform horizontal movement |
| $02EAF2 | 4 | Super Koopa feather spawn |
| $02EB19 | 4 | Super Koopa feather spawn (pair) |

## Bank $03 - More Sprites, Bosses

| Address | Size | Description |
|---------|------|-------------|
| $038580 | 1 | Porcu-Puffer behavior |
| $03866F | 1 | Flying Grey Turnblock bug fix |
| $038932 | 3 | Mega Mole animation disable |
| $03989F | 4 | Reznor bridge breaking |
| $0398C7 | 2 | Reznor rotation direction |
| $0399EE | 1 | Reznor platform standability |
| $039D61 | 1 | Dino-Torch fire direction |
| $039D97 | 1 | Dino-Torch fire damage |
| $03CED0 | 3 | Lemmy/Wendy sprite death on stomp |
| $03E016 | 5 | Bowser battle lightning sound |

## Bank $04 - Overworld

| Address | Size | Description |
|---------|------|-------------|
| $04828D | 2 | Lives Exchanger disable |
| $048769 | 3 | Inactive player on map |
| $048EEB | 3 | OW water tiles |
| $048F93 | 1 | OW save prompt tile |

## Bank $05 - Level Loading

| Address | Size | Description |
|---------|------|-------------|
| $0580D5 | 3 | Pipe colours (horizontal levels). Must match $0587A4 |
| $0587A4 | 3 | Pipe colours (pair of $0580D5) |
| $05BEA6 | 3 | Layer 2 sideways scroll horizontal disable |
| $05C4F2 | 6 | Layer 3 tide scroll direction |
| $05CD79 | 1 | Course Clear bonus counter disable |
| $05CDD8 | 1 | Course Clear drumroll/timer disable |
| $05CF1B | 3 | Bonus stars disable |

## Bank $07 - Effects

| Address | Size | Description |
|---------|------|-------------|
| $07FC3B | 85 | Spin Jump Star GFX subroutine. Objects at $07FC53 |

## Bank $0C - Credits

| Address | Size | Description |
|---------|------|-------------|
| $0C93B6 | 1 | Yoshi's House replay after credits |
| $0C9FF8 | 2 | Credits powerup status |

## Bank $0D - Object Handlers

| Address | Size | Description |
|---------|------|-------------|
| $0DA78D | 33 | Bush object decoding routine |
| $0DA8A6 | 8 | Bitmasking table ($80,$40,$20,$10,$08,$04,$02,$01) |
