# Model layer — rendering architecture

## Core principle: self-rendering objects, dumb renderer

The renderer (`TileRenderer`, `MapBuilder`) is intentionally dumb. It calls
`.render(ctx, target, x, y)` on each object and does nothing else. All
game-specific logic — palette selection, visibility, animation, variant
picking — lives inside the object's **behavior** or **appearance** class, not
in the renderer and not as special cases in the factory.

If you catch yourself writing `if (spriteId === 0x3E)` in the factory or
`if (tileId >= X && tileId < Y)` in the renderer, stop. That logic belongs in
a dedicated behavior class that you then attach in the factory.

## Tile rendering

### Interfaces

```
TileBehavior   src/rom/model/tiles/TileBehavior.ts
  selectQuad(ctx, cell): SubtileQuad   -- which 4 subtiles to draw
  selectAlpha?(ctx, cell): number      -- optional opacity override (0..1)
```

`SubtileQuad` is a 4-tuple of `SubTile` (char reference + CGRAM palette row +
flip flags + BG priority bit). Every subtile carries its own palette, so
behaviors can mix palettes within a single 16x16 cell.

### Existing tile behaviors

| Class | File | Tiles | What it does |
|---|---|---|---|
| `StaticQuad` | `behaviors/StaticQuad.ts` | all non-special tiles | Returns a fixed quad every frame |
| `PSwitchReveal` | `behaviors/PSwitchReveal.ts` | $27/$28/$29/$2A | Renders the revealed artwork; fades to 50% when `ctx.pSwitchActive` is false |
| `PipeVariants` | `behaviors/PipeVariants.ts` | $133–$13A | Picks one of 4 palette variants from `ctx.screenPipeVariantIdx[screenOf(cell)]` — grey/green/yellow/blue per screen |
| `SwitchPalaceAlternate` | `behaviors/SwitchPalaceAlternate.ts` | $06A–$06D, $16A–$16D | Swaps off/on quad based on `ctx.switchPalaceState.value[color]` |
| `VineSource` | `behaviors/VineSource.ts` | acts-like $2A/$2B (LM hacks) | Carries vine-source identity; `renderOverlay` draws vine tile above block |
| `ItemBlock` | `behaviors/ItemBlock.ts` | low bytes $11-$2D | Ports CODE_00F17F dispatch; per-column vine/1-up/star via DATA_00F080/F100; `renderOverlay` draws indicator |

### Editor overlays via `renderOverlay`

`TileBehavior` has an optional `renderOverlay?(ctx, target, cell): void`.
`SmwMap.render()` calls a pre-pass (`renderL1Overlays`) **before** drawing
L1 tiles, so the overlay renders first and the tile's own pixels cover the
lower half — producing a "peek from behind" effect without any explicit clip.

Rules for `renderOverlay` implementations:
- Draw at `cell.tl.y - 8` (8 px above the tile) for a standard indicator.
- Alpha: `0.5` at rest; `1.0` when `ctx.cursorPx` falls within the cell.
- Do **not** add overlay logic to the webview (`main.ts`). If you find
  yourself writing canvas 2D overlay code for a tile-specific visual
  (vine icon, item indicator, etc.), put it here instead.

### Factory wiring

`TileFactory.buildTiles()` is the only place that decides which behavior
attaches to which tile ID. The flow is:

1. Load all Map16 quads from ROM.
2. For each tile ID, check if it belongs to a special group (item block,
   P-switch hidden, pipe, switch-palace, vine source). If yes, construct the
   right behavior class and skip the default. If no, wrap it in `StaticQuad`.
3. Nothing else. No per-frame logic. No switch-on-ID in the renderer.

## Sprite rendering

### Interfaces

```
SpriteAppearance   src/rom/model/sprites/SpriteAppearance.ts
  render(ctx, target, x, y): void   -- draws the sprite at pixel (x, y)
```

Sprites don't use a `selectQuad` indirection like tiles — they call `blit8x8`
directly in `render`. This lets appearances control per-part palette, flip,
and offset in one pass without an intermediate struct.

### Existing sprite appearances

| Class | File | Sprites | What it does |
|---|---|---|---|
| `StaticSpriteAppearance` | `appearances/StaticSpriteAppearance.ts` | most sprites | Renders a fixed list of `SpritePart`s (char + palette + flip + offset) |
| `PSwitchAppearance` | `appearances/PSwitchAppearance.ts` | $3E | Selects blue (row 11) or silver (row 9) OBJ palette from bit 4 of the pixel X coordinate — matching `InitPSwitch` (`bank_01.asm:665`) which indexes `PSwitchPal[$06,$02]` via `(SpriteXPosLow >> 4) & 1` |

### Factory wiring

`SpriteFactory.buildSprites()` is the only place that decides which appearance
a sprite gets. The factory builds the `SpritePart[]` array from the ROM tile
tables (palette, char, flip, offsets), then constructs the right appearance:

```ts
// most sprites
new StaticSpriteAppearance(parts)

// sprite $3E: appearance owns the palette decision
new PSwitchAppearance(parts)
```

`PSwitchAppearance` ignores the `palette` field on each `SpritePart` — the
part supplies geometry (char, flip, dx/dy) and the appearance supplies color.

## RenderContext

`RenderContext` threads level-wide reactive state into every behavior call.
Key fields behaviors may read:

| Field | Type | Used by |
|---|---|---|
| `pSwitchActive` | `Ref<boolean>` | `PSwitchReveal` |
| `switchPalaceState` | `Ref<[bool,bool,bool,bool]>` | `SwitchPalaceAlternate` |
| `screenPipeVariantIdx` | `readonly number[]` | `PipeVariants` |
| `levelOrientation` | `'horizontal'\|'vertical'` | `PipeVariants` |
| `animFrame` / `palAnimFrame` | `Ref<number>` | animated chars/palettes |
| `palette` | `Palette` | all behaviors — `ctx.palette.row(n, ctx)` for CGRAM row |

All fields are `Ref<T>` so reads inside `computed()` are tracked by
`@vue/reactivity` and caches invalidate automatically when inputs change.
Do not read `.value` outside a reactive context unless you intend a one-shot
read (e.g. within `render()` which is called reactively by the canvas).

## Adding a new behavior

1. Create `src/rom/model/tiles/behaviors/MyBehavior.ts` (or
   `sprites/appearances/MyAppearance.ts`).
2. Implement `TileBehavior` or `SpriteAppearance`.
3. In `TileFactory.buildTiles()` / `SpriteFactory.buildSprites()`, add the
   tile-ID or sprite-ID check and construct your class.
4. If the behavior needs new level-wide state (e.g. a new timer), add a
   reactive `Ref` to `RenderContext`.
5. Do **not** put the decision logic in the factory beyond "which behavior
   class to instantiate". The behavior class owns all per-frame decisions.
