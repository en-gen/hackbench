/**
 * rehydrate.ts exported helper functions - branch coverage.
 *
 * Targets (all exported from rehydrate.ts):
 *   buildColorBehavior  - 'static' / 'cycling' switch cases (2)
 *   buildPalette        - delegates to buildColorBehavior (basic)
 *   buildCharBehavior   - 'static' (good pixels as array, pixels as ArrayLike, bad length),
 *                         'animated' (good, empty frames, wrong-length frames, null frame),
 *                         'pSwitchAlt'
 *   buildTileBehavior   - all 8 kinds + optional quad ternaries + ?? branches
 *                         (buildSubTile: chars.get ?? placeholder - found/missing branches)
 *   buildSprite         - 'static' case: 12 spriteId sub-dispatches + default fallback
 *                         named cases: 12 appearance kinds
 *                         secondary present / absent
 *                         buildParts: chars.get ?? placeholder - found/missing
 */

import { describe, it, expect } from 'vitest'
import {
  buildCharBehavior,
  buildTileBehavior,
  buildColorBehavior,
  buildPalette,
  buildSprite,
} from '../../../../src/rom/model/rehydrate'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from '../../../../src/rom/model/chars/behaviors/PSwitchAlternateBehavior'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { CyclingColorBehavior } from '../../../../src/rom/model/palette/behaviors/CyclingColorBehavior'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { VineSourceBehavior } from '../../../../src/rom/model/tiles/behaviors/VineSourceBehavior'
import { StarOneUpVineBlockBehavior } from '../../../../src/rom/model/tiles/behaviors/StarOneUpVineBlockBehavior'
import { KeyCoinBalloonKoopaBlockBehavior } from '../../../../src/rom/model/tiles/behaviors/KeyCoinBalloonKoopaBlockBehavior'
import { PipeVariantsBehavior } from '../../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import { SwitchPalaceAlternateBehavior } from '../../../../src/rom/model/tiles/behaviors/SwitchPalaceAlternateBehavior'
import { PSwitchRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/PSwitchRevealBehavior'
import { InvisibleBlockRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/InvisibleBlockRevealBehavior'
import { MontyMoleAppearance } from '../../../../src/rom/model/sprites/appearances/MontyMoleAppearance'
import { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import { CompositeSprite } from '../../../../src/rom/model/sprites/CompositeSprite'

// ── shared fixtures ───────────────────────────────────────────────────────────

// Minimal SubTileDescriptor - charNum 0, all flags false
const ST = { charNum: 0, palette: 0, flipX: false, flipY: false, priority: false }
// 4-element quad; used wherever SubtileQuadDescriptor is required
const QUAD = [ST, ST, ST, ST]

// Minimal SpritePartDescriptor
const PART = { charNum: 0, palette: 0, flipX: false, flipY: false, dx: 0, dy: 0 }
const PARTS = [PART]

// Chars maps for covering chars.get() ?? branch pairs
const PLACEHOLDER = new Char(-1, new StaticPixelsBehavior(new Uint8Array(64)))
const CHAR_0 = new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
const EMPTY_CHARS = new Map<number, Char>()
const CHARS_WITH_0 = new Map([[0, CHAR_0]])

// Minimal behavior descriptor; optional fields absent to exercise default paths
const BHVR = { kind: 'sprite_ff' }

/** Build a minimal SpriteDescriptor with optional secondary. */
function sd(id: number, appearance: object, secondary?: object): any {
  return {
    id,
    x: 0,
    y: 0,
    appearance,
    behavior: BHVR,
    ...(secondary !== undefined ? { secondary } : {}),
  }
}

// ── buildColorBehavior ────────────────────────────────────────────────────────

describe('buildColorBehavior', () => {
  it("'static' → StaticColorBehavior", () => {
    const b = buildColorBehavior({ kind: 'static', value: { r: 255, g: 0, b: 0, a: 255 } } as any)
    expect(b).toBeInstanceOf(StaticColorBehavior)
  })

  it("'cycling' → CyclingColorBehavior", () => {
    const b = buildColorBehavior({ kind: 'cycling', frames: [{ r: 0, g: 0, b: 0, a: 255 }] } as any)
    expect(b).toBeInstanceOf(CyclingColorBehavior)
  })
})

// ── buildPalette ──────────────────────────────────────────────────────────────

describe('buildPalette', () => {
  it('builds Palette from descriptor (delegates to buildColorBehavior)', () => {
    const staticColor = { kind: 'static', value: { r: 0, g: 0, b: 0, a: 255 } }
    const desc = {
      cells: [[staticColor]],
      backAreaColor: staticColor,
    }
    expect(buildPalette(desc as any)).toBeInstanceOf(Palette)
  })
})

// ── buildCharBehavior - static ────────────────────────────────────────────────

describe("buildCharBehavior 'static'", () => {
  it('good pixels as plain array → StaticPixelsBehavior (Array.isArray=true, length=64 ok)', () => {
    const b = buildCharBehavior({ kind: 'static', pixels: Array(64).fill(0) } as any)
    expect(b).toBeInstanceOf(StaticPixelsBehavior)
  })

  it('pixels as Uint8Array → StaticPixelsBehavior (Array.isArray=false → Array.from branch)', () => {
    // Uint8Array is ArrayLike but not Array.isArray → triggers the else branch
    const b = buildCharBehavior({ kind: 'static', pixels: new Uint8Array(64) } as any)
    expect(b).toBeInstanceOf(StaticPixelsBehavior)
  })

  it('bad pixel length → fallback StaticPixelsBehavior (warn path)', () => {
    const b = buildCharBehavior({ kind: 'static', pixels: [0, 1, 2] } as any)
    expect(b).toBeInstanceOf(StaticPixelsBehavior)
  })
})

// ── buildCharBehavior - animated ──────────────────────────────────────────────

describe("buildCharBehavior 'animated'", () => {
  it('good frames (each length=64) → AnimatedPixelsBehavior', () => {
    const b = buildCharBehavior({
      kind: 'animated',
      frames: [Array(64).fill(0), Array(64).fill(1)],
    } as any)
    expect(b).toBeInstanceOf(AnimatedPixelsBehavior)
  })

  it('empty frames array → fallback StaticPixelsBehavior (length=0 bad path)', () => {
    const b = buildCharBehavior({ kind: 'animated', frames: [] } as any)
    expect(b).toBeInstanceOf(StaticPixelsBehavior)
  })

  it('frame with wrong pixel count → fallback StaticPixelsBehavior (some length≠64 bad path)', () => {
    const b = buildCharBehavior({ kind: 'animated', frames: [[0, 1, 2]] } as any)
    expect(b).toBeInstanceOf(StaticPixelsBehavior)
  })

  it('null frame element → fallback StaticPixelsBehavior (some(f => !f) true branch)', () => {
    const b = buildCharBehavior({ kind: 'animated', frames: [null] } as any)
    expect(b).toBeInstanceOf(StaticPixelsBehavior)
  })
})

// ── buildCharBehavior - pSwitchAlt ────────────────────────────────────────────

describe("buildCharBehavior 'pSwitchAlt'", () => {
  it('recurses into normal + alt → PSwitchAlternateBehavior', () => {
    const b = buildCharBehavior({
      kind: 'pSwitchAlt',
      normal: { kind: 'static', pixels: Array(64).fill(0) },
      alt: { kind: 'static', pixels: Array(64).fill(1) },
    } as any)
    expect(b).toBeInstanceOf(PSwitchAlternateBehavior)
  })
})

// ── buildTileBehavior - static ────────────────────────────────────────────────

describe("buildTileBehavior 'static'", () => {
  it('charNum found in chars → StaticQuadBehavior (chars.get ?? found branch)', () => {
    const b = buildTileBehavior({ kind: 'static', quad: QUAD } as any, CHARS_WITH_0, PLACEHOLDER)
    expect(b).toBeInstanceOf(StaticQuadBehavior)
  })

  it('charNum missing → StaticQuadBehavior (chars.get ?? placeholder fallback branch)', () => {
    const b = buildTileBehavior({ kind: 'static', quad: QUAD } as any, EMPTY_CHARS, PLACEHOLDER)
    expect(b).toBeInstanceOf(StaticQuadBehavior)
  })
})

// ── buildTileBehavior - vineSource ────────────────────────────────────────────

describe("buildTileBehavior 'vineSource'", () => {
  it('overlayQuad absent → VineSourceBehavior with null overlay (ternary false branch)', () => {
    const b = buildTileBehavior({ kind: 'vineSource', quad: QUAD } as any, EMPTY_CHARS, PLACEHOLDER)
    expect(b).toBeInstanceOf(VineSourceBehavior)
  })

  it('overlayQuad present → VineSourceBehavior with built overlay (ternary true branch)', () => {
    const b = buildTileBehavior(
      { kind: 'vineSource', quad: QUAD, overlayQuad: QUAD } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(VineSourceBehavior)
  })
})

// ── buildTileBehavior - starOneUpVineBlock ────────────────────────────────────

describe("buildTileBehavior 'starOneUpVineBlock'", () => {
  // charNums: [0]=found, [99]=not-found, [-1]=negative - covers all 4 sub-branches
  const MIXED = [0, 99, -1]

  it('vineOverlayQuad absent + mixed charNums → StarOneUpVineBlockBehavior', () => {
    const b = buildTileBehavior(
      {
        kind: 'starOneUpVineBlock',
        quad: QUAD,
        // vineOverlayQuad absent → null ternary branch
        oneupCharNums: MIXED,
        starCharNums: MIXED,
      } as any,
      CHARS_WITH_0,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(StarOneUpVineBlockBehavior)
  })

  it('vineOverlayQuad present → non-null ternary branch', () => {
    const b = buildTileBehavior(
      {
        kind: 'starOneUpVineBlock',
        quad: QUAD,
        vineOverlayQuad: QUAD,
        oneupCharNums: [],
        starCharNums: [],
      } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(StarOneUpVineBlockBehavior)
  })
})

// ── buildTileBehavior - keyCoinBalloonKoopaBlock ──────────────────────────────

describe("buildTileBehavior 'keyCoinBalloonKoopaBlock'", () => {
  it('all 4 char arrays with mixed values → KeyCoinBalloonKoopaBlockBehavior', () => {
    const M = [0, 99, -1] // found, not-found, negative - covers all ternary branches
    const b = buildTileBehavior(
      {
        kind: 'keyCoinBalloonKoopaBlock',
        quad: QUAD,
        keyCharNums: M,
        redCoinCharNums: M,
        pballoonCharNums: M,
        paraKoopaCharNums: M,
      } as any,
      CHARS_WITH_0,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(KeyCoinBalloonKoopaBlockBehavior)
  })
})

// ── buildTileBehavior - pipeVariants ──────────────────────────────────────────

describe("buildTileBehavior 'pipeVariants'", () => {
  it("'pipeVariants' → PipeVariantsBehavior", () => {
    const b = buildTileBehavior(
      { kind: 'pipeVariants', variants: [QUAD, QUAD] } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(PipeVariantsBehavior)
  })
})

// ── buildTileBehavior - switchPalaceAlternate ─────────────────────────────────

describe("buildTileBehavior 'switchPalaceAlternate'", () => {
  it("'switchPalaceAlternate' → SwitchPalaceAlternateBehavior", () => {
    const b = buildTileBehavior(
      { kind: 'switchPalaceAlternate', off: QUAD, on: QUAD, color: 0 } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(SwitchPalaceAlternateBehavior)
  })
})

// ── buildTileBehavior - pSwitchReveal ─────────────────────────────────────────

describe("buildTileBehavior 'pSwitchReveal'", () => {
  it('offAlpha absent → 0.5 default (?? null-taken branch)', () => {
    const b = buildTileBehavior(
      { kind: 'pSwitchReveal', revealedQuad: QUAD } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(PSwitchRevealBehavior)
  })

  it('offAlpha present → uses provided value (?? non-null branch)', () => {
    const b = buildTileBehavior(
      { kind: 'pSwitchReveal', revealedQuad: QUAD, offAlpha: 0.3 } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(PSwitchRevealBehavior)
  })
})

// ── buildTileBehavior - invisibleBlockReveal ──────────────────────────────────

describe("buildTileBehavior 'invisibleBlockReveal'", () => {
  it('rewardOverlayQuad absent, alpha absent → both ?? fallback branches', () => {
    const b = buildTileBehavior(
      { kind: 'invisibleBlockReveal', revealedQuad: QUAD } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(InvisibleBlockRevealBehavior)
  })

  it('rewardOverlayQuad present, alpha present → both ?? non-null branches', () => {
    const b = buildTileBehavior(
      {
        kind: 'invisibleBlockReveal',
        revealedQuad: QUAD,
        rewardOverlayQuad: QUAD,
        alpha: 0.25,
      } as any,
      EMPTY_CHARS,
      PLACEHOLDER,
    )
    expect(b).toBeInstanceOf(InvisibleBlockRevealBehavior)
  })
})

// ── buildSprite - 'static' case: spriteId sub-dispatch ───────────────────────

describe("buildSprite appearance kind='static' - spriteId sub-dispatch", () => {
  // One of the sprite tests uses CHARS_WITH_0 to cover the buildParts ?? found branch
  const APP = { kind: 'static', parts: PARTS }

  it('id=0x15 → CheepCheepAppearance(parts, false) [swimDir=false branch]', () => {
    expect(buildSprite(sd(0x15, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x16 → CheepCheepAppearance(parts, true) [swimDir=true branch]', () => {
    expect(buildSprite(sd(0x16, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x18 → JumpingFishAppearance', () => {
    expect(buildSprite(sd(0x18, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x47 → SwimJumpFishAppearance', () => {
    expect(buildSprite(sd(0x47, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x1D → HopFlameAppearance', () => {
    expect(buildSprite(sd(0x1d, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x4D → MontyMoleAppearance (ground Monty Mole)', () => {
    expect(buildSprite(sd(0x4d, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x4E → MontyMoleAppearance (ledge Monty Mole)', () => {
    expect(buildSprite(sd(0x4e, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x27 → ThwimpAppearance (static dispatch, not ThwompAppearance)', () => {
    expect(buildSprite(sd(0x27, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0xC2 → BlurpAppearance', () => {
    expect(buildSprite(sd(0xc2, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0xB7 → CarrotTopLiftAppearance (|| left side)', () => {
    expect(buildSprite(sd(0xb7, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0xB8 → CarrotTopLiftAppearance (|| right side)', () => {
    expect(buildSprite(sd(0xb8, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x00 → KoopaAppearance (spriteId <= 0x07 path)', () => {
    expect(buildSprite(sd(0x00, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x0F → KoopaAppearance (spriteId === 0x0F path)', () => {
    expect(buildSprite(sd(0x0f, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x30 → DryBonesAppearance (spriteId === 0x30 path)', () => {
    expect(buildSprite(sd(0x30, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x32 → DryBonesAppearance (spriteId === 0x32 path)', () => {
    expect(buildSprite(sd(0x32, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0x9A → SumoBrotherAppearance', () => {
    expect(buildSprite(sd(0x9a, APP), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it('id=0xFF → StaticSpriteAppearance (default: no id check matches); covers buildParts ?? found branch', () => {
    // CHARS_WITH_0 has charNum 0 → chars.get(0)=CHAR_0 → found branch of buildParts ??
    expect(buildSprite(sd(0xff, APP), CHARS_WITH_0, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })
})

// ── buildSprite - named appearance kinds ──────────────────────────────────────

describe('buildSprite - named appearance kinds', () => {
  it("'static' + spriteId=$3E → PSwitchAppearance via AppearanceFactory (issue #293)", () => {
    const app = { kind: 'static', parts: PARTS }
    expect(buildSprite(sd(0x3e, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'thwomp' → ThwompAppearance (bodyParts, alertFace, aggressiveFace)", () => {
    const app = { kind: 'thwomp', bodyParts: PARTS, alertFace: PARTS, aggressiveFace: PARTS }
    expect(buildSprite(sd(0x26, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'ripVanFish' → RipVanFishAppearance (sleepFrames[2], awakeFrames[2], zParts)", () => {
    const app = {
      kind: 'ripVanFish',
      sleepFrames: [PARTS, PARTS],
      awakeFrames: [PARTS, PARTS],
      zParts: PARTS,
    }
    expect(buildSprite(sd(0x3d, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'wingedSprite' → WingedSpriteAppearance (bodyParts, wingFrames[2], wingsInFront)", () => {
    const app = {
      kind: 'wingedSprite',
      bodyParts: PARTS,
      wingFrames: [PARTS, PARTS],
      wingsInFront: false,
    }
    expect(buildSprite(sd(0x08, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'hammerBroPlatform' → HammerBroPlatformAppearance", () => {
    const app = { kind: 'hammerBroPlatform', platformParts: PARTS, wingFrames: [PARTS, PARTS] }
    expect(buildSprite(sd(0x9b, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'superKoopa' → SuperKoopaAppearance (grounded/groundedFlash/airborne/airborneFlash each [frames,frames])", () => {
    const pose = [PARTS, PARTS] as const
    const app = {
      kind: 'superKoopa',
      grounded: pose,
      groundedFlash: pose,
      airborne: pose,
      airborneFlash: pose,
      isAirborne: false,
    }
    expect(buildSprite(sd(0x71, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'volcanoLotus' → VolcanoLotusAppearance (headParts, flowerFrames[2])", () => {
    const app = { kind: 'volcanoLotus', headParts: PARTS, flowerFrames: [PARTS, PARTS] }
    expect(buildSprite(sd(0x5e, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'lineBrownPlat' → LineBrownPlatAppearance (platformParts, direction)", () => {
    const app = { kind: 'lineBrownPlat', platformParts: PARTS, direction: 'forward' }
    expect(buildSprite(sd(0x62, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'lineCheckerPlat' → LineCheckerPlatAppearance (platformParts, xShift, width)", () => {
    const app = { kind: 'lineCheckerPlat', platformParts: PARTS, xShift: 0x18, width: 48 }
    expect(buildSprite(sd(0x63, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'ropeMechanism' → RopeMechanismAppearance (motorFrames[], bodyTemplate, knotTemplate, smokePuffFrames[], segmentCount)", () => {
    const app = {
      kind: 'ropeMechanism',
      motorFrames: [PARTS],
      bodyTemplate: PARTS,
      knotTemplate: PARTS,
      smokePuffFrames: [PARTS],
      segmentCount: 3,
    }
    expect(buildSprite(sd(0x7b, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'spikeTop' → SpikeTopAppearance (parts0, parts1)", () => {
    const app = { kind: 'spikeTop', parts0: PARTS, parts1: PARTS }
    expect(buildSprite(sd(0x2e, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  // Three DISTINCT lists, of distinct lengths. Passing PARTS for all
  // three left any permutation of the three constructor arguments green.
  const MOLE_DESC = {
    kind: 'montyMole',
    parts0: [{ ...PART, charNum: 0x11 }],
    parts1: [
      { ...PART, charNum: 0x22 },
      { ...PART, charNum: 0x23 },
    ],
    emerged: [
      { ...PART, charNum: 0x31 },
      { ...PART, charNum: 0x32 },
      { ...PART, charNum: 0x33 },
    ],
  }

  it("'montyMole' → MontyMoleAppearance (parts0, parts1, emerged)", () => {
    expect(buildSprite(sd(0x4d, MOLE_DESC), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'montyMole' rebuilds all three part lists into the right slots", () => {
    // Without the rehydrate branch reading `emerged`, the webview silently
    // gets a mole with no annotation and nothing else fails. Distinct
    // lengths mean a swapped pair goes red too.
    const sprite = buildSprite(sd(0x4d, MOLE_DESC), EMPTY_CHARS, PLACEHOLDER)
    const appearance = sprite.appearance as MontyMoleAppearance
    expect(appearance).toBeInstanceOf(MontyMoleAppearance)
    expect(appearance.parts0).toHaveLength(1)
    expect(appearance.parts1).toHaveLength(2)
    expect(appearance.emergedParts).toHaveLength(3)
  })

  it("'montyMole' with an empty emerged list rebuilds with no annotation ($4E)", () => {
    const app = { ...MOLE_DESC, emerged: [] }
    const sprite = buildSprite(sd(0x4e, app), EMPTY_CHARS, PLACEHOLDER)
    expect((sprite.appearance as MontyMoleAppearance).emergedParts).toEqual([])
  })

  it("'magikoopa' → MagikoopaAppearance (frames, dynColors)", () => {
    const app = {
      kind: 'magikoopa',
      frames: [PARTS, PARTS, PARTS, PARTS],
      dynColors: [0x7fff, 0x0000],
    }
    expect(buildSprite(sd(0x1f, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })

  it("'hammerBro' → HammerBroAppearance (parts)", () => {
    const app = { kind: 'hammerBro', parts: PARTS }
    expect(buildSprite(sd(0x9b, app), EMPTY_CHARS, PLACEHOLDER)).toBeInstanceOf(Sprite)
  })
})

// ── buildSprite - secondary branch ────────────────────────────────────────────

describe('buildSprite - secondary branch', () => {
  const STATIC_APP = { kind: 'static', parts: PARTS }

  it('secondary absent → plain Sprite (if(desc.secondary) false branch)', () => {
    const s = buildSprite(sd(0xff, STATIC_APP), EMPTY_CHARS, PLACEHOLDER)
    expect(s).toBeInstanceOf(Sprite)
    expect(s).not.toBeInstanceOf(CompositeSprite)
  })

  it('secondary present → CompositeSprite (if(desc.secondary) true branch)', () => {
    const child = sd(0xff, STATIC_APP) // minimal child descriptor
    const s = buildSprite(sd(0xff, STATIC_APP, child), EMPTY_CHARS, PLACEHOLDER)
    expect(s).toBeInstanceOf(CompositeSprite)
  })
})
