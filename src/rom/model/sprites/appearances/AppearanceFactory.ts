/**
 * AppearanceFactory.ts - single source of truth for spriteId → appearance
 * mapping for "pure-parts" appearances (those whose only constructor input
 * is the SpritePart array, plus optionally the spriteId itself for
 * variant-aware subclasses like CheepCheep / CarrotTopLift).
 *
 * Both `SpriteFactory` (extension host) and `rehydrate.buildAppearance`
 * (webview) delegate here so a new appearance subclass only needs one
 * registration. Mirrors the `BehaviorFactory.buildMovementBehavior`
 * pattern.
 *
 * Subclasses that carry data beyond the parts array (Thwomp's three
 * face sets, RipVanFish's awake/asleep frames, WingedSprite's wing
 * frames, etc.) are NOT in this dispatch - they keep their own `kind`
 * discriminator in the payload because the descriptor has additional
 * fields that wouldn't fit the `static` shape. See the per-`kind`
 * cases in `rehydrate.buildAppearance` and the corresponding
 * `instanceof` branches in `serialize.ts`.
 *
 * Issue #293 - closes the dual-registration gap that previously caused
 * silent fallback to `StaticSpriteAppearance` when a new subclass was
 * forgotten in `rehydrate.ts`.
 */

import type { SpriteAppearance } from '../SpriteAppearance'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'
import { PSwitchAppearance } from './PSwitchAppearance'
import { CheepCheepAppearance } from './CheepCheepAppearance'
import { JumpingFishAppearance } from './JumpingFishAppearance'
import { JumpingPiranhaAppearance } from './JumpingPiranhaAppearance'
import { MontyMoleAppearance } from './MontyMoleAppearance'
import { SwimJumpFishAppearance } from './SwimJumpFishAppearance'
import { HopFlameAppearance } from './HopFlameAppearance'
import { ThwimpAppearance } from './ThwimpAppearance'
import { BlurpAppearance } from './BlurpAppearance'
import { CarrotTopLiftAppearance } from './CarrotTopLiftAppearance'
import { KoopaAppearance } from './KoopaAppearance'
import { DryBonesAppearance } from './DryBonesAppearance'
import { SumoBrotherAppearance } from './SumoBrotherAppearance'
import { BallAndChainAppearance } from './BallAndChainAppearance'
import { HammerBroAppearance } from './HammerBroAppearance'

/**
 * Build the appearance for a "pure-parts" sprite. The returned subclass
 * is determined by `spriteId` alone - no extra payload data needed.
 *
 * Sprites whose appearance carries additional state (Thwomp face sets,
 * RipVanFish frames, etc.) are NOT handled here and must keep their
 * own `kind` discriminator in the payload.
 */
export function buildSpriteAppearance(spriteId: number, parts: SpritePart[]): SpriteAppearance {
  // Order: more specific (single-id) first, ranges last.
  if (spriteId === 0x3e) return new PSwitchAppearance(parts)
  if (spriteId === 0x15) return new CheepCheepAppearance(parts, false)
  if (spriteId === 0x16) return new CheepCheepAppearance(parts, true)
  if (spriteId === 0x18) return new JumpingFishAppearance(parts)
  if (spriteId === 0x4d || spriteId === 0x4e) return MontyMoleAppearance.fromParts(parts)
  if (spriteId === 0x4f) return new JumpingPiranhaAppearance(parts)
  if (spriteId === 0x47) return new SwimJumpFishAppearance(parts)
  if (spriteId === 0x1d) return new HopFlameAppearance(parts)
  if (spriteId === 0x27) return new ThwimpAppearance(parts)
  if (spriteId === 0xc2) return new BlurpAppearance(parts)
  if (spriteId === 0xb7 || spriteId === 0xb8)
    return new CarrotTopLiftAppearance(parts, spriteId as 0xb7 | 0xb8)
  if (spriteId === 0x30 || spriteId === 0x32) return new DryBonesAppearance(parts)
  if (spriteId === 0x9a) return new SumoBrotherAppearance(parts)
  if (spriteId === 0x9b) return new HammerBroAppearance(parts)
  if (spriteId === 0x9e) return BallAndChainAppearance.fromParts(parts)
  if (spriteId <= 0x07 || spriteId === 0x0f) return new KoopaAppearance(parts)
  return new StaticSpriteAppearance(parts)
}
