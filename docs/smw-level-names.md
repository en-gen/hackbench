# SMW Level Name System

## Overview

SMW stores **no ASCII level names** in the ROM. All on-screen level name text
is assembled at runtime from a pool of **word tokens** stored as tile-encoded
byte strings. A separate composition table maps each overworld level slot
(translevel $00–$5F) to an ordered sequence of token IDs, which the game
concatenates to produce the displayed name.

---

## Encoding

All text in the name token table uses a 0-based letter index:

| Tile byte | Character |
|-----------|-----------|
| $00       | A         |
| $01       | B         |
| …         | …         |
| $19       | Z         |
| $5D       | ' (apostrophe) |
| $9F       | terminator / word boundary |
| $1F       | space within a composed name |
| $1C       | space (seen inside "CHOCOLATE GHOST HOUSE") |

This encoding is distinct from the internal ROM header (which is plain ASCII)
and from the SNES CGRAM tile indices used for general gameplay text.

---

## Word Token Table

**ROM location confirmed:** file offset `$021CC5`, SNES address `$049AC5`  
(bank $04, LoROM mapping — `bank*$8000 + addr - $8000 + header`)

Found by brute-force encoding scan in `scripts/find-yoshi-house.mjs`.  
Verified: bytes `18 0E 12 07 08` at that offset decode to `YOSHI` under
A=$00 encoding.

### Token list (parsed)

Each token is a variable-length byte string terminated by $9F (or a
non-decodable byte). Tokens are separated by sequences containing `$5A`
followed by an incrementing counter byte ($64, $65, $66, …).

The following tokens were identified (token IDs assigned sequentially from
the parser; **IDs must be verified against the composition table before use**):

| Approx ID | Text                  | Notes                            |
|-----------|-----------------------|----------------------------------|
| 0         | YOSHI'S               |                                  |
| 1         | STAR                  | used in "STAR WORLD"?            |
| 2         | IGGY'S                | Koopa Kid                        |
| 3         | MORTON'S              | Koopa Kid                        |
| 4         | LEMMY'S               | Koopa Kid                        |
| 5         | LUDWIG'S              | Koopa Kid                        |
| 6         | ROY'S                 | Koopa Kid                        |
| 7         | WENDY'S               | Koopa Kid                        |
| 8         | LARRY'S               | Koopa Kid                        |
| 9         | DONUT                 |                                  |
| 10        | GREEN                 |                                  |
| 11        | TOP SECRET AREA       | full phrase stored as one token  |
| 12        | VANILLA               |                                  |
| 13        | RED                   |                                  |
| 14        | BLUE                  |                                  |
| 15        | BUTTER BRIDGE         | full phrase                      |
| 16        | CHEESE BRIDGE         | full phrase                      |
| 17        | SODA LAKE             | full phrase                      |
| 18        | COOKIE MOUNTAIN       | full phrase                      |
| 19        | FOREST                |                                  |
| 20        | CHOCOLATE             |                                  |
| 21        | CHOCOLATE GHOST HOUSE | full phrase (with $1C mid-space) |
| 22        | SUNKEN GHOST SHIP     | full phrase                      |
| 23        | VALLEY                |                                  |
| 24        | BACK DOOR             | full phrase                      |
| 25        | FRONT DOOR            | full phrase                      |
| 26        | GNARLY                | Special World level name         |
| 27        | TUBULAR               |                                  |
| 28        | WAY COOL              |                                  |
| 29        | HOUSE                 | suffix: YOSHI'S HOUSE            |
| 30        | ISLAND                | suffix: YOSHI'S ISLAND 1         |
| 31        | SWITCH PALACE         | full phrase                      |
| 32        | CASTLE                | suffix: IGGY'S CASTLE            |
| 33        | PLAINS                | suffix: DONUT PLAINS             |
| 34        | GHOST HOUSE           | full phrase                      |
| 35        | SECRET                |                                  |
| 36        | DOME                  | suffix: VANILLA DOME             |
| 37        | FORTRESS              |                                  |
| 38        | OF BOWSER             | suffix: VALLEY OF BOWSER         |
| 39        | ROAD                  |                                  |
| 40        | WORLD                 | suffix: STAR WORLD               |
| 41        | AWESOME               | Special World level name         |
| 42+       | GROOVY, MONDO, OUTRAGEOUS, FUNKY, PALACE, AREA, … | partial — need pointer table verification |

**Note:** token IDs above are sequential parser assignments, NOT the game's
internal IDs. The actual IDs used in the composition table are determined by
the pointer table at `$021E95` (see below). Do not use these IDs in code
until verified.

---

## Pointer Table

**ROM location (observed):** file offset `$021E95`

Contains 16-bit little-endian values. Each value is a byte offset from the
start of the token table (`$021CC5`) pointing to a specific token's first byte.

First entry = `$0008` → `$021CC5 + $0008 = $021CCD` → "STAR" token.

This table allows the runtime to look up any token by its index without
scanning the variable-length token list sequentially.

**Verification status:** partially observed, not fully decoded.  
Run `node scripts/decode-level-names.mjs <rom>` to dump the full table.

---

## Composition Table (PENDING)

**Status: location not yet confirmed.**

There must be a table mapping translevel slot → ordered list of token IDs
(e.g., translevel $00 → [YOSHI'S, HOUSE] → "YOSHI'S HOUSE").

Candidate search results from `decode-level-names.mjs` need review to
confirm the composition table address.

Once found, the full mapping of 96 overworld levels to their displayed names
can be read directly from the ROM.

---

## Investigation Scripts

| Script                              | Purpose                                      |
|-------------------------------------|----------------------------------------------|
| `scripts/find-overworld-names.mjs`  | 4-pass initial scan (ASCII, tile, LZ2, banks) |
| `scripts/find-yoshi-house.mjs`      | Brute-force tile encoding search for YOSHI   |
| `scripts/dump-name-table.mjs`       | Hex dump of the hit region + nearby pointer table |
| `scripts/decode-level-names.mjs`    | Clean token parse + composition table search  |

---

## Next Steps

1. Confirm pointer table structure at `$021E95` (what index maps to what token)
2. Find the composition table (level → token ID sequence)
3. Read the composition table for all 96 translevel slots
4. Confirm "YOSHI'S HOUSE" = tokens [YOSHI'S, HOUSE] and identify its translevel
5. Build `src/rom/SmwLevelNames.ts` from ROM data (no hardcoding)
