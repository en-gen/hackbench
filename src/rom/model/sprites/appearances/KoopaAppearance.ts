// Consumes: mapStore.marioSpawnX (overlay only)

import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import { drawPatrolPath } from '../../overlays/patrolPath'
import type { MapStore } from '../../stores/mapStore'
import { KoopaWalkBehavior } from '../behaviors/KoopaWalkBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Ground-walking koopa appearance — $04 Green / $05 Red / $06 Blue /
 * $07 Yellow (and future Spr0to13Main family: $0F Goomba, $11 Buzzy
 * Beetle, $13 Spiny).
 *
 * Renders the sprite's pixel parts via `StaticSpriteAppearance` and adds
 * a movement overlay derived from `KoopaWalkBehavior.computePatrolRange`.
 *
 * Overlay vocabulary (shared across all patrol-style sprites):
 *   - **Dashed centerline** at 50% sprite height tracks where the koopa
 *     walks. The line follows terrain — slopes shift it column-by-column.
 *   - **Solid vertical** at left/right boundary indicates the koopa
 *     turns around there (wall or turnLedge — `solidLeft`/`solidRight`).
 *   - **Dashed L-extension** past a fallLedge (only one side, decided by
 *     `fallSide`) shows the koopa walks off and falls. The dashed line
 *     turns 90° at the ledge and drops one tile below the floor into the pit.
 *   - **Toward-Mario clipping**: non-turning sprites (fall-off walkers like
 *     $04, $07, $0F) show only the corridor arm from spawn toward Mario when
 *     `mapStore.marioSpawnX` is available. Both arms are shown for turning sprites.
 *   - **Spawn drop**: dotted vertical line if the sprite spawns airborne.
 *
 * Color is `COLORS.patrolPath` — same lime accent every patrol-style
 * sprite uses, so the visual vocabulary is consistent across koopas,
 * super koopas, sinusoidal para-koopas, etc.
 */
export class KoopaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    getL1:      GetL1Tile,
    levelCols:  number,
    levelRows:  number,
    behavior:   SpriteBehavior | undefined,
    mapStore:   MapStore,
  ): void {
    if (!isActive || !(behavior instanceof KoopaWalkBehavior)) return
    drawPatrolPath(ctx, behavior, x, y, getL1, levelCols, levelRows, mapStore.marioSpawnX)
  }
}
