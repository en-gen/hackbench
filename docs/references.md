# External references

HackBench draws on published SNES and SMW documentation written by other
people. Those works are not reproduced here: this file records which source
answers which question, so the lookup is one click away without HackBench
redistributing someone else's writing under its own MIT license.

Anything in `docs/` other than this file is HackBench's own work: derivations
traced against the cart, design proposals, or records of what the code does.

## SMW specifics

| Question | Source |
|---|---|
| RAM and ROM address meanings, the canonical community map | SMW Central memory map, https://smwc.me/memorymap (per-address permalinks take the form `https://smwc.me/m/smw/ram/7E0000`) |
| Level and overworld data formats | https://smwspeedruns.com/Level_Data_Format and https://smwspeedruns.com/Overworld_Data_Format |
| Level data format, second opinion | https://sneslab.net/wiki/SMW_level_data_format |
| ROM map annotations and regional differences | https://datacrystal.tcrf.net/wiki/Super_Mario_World |
| Routine-level behaviour, the authority for this project | SMWDisX disassembly, https://github.com/IsoFrieze/SMWDisX (local checkout at `C:\Projects\SMWDisX`) |

For anything about what the game *does*, SMWDisX is the source of truth. See
the "ROM is a collection of lookup tables" section of `CLAUDE.md`: trace the
disassembly to find the index, then read the table from the cart.

## SNES hardware

| Question | Source |
|---|---|
| PPU, memory map, DMA/HDMA, SPC700, cartridge formats | Super Famicom Development Wiki, https://wiki.superfamicom.org/ (palettes, sprites, backgrounds, windows, rendering-the-screen) |
| System architecture overview, readable narrative | Rodrigo Copetti, *Super Nintendo Architecture*, https://copetti.org/writings/consoles/super-nintendo/ |
| PPU registers, VRAM layout, data formats, DMA | Qwertie's SNES documentation (qsnesdoc), https://www.raphnet.net/divers/retro_challenge_2019_03/qsnesdoc.html |
| Graphics formats and tile encoding, tutorial framing | Mega Cat Studios SNES graphics guide, https://megacatstudios.com/blogs/retro-development/super-nintendo-graphics-guide |
| Register-level detail and timing | SNESdev Wiki, https://snes.nesdev.org/wiki/ and SnesLab, https://sneslab.net/wiki/ |
| Authoritative hardware specification | Nintendo SNES Development Manual Books I and II (1993 to 1995). Not linked: it is Nintendo's copyrighted documentation, widely archived but not ours to redistribute. |

The project-wide SNES rulebook for addressing, BGR555 and VRAM layout lives at
`C:\Projects\SMWDisX\.claude\rules\snes-global.md`.

## Why this file exists instead of the documents

`docs/` previously carried about 1.5 MB of these works copied in full,
including a verbatim HTML capture of the SMW Central memory map. Each copy
cited its source in a header, which is the right instinct, but a citation is
not a license. Publishing them would have offered other people's writing, and
in one case Nintendo's manual, to everyone under HackBench's MIT license.
