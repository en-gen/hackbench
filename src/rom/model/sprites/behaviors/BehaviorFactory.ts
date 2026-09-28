import type { BehaviorMeta } from '../MovementBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { LineBrownPlatBehavior } from './LineBrownPlatBehavior'
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
 * Sprite ids that only ever needed the plain metadata object (no method
 * an Appearance calls) fall through to `default`. Ten `MovementBehavior`
 * subclasses used to be registered here - `KoopaWalkBehavior`,
 * `WingedGoombaBehavior`, `FlyingLeftKoopaBehavior`, `BouncingKoopaBehavior`,
 * `SinusoidalParaKoopaBehavior`, `HopFlameBehavior`, `ThwimpBounceBehavior`,
 * `RipVanFishBehavior`, `BlurpBehavior`, `SumoBrotherBehavior` - each
 * carrying a movement simulator that no Appearance ever read (the overlays
 * that would have called them were removed; see
 * `docs/sprites/sprite-overlay-removal.md`). `Object.assign(instance, common)`
 * below overwrites every one of those instances' `kind` with `common.kind`
 * regardless, and `serialize.ts` only ever persists the `common` fields, so
 * dropping the classes and returning `common` directly is observationally
 * identical for every live caller. Removed by the sprite-movement-sim
 * cleanup (issue #409); see `RipVanFishBehavior.ts` for the one constant
 * that turned out to still be live appearance data.
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
    case 0x62:
      return Object.assign(new LineBrownPlatBehavior(meta), common)
    case 0x71:
    case 0x72:
    case 0x73:
      return Object.assign(new SuperKoopaBehavior(spriteId), common)
    default:
      return common
  }
}
