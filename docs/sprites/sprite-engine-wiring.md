# Sprite draw engine: editor wiring (scaffolding)

`e3700ad` landed `SpriteDrawEngine` as a pure, purely additive module: nothing
imported it, so nothing rendered through it. This note records how it was
wired into the map editor for visual comparison, and what is disposable.

Evidence scope for every ROM claim below: static reads of the six ROM files in
`test/roms/` plus traces against `C:\Projects\SMWDisX`. No emulator was run.

## THIS IS SCAFFOLDING

The `Sprite engine` toolbar button is a **temporary comparison control**, not a
feature. It exists so one person can click back and forth on one map and see
whether the engine draws what the shipped classes draw. It is deliberately:

- **default OFF**, so the shipped render path is untouched unless asked;
- **not persisted** anywhere, and deliberately not a `hackbench.*` setting;
- absent from user-facing docs, because there is no user for it.

When the engine becomes the only sprite render path, four things delete
together and nothing else has to change:

1. `src/rom/model/sprites/generic/EngineSpriteAppearance.ts`
2. `Sprite.engineAppearance` and the branch in `Sprite.render`
3. `editorStore.spriteEngine` / `spriteEngineMarkers` and their actions
4. the two toolbar buttons and their handlers in `src/webview/mapEditor/main.ts`

Do not build on it. A persistent user preference, such as an annotations
on/off switch, belongs in settings and has a different lifetime.

## Where the seam is

`rehydrate.buildGraph`, on the **webview** side. That is where the map the user
looks at is built, and it already has both the rehydrated `chars` map and a
live `RomFile` (the host ships ROM bytes in the `load` message and the webview
caches them as `cachedRom`).

`attachEngineAppearances(sprites, rom, chars, placeholder)` walks the
rehydrated sprites, and for each one with a traced descriptor hangs an
`EngineSpriteAppearance` off `sprite.engineAppearance`, capturing the shipped
appearance as its fallback. Sprites with no descriptor are left alone.

`Sprite.render` then picks the engine appearance when `editorStore.spriteEngine`
is set and one is attached, otherwise the shipped one. The store read is
unconditional so the reactive render effect tracks the toggle even on a pass
where no engine appearance is attached. `renderModelOverlay` also registers both
flags at top level, for the same reason the existing code registers `cursorPx`
there: a nested read inside `Sprite.render` never happens on a pass with the
sprites layer toggled off, and the dependency would be lost.

This crossing is the thing that historically fails silently in this codebase,
so it is asserted directly in `test/suite/unit/sprites/SpriteEngineWiring.test.ts`,
which serializes a real level the host way and rehydrates it the webview way
rather than constructing the appearance by hand.

## Animation

Engine sprites advance on the existing sprite timer, not a second one.
`Sprite.tickAnimation` ticks the shipped appearance and the engine appearance
in turn; `EngineSpriteAppearance.tickAnimation` adds `ROM_FRAMES_PER_TICK`
(7.5 game frames per 125 ms editor tick) to its own free-running game-frame
counter. The engine appearance never ticks its fallback, so nothing is
double-advanced.

Facing stays a render-time input: `marioX` comes from `mapStore.marioSpawnX`
and `spriteX` from the sprite's own level-pixel X, both read per draw.

## Identification

Engine-drawn sprites get four L-shaped corner ticks, 3 px, drawn in a fixed
editor blue outside the sprite's own pixels. Corner ticks rather than a full
outline so the sprite is not boxed in and the mark cannot be confused with the
tile-grid overlay. The sprite is never tinted or recolored, because color is
exactly what the comparison is looking at. The second toolbar button hides the
ticks so a clean color read is available; it appears only while the engine
toggle is on and does not change a single sprite pixel.

## Honest degradation

`describeHandlerProvenance` (`SpriteHandlerProvenance.ts`) compares the ROM's
MAIN and INIT pointers for a sprite against the handlers its descriptor was
traced from. `EngineSpriteAppearance` resolves it once at construction. On any
divergence the engine declines to draw: the shipped appearance is drawn instead
and the sprite gets AMBER corner ticks plus a filled pip, so the marker
states are distinguishable without relying on hue. One `console.warn` per
sprite id carries the message, including which pointer moved and to where.

There are THREE marker states, not two:

| Marks | Meaning | Actionable? |
|---|---|---|
| blue ticks | the engine drew this sprite | n/a |
| amber ticks + pip | the ROM repointed the handler, shipped appearance drawn | no, it is a property of the ROM |
| magenta ticks + pip | the engine READ the ROM and could not interpret it, shipped appearance drawn | yes: an engine gap or a partly rewritten handler |

The magenta state was previously amber as well, and logged nothing, so
`unknownDrawRoutine`, `unexpectedOpcode`, `nudgeTargetOutOfRange`,
`unmodelledTailCall` and `romReadFailed` were indistinguishable from a
repoint and, with markers off, invisible. It now logs once per sprite per
failure kind.

### Scope of that query

It states what the engine **can verify**. It is not a licence to overrule a
display choice the user made. Declining to assert something unverified and
hiding something the user explicitly asked for look similar in code and are not
the same act. Nothing may be wired to it that suppresses a user-enabled
annotation.

### MAIN versus INIT

The current policy is conservative: **any** divergence, MAIN or INIT, blocks
engine rendering for that sprite. MAIN is the draw handler and is obviously
load-bearing. INIT never draws, but it can still establish state the draw
reads: `$2C` Yoshi Egg takes its OBJ attribute from a table indexed by its
spawn column inside `InitYoshiEgg`, which is the `initTableByX` palette source.
For a placeholder decision, blocking on init divergence too is the right
default, because a repointed init can change the sprite's palette without
touching a pixel of the draw routine. A later pass could relax it to "init
divergence only matters when the descriptor's palette source actually reads
init", which is a one-line predicate over `descriptor.palette.kind`, but it is
not worth the branch until a ROM in the corpus exercises it.

### Exercising the divergence branch

No MAIN draw handler is repointed in any of the six ROM files in `test/roms/`:
the MAIN table at `$01:85CC` is byte-identical across all of them. The only
three INIT repoints are at `$52`, `$53` and `$9B`, none of which is a
descriptor sprite. So the corpus can only ever produce the "vanilla" answer.

To see the amber unverified state in the running editor, repoint one entry in a
scratch copy of a ROM. The MAIN table's file offset happens to equal its LoROM
address, so entry `id` lives at file offset `0x85CC + id * 2`; for `$4D` that is
`0x8666`. Write any two bytes there and open map `$010`.

In tests the same patch is done in memory via `RomFile.writeAt`, never saved,
so `test/roms/` is not touched. Both branches are covered in
`test/suite/unit/sprites/SpriteHandlerProvenance.test.ts`.

## Known limits of the wiring

- Hit-testing and selection stay on the shipped appearance's rect in both
  states, so clicking behaves identically with the toggle on or off.
- The host-side `SpriteFactory` path is untouched. Only the rehydrated webview
  graph gets engine appearances.
- `charsNotLoaded` is not reachable from this path, deliberately. A char
  absent from the level's sprite set draws as the placeholder, because a
  sprite an author has placed is worth seeing with its gaps visible.
  `renderSpriteFrame`, the picker and annotation entry point, does report it.

`$1F` Magikoopa's `dynamicCgram` palette note WAS listed here as produced but
not consumed. It has been consumed since `1e3e94e`:
`EngineSpriteAppearance.rowFor` splices the runtime-uploaded colors over the
level palette's row for the column window the note names, and
`SpriteEngineWiring.test.ts` asserts both halves of the composite plus the
fact that it changed something.

## Where the descriptor sprites actually are

Measured by parsing every level's sprite stream in the vanilla ROM
(`Super Mario World (USA).vanilla.sfc`), all coordinates in tile units.

There are SIXTEEN, not five. An earlier revision of this section listed only
the five bespoke descriptors, which were all that existed when it was written;
`45e9e1e` added the eleven-member `Spr0to13Gfx` walk family, and those are the
densely placed ones. Re-measured across all 512 level slots:

| Sprite | Placements | Maps | First few maps |
|---|---|---|---|
| `$00` Green Koopa, no shell | 2 | 2 | `$00D`, `$106` |
| `$01` Red Koopa, no shell | 6 | 3 | `$00D`, `$106`, `$11F` |
| `$02` Blue Koopa, no shell | 16 | 5 | `$008`, `$00D`, `$10A`, `$12D`, `$135` |
| `$03` Yellow Koopa, no shell | 5 | 4 | `$006`, `$115`, `$11B`, `$12D` |
| `$04` Green Koopa | 20 | 8 | `$0C7`, `$0F7`, `$10B`, `$115`, `$119` |
| `$05` Red Koopa | 70 | 20 | `$005`, `$006`, `$008`, `$023`, `$0C7` |
| `$06` Blue Koopa | 36 | 11 | `$005`, `$006`, `$023`, `$0C7`, `$0F7` |
| `$07` Yellow Koopa | 8 | 4 | `$0C7`, `$0F7`, `$128`, `$134` |
| `$0F` Goomba | 8 | 2 | `$006`, `$11E` |
| `$11` Buzzy Beetle | 86 | 9 | `$009`, `$10A`, `$117`, `$118`, `$11A` |
| `$13` Spiny | 40 | 4 | `$001`, `$01C`, `$121`, `$136` |
| `$14` | 0 | 0 | none |
| `$1F` | 2 | 2 | `$11C` (col 22, row 21), `$1FE` (col 39, row 0) |
| `$2C` | 5 | 5 | `$130`, `$132`, `$134`, `$135`, `$136` |
| `$4D` | 14 | 2 | `$010` x12, `$106` x2 |
| `$4E` | 21 | 3 | `$010` x18, `$106` x3 |

297 placements for the walk family against 42 for the bespoke five, so the
walk family is what a reviewer will actually be looking at. `$005` and `$0C7`
carry four family members each and are the best single maps for comparing the
16x16 and 16x32 branches side by side.

`$14` is Lakitu's thrown Spiny. It is spawned at runtime and appears in no
vanilla level's sprite stream, so the vanilla ROM cannot show it in the editor
at all. Hack ROMs in `test/roms/` do place it; `GrandPooWorld_V1.2.sfc` map
`$113` at (col 93, row 23) and (col 77, row 23) is the most plausible pair, but
that was not visually confirmed.

## Theia wiring (#564)

The Theia map tab draws sprites through the same table engine, without the
scaffolding above: no toggle between engines, no corner ticks, no fallback to
the retired appearance classes. Evidence scope: the vanilla ROM in the corpus,
read through `drawSpriteParts`; no emulator was run.

- `theia/extension/src/node/map-sprites.ts` parses the level's stream with
  `parseLevelSprites`, resolves identity (`findDescriptor`, `resolveIdentity`),
  and draws each sprite at `romFrame` 0 with Mario's X from
  `readMarioStartPos`. Chars come from the map's VRAM (SP1-SP4), colors from
  its CGRAM; the palette row is the engine's own per-part answer, and a
  `dynamicCgram` note is spliced over that row as above.
- Each sprite is one bitmap at anchor + `dx`/`dy`, never snapped to the grid.
  A sprite the engine declines (`noDescriptor`, `customHandler`,
  `unexpectedOpcode` and the other failure kinds), or whose chars are not in
  the level's sprite set (`charsNotLoaded`), is a 16 x 16 marker at the anchor
  with its hex id. That includes the non-visual sprites (auto-scroll,
  generators, layer control), whose real treatment is deferred.
- Counts on the vanilla ROM: `$106` has 25 sprites, 15 drawn and 10 markers;
  `$105` has 34, all markers, because none of its ids has a descriptor (the
  issue named `$105` as holding covered ids; it does not).
- Overlap between sprites: column order on a horizontal map, row order on a
  vertical one, the stream's order breaking ties, later on top. This is a
  display choice, not the game's OAM order.
