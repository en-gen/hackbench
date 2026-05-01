# Model layer — rendering architecture

## Core principle: self-rendering objects, dumb renderer

The renderer (`SmwMap.render`, `MapBuilder`) is intentionally dumb. It calls
`.render(target, mapStore, ...)` on each object and does nothing else. All
game-specific logic — palette selection, visibility, animation, variant
picking — lives inside the object's **behavior** or **appearance** class, not
in the renderer and not as special cases in the factory.

If you catch yourself writing `if (spriteId === 0x3E)` in the factory or
`if (tileId >= X && tileId < Y)` in the renderer, stop. That logic belongs in
a dedicated behavior class that you then attach in the factory.

## Reactive state

Two reactive stores feed every render. Behaviors read from them; mutation
goes through the actions on each store, never direct property writes.

### `editorStore` — singleton, editor/UI state

Lives at [`stores/editorStore.ts`](stores/editorStore.ts). One global
instance shared across the whole editor.

| Field | Used by |
|---|---|
| `pSwitchActive` | `PSwitchRevealBehavior`, `PSwitchAlternateBehavior` |
| `switchPalaceState` | `SwitchPalaceAlternateBehavior` |
| `animFrame` | `AnimatedPixelsBehavior`, `SuperKoopaAppearance`, `RopeMechanismAppearance` |
| `palAnimFrame` | `CyclingColorBehavior` |
| `cursorPx` | `ThwompAppearance`, `RipVanFishAppearance`, `VineSourceBehavior`, item-block overlays |
| `layerToggles` | `SmwMap.render`, webview side panels |
| `camera`, `cameraOn`, `cameraDragging` | L3 HUD gating, viewport composite |
| `zoom`, `activeVineSources`, `activeSpriteOverlays` | Webview-only |

Behaviors that read from `editorStore` import it directly. They must declare
their reads in a `// Consumes:` comment at the top of the file (see
discoverability below). Mutation always goes through actions
(`editorStore.setPSwitch(true)`, `editorStore.setLayerToggle('l1', false)`,
etc.) — direct property writes skip the equality guards that prevent
spurious effect re-runs.

### `mapStore` — per-map, ROM-derived data

Lives at [`stores/mapStore.ts`](stores/mapStore.ts). One instance per
loaded `SmwMap`, owned by the map and threaded into `render()` as a
parameter so multiple maps can render simultaneously without sharing
state.

| Field | Used by |
|---|---|
| `palette` | `SubTile.render` (via the renderer), all sprite render paths |
| `levelOrientation` | `PipeVariantsBehavior` |
| `screenPipeVariantIdx` | `PipeVariantsBehavior` |
| `initialCameraYPx` | `L3TilemapLayer.render` |
| `marioSpawnX` | `BlurpAppearance`, `DryBonesAppearance`, `KoopaAppearance` overlay, `SpikeTopAppearance`, `WingedSpriteAppearance` overlay |

Behaviors receive `mapStore` as a render argument. The Map16 viewer panel
constructs a default `mapStore` (empty pipe-variant table, marioSpawnX=0)
since it has no real level context — `PipeVariantsBehavior` falls back to
variant 0 when the table is empty.

## Discoverability convention: `// Consumes:` headers

Every behavior file starts with a comment listing the store fields it
reads:

```ts
// Consumes: editorStore.{pSwitchActive, animFrame}, mapStore.marioSpawnX
```

This replaces what prop drilling used to make obvious. Grep for `Consumes:
editorStore.cursorPx` to find every behavior that reacts to cursor moves.

## Tile rendering

### Interfaces

```
TileBehavior   src/rom/model/tiles/TileBehavior.ts
  selectQuad(cell, mapStore): SubtileQuad
  selectAlpha?(cell, mapStore): number
  renderOverlay?(target, cell, mapStore): void
```

`SubtileQuad` is a 4-tuple of `SubTile` (char reference + CGRAM palette row +
flip flags + BG priority bit). Every subtile carries its own palette, so
behaviors can mix palettes within a single 16x16 cell.

Implementations may declare narrower signatures (omitting unused
parameters) — TypeScript allows this when implementing an interface.
`StaticQuadBehavior.selectQuad()` is parameterless because it doesn't read
anything; `PipeVariantsBehavior.selectQuad(cell, mapStore)` takes both.

### Existing tile behaviors

| Class | Tiles | What it does |
|---|---|---|
| `StaticQuadBehavior` | most non-special tiles | Returns a fixed quad every frame |
| `PSwitchRevealBehavior` | $27/$28/$29/$2A | Renders the revealed artwork; fades to 50% when `editorStore.pSwitchActive` is false |
| `PipeVariantsBehavior` | $133–$13A | Picks one of 4 palette variants from `mapStore.screenPipeVariantIdx[screenOf(cell)]` |
| `SwitchPalaceAlternateBehavior` | $06A–$06D, $16A–$16D | Swaps off/on quad based on `editorStore.switchPalaceState[color]` |
| `VineSourceBehavior` | acts-like $2A/$2B | Carries vine-source identity; `renderOverlay` draws vine tile above block |
| `StarOneUpVineBlockBehavior` | low byte $1A | Per-column vine/1-up/star indicator; ports CODE_00F1AE |
| `KeyCoinBalloonKoopaBlockBehavior` | low byte $25 | Per-column key/red-coin/p-balloon/para-koopa indicator |
| `InvisibleBlockRevealBehavior` | invisible blocks | Renders substitute artwork at fixed 0.5 alpha + reward indicator |

### Editor overlays via `renderOverlay`

`TileBehavior` has an optional `renderOverlay?(target, cell, mapStore): void`.
`SmwMap.render()` calls a pre-pass (`renderL1Overlays`) **before** drawing
L1 tiles, so the overlay renders first and the tile's own pixels cover the
lower half — producing a "peek from behind" effect without any explicit clip.

Rules for `renderOverlay` implementations:
- Draw at `cell.tl.y - 8` (8 px above the tile) for a standard indicator.
- Alpha: `0.5` at rest; `1.0` when `editorStore.cursorPx` falls within the cell.
- Do **not** add overlay logic to the webview (`main.ts`). If you find
  yourself writing canvas 2D overlay code for a tile-specific visual
  (vine icon, item indicator, etc.), put it here instead.

### Factory wiring

`TileFactory.buildTiles()` is the only place that decides which behavior
attaches to which tile ID. The flow is:

1. Load all Map16 quads from ROM.
2. For each tile ID, check if it belongs to a special group (item block,
   P-switch hidden, pipe, switch-palace, vine source). If yes, construct the
   right behavior class and skip the default. If no, wrap it in `StaticQuadBehavior`.
3. Nothing else. No per-frame logic. No switch-on-ID in the renderer.

## Sprite rendering

### Interfaces

```
SpriteAppearance   src/rom/model/sprites/SpriteAppearance.ts
  render(target, x, y, behavior, mapStore): void
  renderOverlay?(canvas2d, x, y, isActive, getL1, cols, rows, behavior, mapStore): void
```

Sprites don't use a `selectQuad` indirection like tiles — they call `blit8x8`
directly in `render`. This lets appearances control per-part palette, flip,
and offset in one pass without an intermediate struct.

`renderOverlay` is the canvas2D pre-pass for movement/zone overlays. It
runs against `OverlayContext` (a CanvasRenderingContext2D cast), separate
from the pixel `RenderTarget`.

### Existing sprite appearances

| Class | Sprites | What it does |
|---|---|---|
| `StaticSpriteAppearance` | most sprites | Renders a fixed list of `SpritePart`s |
| `PSwitchAppearance` | $3E | Selects blue/silver palette from bit 4 of pixel X (matches `InitPSwitch`) |
| `KoopaAppearance` | $04–$07/$0F | Static parts + patrol-corridor overlay using `mapStore.marioSpawnX` |
| `WingedSpriteAppearance` | para-koopas, para-goombas, $83/$84 | Animated wings + behavior-specific overlay |
| `SuperKoopaAppearance` | $71/$72/$73 | Per-frame flap from `editorStore.animFrame` + cape-flash flip |
| `ThwompAppearance` | $26 | Cursor-proximity face swap from `editorStore.cursorPx` |
| `RipVanFishAppearance` | $3D | Idle/awake swap from cursor proximity |
| `SpikeTopAppearance` | $2E | 2-frame animation + wall-following patrol path |
| `BlurpAppearance` | $C2 | Static body + dashed swim line in FaceMario direction |
| `DryBonesAppearance` | $30/$32 | KoopaWalk patrol overlay |

### Factory wiring

`SpriteFactory.buildSprites()` is the only place that decides which appearance
a sprite gets. The factory builds the `SpritePart[]` array from the ROM tile
tables (palette, char, flip, offsets), then constructs the right appearance.

## Adding a new behavior

1. Create `src/rom/model/tiles/behaviors/MyBehavior.ts` (or
   `sprites/appearances/MyAppearance.ts`).
2. Add a top-of-file `// Consumes:` comment listing every store field the
   behavior reads.
3. Implement `TileBehavior` or `SpriteAppearance`. Read `editorStore.*`
   directly via import; receive `mapStore` as a render arg.
4. In `TileFactory.buildTiles()` / `SpriteFactory.buildSprites()`, add the
   tile-ID or sprite-ID check and construct your class.
5. If the behavior needs new level-wide state, add a field to `mapStore`
   (and populate it in `MapBuilder`/`rehydrate`). New singleton state goes
   on `editorStore` with an action for mutation.
6. Do **not** put the decision logic in the factory beyond "which behavior
   class to instantiate". The behavior class owns all per-frame decisions.
