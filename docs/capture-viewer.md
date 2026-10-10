# Capture viewer: evidence behind the checks

The capture viewer (`tools/scripts/render_capture.ts`, how to run it in
[testing.md](testing.md#viewing-mesen-per-map-captures)) checks each map two
ways: map data against the SNES tilemap, and our drawing code against
Mesen's per-layer pictures. This page holds the derivations and
measurements its code cites in one line. Measurements are from one machine
with Mesen 2.x unless stated.

## REF_DY

`capture_draw.ts` `REF_DY = 1`: the first visible line shows map row
camera Y + 1, for BGs and OBJ alike. "A sprite with Y=0 will appear to
begin on the first visible line" while a BG scrolled to 0 has "its top
pixel cut off by the hidden line" (snes.nesdev.org/wiki/Sprites, OAM
section).

Measured on `$105` (captures/review) against the isolated layer renders:
at +1 the Foreground differs from `layer_bg1.png` in 0 of 13,962 opaque
pixels (2,681 at 0), and the Background from `layer_bg2.png` in 0 of
43,191 (9,098 at 0); over the whole 256x224 window both differ in 0 of
57,344. Earlier content-paired captures of 6 more maps agree. BG3 could not
be measured there, since its status bar rows use a mid-frame scroll. OBJ
favors +1 (245 of 382 sprite pixels match, 129 at 0), but sprites move
between the sample and the render, so for OBJ the +1 rests on the citation.

## Strip window

`capture_decode.ts` `checkBg1`: every BG1 cell of every strip the PPU holds
must carry, in VRAM, the word grid + defs give for that map coordinate.

- BG1HOFS/VOFS are Layer1XPos/YPos (`bank_00.asm:296-306`), so map
  coordinates index the tilemap directly, modulo its size.
- CODE_05877E sets Layer1TileUp to the camera's strip - 8 and
  Layer1TileDown to + $17 (`bank_05.asm:897-904` horizontal, `936-945`
  vertical).
- At load the game uploads 32 strips from TileUp on (`bank_05.asm:103-143`:
  TileDown = TileUp, then UploadOneMap16Strip and INC until LevelLoadObject
  reaches $20); scrolling uploads the edge strip the camera crosses into,
  which keeps the same 32. A strip is the whole column (row loop to $1B0,
  `bank_05.asm:1140-1241`).
- One strip is trimmed at each end, because an upload trails the camera by
  up to a frame.

Object Layer 2 is checked the same way against BG2, with the window taken
from Layer2XPos/YPos (`bank_05.asm:952-964` horizontal, `967-980`
vertical). Layer2X/Y are what the NMI writes to BG2 scroll
(`bank_00.asm:307-314`), so the capture must record them; a missing one
refuses the Background rather than assuming 0.

Known limit: the Layer 2 check has no blind-spot analysis. The Foreground
check reports `weak` when a shifted or re-strided grid would also have
matched; the Layer 2 check does not try those misplacements, so a Layer 2
grid too uniform to catch them still reads as a plain pass.

The output-folder checks follow junctions and symlinks (the real path of
the nearest existing folder), so a link cannot place pages inside the
captures or the repo.

## Backdrop

`capture_decode.ts` `backdropRgb`: with CGADSUB bit 5 set, CGRAM color 0
has the fixed color from COLDATA added (bit 7 clear) or subtracted (bit 7
set), each 5-bit channel clamped to 0..31. The fixed color is the
subscreen's own backdrop when CGWSEL bit 1 selects the subscreen and the
only source when it does not; either way the "Div2" half (CGADSUB bit 6)
is not applied to it. CGWSEL bits 4-5 enable math (0 always, 3 never) and
bits 6-7 force the main screen black (0 never, 3 always); the
window-dependent values 1 and 2 cannot be resolved without the window
registers, so the backdrop is reported as unavailable. Sources: fullsnes
"SNES PPU Color-Math" (ports 2130h-2132h, "Div2 ... ignored on transparent
subscreen pixels (those use the fixed color as sub-screen backdrop)");
clamping per snes.nesdev.org/wiki/Color_math. SMW writes its sky color to
COLDATA (`bank_00.asm:5868-5883`), not to CGRAM.

## Status bar band

Above the status-bar interrupt the SNES draws BG3 at the bar's scroll, not
the playfield's, so those picture lines are not map data and Effects is
compared below them. The line is the V-timer the game writes
(`bank_00.asm:330-333`), recorded per picture as `statusBar.irqLine`. The
IRQ handler writes the playfield scroll during that scanline, and picture
line y shows scanline y + 1, so lines 0..V are left out. The band applies
to BG3 only. A picture whose band covers every line compares nothing, and
its layer reads as not compared.

## GenerateTile

A GenerateTile call reaches a picture only from the next frame: on
layers_v4 `$01C` and `$116` every call stamped with a picture's own frame
was not yet in that picture's VRAM (5 calls, 3 pictures). A window
therefore replays the calls stamped strictly before its frame.

## OBJ Y offset

`pieceOffset` reads an OAM Y of $E0 or more as a line above the top edge
(y - 256, the same rule as `oamEntry`) and does not wrap the offset from the
sprite, so a piece more than 128 lines away keeps its distance (#811).
Evidence: synthetic sweeps in `CaptureOracle.synthetic.test.ts`; no real
capture was re-rendered for this change.
