import type { BehaviorMeta } from '../MovementBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { SuperKoopaBehavior } from './SuperKoopaBehavior'

/**
 * Single dispatch site that builds the `SpriteBehavior` for a given sprite
 * id. Called by both the extension-host `SpriteFactory` (fresh construction
 * while loading a ROM) and the webview `rehydrate.buildBehavior` (after
 * the MapPayload serialization), so Behavior classes exist identically on
 * both sides - no prototype reattach needed because each side constructs
 * the class fresh.
 *
 * Returns the behavior with the shared metadata (`displayName`, `spawns`,
 * `isGenerator`, `reactRangeDy`) merged into it. Unknown sprite ids get a
 * plain-object behavior, same shape as before.
 *
 * The dispatch is a registry - adding a new Behavior means registering an
 * id here. When the editor starts supporting re-assignable behaviors
 * (user can change a sprite's behavior post-load), this registry becomes
 * the name→class map the UI hands out.
 *
 * 24 sprite ids across eleven now-deleted `MovementBehavior` subclasses,
 * plus $62 (`LineBrownPlatBehavior`, converted to a plain function), used
 * to be registered here; all fall through to `default` now. See
 * `docs/sprites/sprite-overlay-removal.md`'s update section for why.
 */
export function buildMovementBehavior(spriteId: number, meta: BehaviorMeta): SpriteBehavior {
  const common = {
    kind: `sprite_${spriteId.toString(16)}`,
    displayName: meta.displayName,
    spawns: meta.spawns,
    isGenerator: meta.isGenerator,
    reactRangeDy: meta.reactRangeDy,
  }
  switch (spriteId) {
    case 0x71:
    case 0x72:
    case 0x73:
      return Object.assign(new SuperKoopaBehavior(spriteId), common)
    default:
      return common
  }
}
