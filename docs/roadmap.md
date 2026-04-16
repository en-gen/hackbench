# SMW Editor — Feature Roadmap

**Goal:** An open-source, community-driven VS Code extension that fully replaces Lunar Magic as the primary Super Mario World ROM editor.

**Source of truth:** [SMWDisX](https://github.com/IsoFrieze/SMWDisX) (authoritative disassembly), SMWCentral ROM/RAM maps, SNES developer manuals (book1/book2).

---

## Phase 0 — Foundation (current)

Get the level viewer rendering correctly. Everything else builds on this.

| Feature | Status | Notes |
|---------|--------|-------|
| ROM loading + copier header detection | Done | |
| Virtual filesystem (`smwrom://`) | Done | |
| Level header parsing (5 bytes) | Done | |
| L1 object stream parsing (3-byte) | Done | |
| Object expansion → Map16 grid | Partial | ~15 handlers implemented, ~40 remaining |
| Map16 tile definitions | **Broken** | Needs tileset-aware page 0 loading |
| Map16 subtile word order | **Broken** | Column-major fix pending |
| GFX loading (LC_LZ2 → VRAM slots) | Done | 3bpp/4bpp auto-detection working |
| Palette assembly (CGRAM) | Done | All 16 rows, player variants, berry cols |
| Tile atlas rendering | Done | Will be correct once Map16 is fixed |
| Webview canvas renderer | Done | Zoom, pan, grid, block/texture modes |
| Palette panel | Done | 16x16 swatch grid |
| VRAM tile panel | Done | 8x8 char viewer |
| Map16 tile panel | Done | 512-tile browser |
| L2 background (RLE1) | Partial | Block mode only, no texture rendering |

---

## Phase 1 — Correct Rendering

Complete the viewer so every level renders pixel-accurately.

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Tileset-aware Map16 loading | Medium | `$058000` (TilesetMAP16Loc), `$0581BB` (bitmap) | Page 0 tiles vary by tileset; build dynamic lookup |
| Map16 subtile order fix | Easy | — | Swap w1/w2 (column-major: TL, BL, TR, BR) |
| Remaining object handlers | Hard | `$0DA100` (extended), `$0DA40F` (normal) in bank_0D | ~40 unimplemented object types |
| L2 texture rendering | Medium | `$05E600` (L2 pointers), bank $0D | Render L2 as textured tiles, not just blocks |
| Animated tile cycling | Medium | `$05B93B` (AnimatedTileData), 5-frame cycle | Water, lava, coins, question blocks, berries |
| Layer 3 tides/effects | Medium | `$008A79` (Layer3TilemapSettings) | Parallax, water level overlays |
| Correct sprite rendering | Hard | Banks $01-$03 sprite routines | Show sprite graphics instead of red squares |

---

## Phase 2 — Read-Only Browsing & Inspection

Make the extension a comprehensive ROM analysis tool.

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Music track listing | Easy | Level header byte 2 [6:4], `$0EAED6` (music banks) | Tree view lists all tracks; levels show their track |
| Music playback (SPC700) | Medium | `$008165` (UploadLevelMusic) | JS/WASM SPC player; play tracks from UI |
| Overworld map viewer | Hard | Bank $0C (OW tilemaps), `$04D678` (exit dirs) | Render the 7 overworld submaps |
| Level interconnection graph | Medium | `$05F800` (secondary exits), sprite exit data | Show how levels connect via pipes/doors |
| Sprite browser | Easy | `$00A8C3` (sprite GFX assignment) | List all sprite types with their graphics |
| GFX file browser (all 50) | Easy | `$00B992/$00B9C4/$00B9F6` (GFX pointers) | Browse/inspect every GFX file |
| ROM statistics dashboard | Easy | Various | Level count, free space, GFX usage, etc. |
| Tileset comparison view | Easy | `$058000` (TilesetMAP16Loc) | Side-by-side tileset Map16 differences |

---

## Phase 3 — Level Editing (Write Support)

The core editing experience. This is what replaces Lunar Magic's primary function.

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Level header editing | Easy | 5-byte header at L1 data start | UI controls for all header fields |
| Object placement/removal | Medium | L1 object stream format (3-byte entries) | Click to place, drag to size, delete |
| Sprite placement/removal | Medium | Sprite data format (3-byte entries at $05EC00) | Place sprites from catalog |
| Undo/redo stack | Medium | — | In-memory edit history |
| Save modified level to ROM | Hard | Must rewrite object stream, update pointer table | Write back to ROM file preserving structure |
| Map16 tile picker | Easy | Map16 panel integration | Click a Map16 tile to use as brush |
| Screen management | Medium | Header byte 0 [4:0] (screen count) | Add/remove screens, resize levels |
| Secondary exit editing | Hard | `$05F800`+ (exit tables) | Configure pipe/door destinations |
| Midway point placement | Easy | Item memory bit flags | Toggle midway checkpoints |

---

## Phase 4 — Graphics & Palette Editing

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Palette color picker | Easy | `$00B0A0`+ (palette tables) | Edit individual BGR555 colors |
| Per-level custom palettes | Medium | `$0EF600` (LM palette pointers) | Level-specific palette overrides |
| GFX tile editor (pixel art) | Medium | GFX files in banks $08-$0B | Edit 8x8 tiles with palette-aware drawing |
| Map16 tile editor | Medium | `$0D8000`+ (Map16 data) | Edit which 4 subtiles compose a Map16 tile |
| ExGFX import/export | Medium | Requires free space management | Import custom 3bpp/4bpp tile sheets |
| Tileset configuration | Hard | `$058000`, `$0581BB`, `$00A92B` | Assign GFX files to VRAM slots per tileset |

---

## Phase 5 — Overworld Editing

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Overworld tile editing | Hard | Bank $0C tilemaps | Edit the 7 submap backgrounds |
| Level dot placement | Medium | OW level position tables | Position level markers on map |
| Path/event editing | Hard | `$04D678` (exit dirs), event tables | Configure paths that appear after level clear |
| Submap transitions | Medium | Border tile triggers | Configure how maps connect |

---

## Phase 6 — Audio

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Music track editor | Hard | SPC700 format in banks $0E+ | Visual music sequencer |
| Custom music import (AddmusicK) | Hard | Community standard format | Import .txt music files |
| Sound effect browser | Medium | SPC port 0/1 commands | Play/preview all SFX |
| Per-level music assignment | Easy | Header byte 2 [6:4] | Dropdown with preview playback |

---

## Phase 7 — ROM Expansion & Advanced

| Feature | Complexity | ROM Reference | Description |
|---------|-----------|---------------|-------------|
| Free space manager | Medium | `freespace.txt` in SMWDisX | Track used/free ROM areas |
| ROM size expansion (1MB→2MB+) | Hard | Pointer table relocation | SA-1 pack or HiROM expansion |
| Custom ASM patch application | Hard | Standard SMW patch format (.asm) | Apply community patches |
| Custom sprite insertion | Hard | Sprite tool format | Import custom sprite behaviors |
| Custom block insertion | Hard | Block tool format | Import custom block behaviors |
| UberASM support | Hard | Community standard hooks | Per-level custom code hooks |

---

## Phase 8 — SMWCentral Integration

Connect to the SMWCentral API to offer a built-in library of community resources.

| Feature | Complexity | Description |
|---------|-----------|-------------|
| SMWCentral API client | Medium | Browse/search the SMWCentral sections catalog |
| Patch browser & installer | Medium | Browse ASM patches, preview descriptions, one-click apply |
| Custom sprite library | Medium | Browse sprites, preview GFX, insert into ROM |
| ExGFX library | Easy | Browse/download custom graphics, assign to tilesets |
| Custom music library | Medium | Browse AddmusicK tracks, preview audio, insert |
| Custom block library | Medium | Browse blocks, preview behavior, insert |
| UberASM library | Medium | Browse per-level ASM code, apply to levels |
| Tool/utility integration | Easy | Surface relevant community tools from within the editor |
| Upload/publish to SMWCentral | Hard | Submit patches/resources directly from the editor |

---

## Phase 9 — Polish & Community

| Feature | Complexity | Description |
|---------|-----------|-------------|
| Project file format | Medium | Save editor state, bookmarks, notes per ROM |
| Collaborative editing | Hard | Git-based ROM change tracking |
| Patch export (IPS/BPS) | Easy | Generate distributable patches |
| Lunar Magic compatibility | Medium | Read/preserve LM-specific data |
| Extension marketplace publish | Easy | Package and distribute via VS Code |
| Plugin API for community tools | Hard | Let others extend the editor |
| Documentation & tutorials | Medium | SMWCentral wiki integration |

---

## Lunar Magic Feature Parity Checklist

Features Lunar Magic supports that we need to match or exceed:

| LM Feature | Our Phase | Status | Notes |
|------------|----------|--------|-------|
| **Level Editing** | | | |
| Point-and-click L1/L2 editor | Phase 3 | Not started | WYSIWYG object/tile placement |
| Drag/drop level elements | Phase 3 | Not started | |
| Clipboard (copy/paste level sections) | Phase 3 | Not started | |
| Exit & destination editor | Phase 3 | Not started | Secondary entrance/exit configuration |
| Time limit & music setting | Phase 3 | Not started | Header field editing |
| Screen management (add/remove) | Phase 3 | Not started | |
| External level file save/load (MWL) | Phase 3 | Not started | Import/export individual levels |
| Dynamic level height adjustment | Phase 3 | Not started | Added in LM v3.00 |
| **Graphics** | | | |
| 8x8 tile editor | Phase 4 | Not started | Pixel-level GFX editing |
| 16x16 Map16 block editor | Phase 4 | Not started | Compose 4 subtiles + attributes |
| Extended GFX viewing | Phase 4 | Not started | ExGFX file support |
| 4x more Map16 pages | Phase 4 | Not started | LM v1.70 expanded Map16 |
| ExGFX file support | Phase 4 | Not started | Custom graphics beyond vanilla 50 |
| Background import (Pic2SNES) | Phase 4 | Not started | Import images as BG graphics |
| VRAM rearrangement | Phase 4 | Not started | Increased graphics tile capacity |
| **Palettes** | | | |
| Palette editor (color picker) | Phase 4 | Not started | |
| Per-level custom palettes | Phase 4 | Not started | |
| **Sprites** | | | |
| Sprite placement GUI | Phase 3 | Not started | |
| Custom sprite support | Phase 7 | Not started | |
| **Overworld** | | | |
| Point-and-click OW editor | Phase 5 | Not started | |
| OW path editor | Phase 5 | Not started | |
| OW event editor | Phase 5 | Not started | |
| OW sprite editing | Phase 5 | Not started | Calendar-based sprite changes |
| OW layer 1 + layer 2 editing | Phase 5 | Not started | |
| OW animation support | Phase 5 | Not started | |
| **Title/Credits** | | | |
| Title screen FG editor | Phase 5 | Not started | |
| Title screen movement recording | Phase 5 | Not started | Record Mario's demo walk |
| Credits scene tile editor | Phase 5 | Not started | |
| **Text** | | | |
| Overworld level name editor | Phase 5 | Not started | |
| Message box text editing | Phase 3 | Not started | Yellow switch palace messages etc. |
| **Animation** | | | |
| ExAnimation system | Phase 1 | Not started | Extended animated tile support |
| Level-specific tile animation | Phase 1 | Not started | Per-tileset animation groups |
| Level-specific palette animation | Phase 4 | Not started | Animated palette cycling |
| **ROM/System** | | | |
| ROM header name modification | Phase 9 | Not started | |
| SA-1 patch support | Phase 7 | Not started | Performance enhancement patch |
| ASM ROM modifications | Phase 7 | Not started | Custom code patches |
| Hack locking | Phase 9 | Not started | Protect ROM from re-editing |
| Castle demolition sequences | Phase 5 | Not started | Event cutscene editing |
| **Testing** | | | |
| Internal emulator (test in editor) | Phase 9 | Not started | LM uses libretro; we could too |

---

## Parallelization Strategy

Features that can be developed independently on separate branches/worktrees:

**Independent tracks (no shared code changes):**
- Music listing + playback (new provider, new webview)
- Overworld viewer (new provider, new webview)
- Sprite browser (new provider, new webview)
- ROM statistics dashboard (new provider)

**Sequential (must build on Phase 1):**
- Animated tiles (needs correct VRAM loading)
- Level editing (needs correct rendering)
- GFX/palette editing (needs correct tile display)

---

## Technical Advantages Over Lunar Magic

| Aspect | Lunar Magic | This Project |
|--------|------------|--------------|
| Platform | Windows-only (Win32) | Cross-platform (VS Code) |
| Source | Closed, single maintainer | Open source, community |
| UI framework | Custom Win32 GDI | Modern web (HTML5 Canvas, CSS) |
| Extensibility | None | VS Code extension API + potential plugin system |
| Distribution | Manual download | VS Code Marketplace |
| Version control | Manual ROM copies | Git-native (IPS/BPS diffs) |
| Collaboration | Share ROMs | Share patches, PRs |
| Documentation | Embedded help | Markdown, wiki, in-editor |
