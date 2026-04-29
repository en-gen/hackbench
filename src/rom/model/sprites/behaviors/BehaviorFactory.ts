import type { BehaviorMeta } from '../MovementBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { BouncingKoopaBehavior } from './BouncingKoopaBehavior'
import { FlyingLeftKoopaBehavior } from './FlyingLeftKoopaBehavior'
import { HopFlameBehavior } from './HopFlameBehavior'
import { KoopaWalkBehavior, propsFromSpriteId } from './KoopaWalkBehavior'
import { BlurpBehavior } from './BlurpBehavior'
import { LineBrownPlatBehavior } from './LineBrownPlatBehavior'
import { RipVanFishBehavior } from './RipVanFishBehavior'
import { SinusoidalParaKoopaBehavior } from './SinusoidalParaKoopaBehavior'
import { SuperKoopaBehavior } from './SuperKoopaBehavior'
import { ThwimpBounceBehavior } from './ThwimpBounceBehavior'
import { WingedGoombaBehavior } from './WingedGoombaBehavior'

/**
 * Single dispatch site that builds the `SpriteBehavior` for a given sprite
 * id. Called by both the extension-host `SpriteFactory` (fresh construction
 * while loading a ROM) and the webview `rehydrate.buildBehavior` (after
 * the MapPayload serialization), so Behavior classes exist identically on
 * both sides — no prototype reattach needed because each side constructs
 * the class fresh.
 *
 * Returns the behavior with the shared metadata (`displayName`, `spawns`,
 * `isGenerator`, `reactRangeDy`) merged into it. Unknown sprite ids get a
 * plain-object behavior, same shape as before.
 *
 * The dispatch is a registry — adding a new Behavior means registering an
 * id here. When the editor starts supporting re-assignable behaviors
 * (user can change a sprite's behavior post-load), this registry becomes
 * the name→class map the UI hands out.
 */
export function buildMovementBehavior(
  spriteId: number,
  meta:     BehaviorMeta,
): SpriteBehavior {
  const common = {
    kind:         `sprite_${spriteId.toString(16)}`,
    displayName:  meta.displayName,
    spawns:       meta.spawns,
    isGenerator:  meta.isGenerator,
    reactRangeDy: meta.reactRangeDy,
  }
  switch (spriteId) {
    case 0x00: case 0x01: case 0x02: case 0x03:
    case 0x04: case 0x05: case 0x06: case 0x07:
    case 0x0C: case 0x0F:
    case 0x30: case 0x32: {
      const behavior = new KoopaWalkBehavior(propsFromSpriteId(spriteId), meta)
      return Object.assign(behavior, common)
    }
    case 0x10:
      return Object.assign(new WingedGoombaBehavior(meta), common)
    case 0x08:
      return Object.assign(new FlyingLeftKoopaBehavior(meta), common)
    case 0x09:
      return Object.assign(new BouncingKoopaBehavior(meta), common)
    case 0x0A:
      return Object.assign(new SinusoidalParaKoopaBehavior({ axis: 'vertical' }, meta), common)
    case 0x0B:
      return Object.assign(new SinusoidalParaKoopaBehavior({ axis: 'horizontal' }, meta), common)
    case 0x1D:
      return Object.assign(new HopFlameBehavior(meta), common)
    case 0x27:
      return Object.assign(new ThwimpBounceBehavior(meta), common)
    case 0x3D:
      return Object.assign(new RipVanFishBehavior(meta), common)
    case 0xC2:
      return Object.assign(new BlurpBehavior(meta), common)
    case 0x62:
      return Object.assign(new LineBrownPlatBehavior(meta), common)
    case 0x71: case 0x72: case 0x73:
      return Object.assign(new SuperKoopaBehavior(spriteId), common)
    default:
      return common
  }
}
