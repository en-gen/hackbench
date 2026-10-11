/**
 * serialize.ts helper exports - branch coverage.
 *
 * Covers the branches missed by the ROM-gated round-trip test (which skips
 * when the vanilla ROM is absent):
 *   serializeCharBehavior  - StaticPixels / AnimatedPixels / PSwitchAlt
 *   serializeTileBehavior  - all 8 TileBehavior types + optional-quad ternaries
 *   serializeColor         - StaticColor / CyclingColor
 *   serializeSprite        - reactRangeDy branch, CompositeSprite branch,
 *                            and every non-Static SpriteAppearance type
 */

import { describe, it, expect } from 'vitest'
import {
  serializeCharBehavior,
  serializeTileBehavior,
  serializeColor,
  serializeSprite,
} from '../../../../src/rom/model/serialize'

import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { AnimatedPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/AnimatedPixelsBehavior'
import { PSwitchAlternateBehavior } from '../../../../src/rom/model/chars/behaviors/PSwitchAlternateBehavior'

import { Color } from '../../../../src/rom/model/palette/Color'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { CyclingColorBehavior } from '../../../../src/rom/model/palette/behaviors/CyclingColorBehavior'

import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { VineSourceBehavior } from '../../../../src/rom/model/tiles/behaviors/VineSourceBehavior'
import { StarOneUpVineBlockBehavior } from '../../../../src/rom/model/tiles/behaviors/StarOneUpVineBlockBehavior'
import { KeyCoinBalloonKoopaBlockBehavior } from '../../../../src/rom/model/tiles/behaviors/KeyCoinBalloonKoopaBlockBehavior'
import { PipeVariantsBehavior } from '../../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import { SwitchPalaceAlternateBehavior } from '../../../../src/rom/model/tiles/behaviors/SwitchPalaceAlternateBehavior'
import { PSwitchRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/PSwitchRevealBehavior'
import { InvisibleBlockRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/InvisibleBlockRevealBehavior'

import { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import { CompositeSprite } from '../../../../src/rom/model/sprites/CompositeSprite'
import { StaticSpriteAppearance } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { ThwompAppearance } from '../../../../src/rom/model/sprites/appearances/ThwompAppearance'
import { RipVanFishAppearance } from '../../../../src/rom/model/sprites/appearances/RipVanFishAppearance'
import { WingedSpriteAppearance } from '../../../../src/rom/model/sprites/appearances/WingedSpriteAppearance'
import { HammerBroPlatformAppearance } from '../../../../src/rom/model/sprites/appearances/HammerBroPlatformAppearance'
import { SuperKoopaAppearance } from '../../../../src/rom/model/sprites/appearances/SuperKoopaAppearance'
import { VolcanoLotusAppearance } from '../../../../src/rom/model/sprites/appearances/VolcanoLotusAppearance'
import { RopeMechanismAppearance } from '../../../../src/rom/model/sprites/appearances/RopeMechanismAppearance'
import { LineCheckerPlatAppearance } from '../../../../src/rom/model/sprites/appearances/LineCheckerPlatAppearance'
import { LineBrownPlatAppearance } from '../../../../src/rom/model/sprites/appearances/LineBrownPlatAppearance'
import { SpikeTopAppearance } from '../../../../src/rom/model/sprites/appearances/SpikeTopAppearance'
import { MontyMoleAppearance } from '../../../../src/rom/model/sprites/appearances/MontyMoleAppearance'
import { HammerBroAppearance } from '../../../../src/rom/model/sprites/appearances/HammerBroAppearance'
import { PSwitchAppearance } from '../../../../src/rom/model/sprites/appearances/PSwitchAppearance'

// ── shared fixtures ───────────────────────────────────────────────────────────

const PIXELS = new Uint8Array(64)
const MOCK_CHAR = new Char(42, { getPixels: () => PIXELS })
const ST = (id = 42) =>
  new SubTile(new Char(id, { getPixels: () => PIXELS }), 8, false, false, false)
const QUAD = [ST(), ST(), ST(), ST()] as const
const NO_PARTS = [] as const

const MOCK_BEH = { kind: 'mock' }

function makeSprite(
  appearance:
    | StaticSpriteAppearance
    | ThwompAppearance
    | RipVanFishAppearance
    | WingedSpriteAppearance
    | HammerBroPlatformAppearance
    | SuperKoopaAppearance
    | VolcanoLotusAppearance
    | RopeMechanismAppearance
    | LineCheckerPlatAppearance
    | LineBrownPlatAppearance
    | SpikeTopAppearance
    | HammerBroAppearance
    | PSwitchAppearance
    | MontyMoleAppearance,
) {
  return new Sprite(0x04, 32, 32, appearance, MOCK_BEH)
}

// ── serializeCharBehavior ─────────────────────────────────────────────────────

describe('serializeCharBehavior', () => {
  it('StaticPixelsBehavior → kind=static', () => {
    const d = serializeCharBehavior(new StaticPixelsBehavior(PIXELS))
    expect(d.kind).toBe('static')
  })

  it('AnimatedPixelsBehavior → kind=animated with two frames', () => {
    const d = serializeCharBehavior(new AnimatedPixelsBehavior([PIXELS, PIXELS]))
    expect(d.kind).toBe('animated')
  })

  it('PSwitchAlternateBehavior → kind=pSwitchAlt with nested normal/alt', () => {
    const normal = new StaticPixelsBehavior(PIXELS)
    const alt = new StaticPixelsBehavior(new Uint8Array(64).fill(1))
    const d = serializeCharBehavior(new PSwitchAlternateBehavior(normal, alt))
    expect(d.kind).toBe('pSwitchAlt')
    if (d.kind !== 'pSwitchAlt') throw new Error('type guard')
    expect(d.normal.kind).toBe('static')
    expect(d.alt.kind).toBe('static')
  })
})

// ── serializeTileBehavior - optional quad branches ────────────────────────────

describe('serializeTileBehavior - all TileBehavior types', () => {
  it('StaticQuadBehavior → kind=static', () => {
    expect(serializeTileBehavior(new StaticQuadBehavior(QUAD)).kind).toBe('static')
  })

  it('VineSourceBehavior with overlayQuad=null → overlayQuad null (falsy ternary branch)', () => {
    const d = serializeTileBehavior(new VineSourceBehavior(QUAD, null))
    expect(d.kind).toBe('vineSource')
    if (d.kind !== 'vineSource') throw new Error()
    expect(d.overlayQuad).toBeNull()
  })

  it('VineSourceBehavior with overlayQuad present → overlayQuad serialized (truthy ternary branch)', () => {
    const d = serializeTileBehavior(new VineSourceBehavior(QUAD, QUAD))
    if (d.kind !== 'vineSource') throw new Error()
    expect(d.overlayQuad).not.toBeNull()
  })

  it('StarOneUpVineBlockBehavior with vineOverlayQuad=null, mixed char arrays', () => {
    // [MOCK_CHAR, null] exercises both ?.id branches (non-null char and null char)
    const d = serializeTileBehavior(
      new StarOneUpVineBlockBehavior(QUAD, null, [MOCK_CHAR, null], [null, MOCK_CHAR]),
    )
    expect(d.kind).toBe('starOneUpVineBlock')
    if (d.kind !== 'starOneUpVineBlock') throw new Error()
    expect(d.vineOverlayQuad).toBeNull()
    expect(d.oneupCharNums).toContain(42) // MOCK_CHAR.id
    expect(d.oneupCharNums).toContain(-1) // null → -1
  })

  it('StarOneUpVineBlockBehavior with vineOverlayQuad present', () => {
    const d = serializeTileBehavior(new StarOneUpVineBlockBehavior(QUAD, QUAD, [], []))
    if (d.kind !== 'starOneUpVineBlock') throw new Error()
    expect(d.vineOverlayQuad).not.toBeNull()
  })

  it('KeyCoinBalloonKoopaBlockBehavior with mixed char arrays', () => {
    const mixed = [MOCK_CHAR, null] as const
    const d = serializeTileBehavior(
      new KeyCoinBalloonKoopaBlockBehavior(QUAD, mixed, mixed, mixed, mixed),
    )
    expect(d.kind).toBe('keyCoinBalloonKoopaBlock')
    if (d.kind !== 'keyCoinBalloonKoopaBlock') throw new Error()
    expect(d.keyCharNums).toContain(42)
    expect(d.keyCharNums).toContain(-1)
  })

  it('PipeVariantsBehavior → kind=pipeVariants', () => {
    expect(serializeTileBehavior(new PipeVariantsBehavior([QUAD, QUAD, QUAD, QUAD])).kind).toBe(
      'pipeVariants',
    )
  })

  it('SwitchPalaceAlternateBehavior → kind=switchPalaceAlternate', () => {
    expect(serializeTileBehavior(new SwitchPalaceAlternateBehavior(QUAD, QUAD, 0)).kind).toBe(
      'switchPalaceAlternate',
    )
  })

  it('PSwitchRevealBehavior → kind=pSwitchReveal', () => {
    expect(serializeTileBehavior(new PSwitchRevealBehavior(QUAD)).kind).toBe('pSwitchReveal')
  })

  it('InvisibleBlockRevealBehavior with rewardOverlayQuad=null (falsy ternary branch)', () => {
    const d = serializeTileBehavior(new InvisibleBlockRevealBehavior(QUAD, null))
    expect(d.kind).toBe('invisibleBlockReveal')
    if (d.kind !== 'invisibleBlockReveal') throw new Error()
    expect(d.rewardOverlayQuad).toBeNull()
  })

  it('InvisibleBlockRevealBehavior with rewardOverlayQuad present (truthy ternary branch)', () => {
    const d = serializeTileBehavior(new InvisibleBlockRevealBehavior(QUAD, QUAD))
    if (d.kind !== 'invisibleBlockReveal') throw new Error()
    expect(d.rewardOverlayQuad).not.toBeNull()
  })
})

// ── serializeColor ────────────────────────────────────────────────────────────

describe('serializeColor', () => {
  const RED = { r: 255, g: 0, b: 0, a: 255 } as const

  it('StaticColorBehavior → kind=static', () => {
    const d = serializeColor(new Color(new StaticColorBehavior(RED)))
    expect(d.kind).toBe('static')
    if (d.kind !== 'static') throw new Error()
    expect(d.value).toEqual(RED)
  })

  it('CyclingColorBehavior → kind=cycling', () => {
    const d = serializeColor(new Color(new CyclingColorBehavior([RED, RED])))
    expect(d.kind).toBe('cycling')
  })
})

// ── serializeSprite - reactRangeDy branch ────────────────────────────────────

describe('serializeSprite - reactRangeDy branch', () => {
  it('behavior with reactRangeDy defined → included in descriptor', () => {
    const sprite = new Sprite(0x26, 64, 80, new StaticSpriteAppearance(NO_PARTS), {
      kind: 'sprite_26',
      reactRangeDy: 48,
    })
    const d = serializeSprite(sprite)
    expect(d.behavior.reactRangeDy).toBe(48)
  })
})

// ── serializeSprite - CompositeSprite + secondary branch ─────────────────────

describe('serializeSprite - CompositeSprite with secondary', () => {
  it('CompositeSprite with secondary → descriptor includes secondary', () => {
    const secondary = new Sprite(0x9b, 64, 64, new StaticSpriteAppearance(NO_PARTS), MOCK_BEH)
    const composite = new CompositeSprite(
      0x9c,
      64,
      80,
      new StaticSpriteAppearance(NO_PARTS),
      MOCK_BEH,
      secondary,
    )
    const d = serializeSprite(composite)
    expect(d.secondary).toBeDefined()
    expect(d.secondary?.id).toBe(0x9b)
  })

  it('CompositeSprite without secondary → no secondary in descriptor', () => {
    const composite = new CompositeSprite(
      0x9c,
      64,
      80,
      new StaticSpriteAppearance(NO_PARTS),
      MOCK_BEH,
    )
    const d = serializeSprite(composite)
    expect(d.secondary).toBeUndefined()
  })
})

// ── serializeAppearance - all non-Static appearance types ─────────────────────

describe('serializeAppearance - ThwompAppearance → kind=thwomp', () => {
  it('serializes correctly', () => {
    const d = serializeSprite(makeSprite(new ThwompAppearance(NO_PARTS, NO_PARTS, NO_PARTS)))
    expect(d.appearance.kind).toBe('thwomp')
  })
})

describe('serializeAppearance - RipVanFishAppearance → kind=ripVanFish', () => {
  it('serializes correctly', () => {
    const app = new RipVanFishAppearance([NO_PARTS, NO_PARTS], [NO_PARTS, NO_PARTS], NO_PARTS)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('ripVanFish')
  })
})

describe('serializeAppearance - WingedSpriteAppearance → kind=wingedSprite', () => {
  it('serializes correctly', () => {
    const app = new WingedSpriteAppearance(NO_PARTS, [NO_PARTS, NO_PARTS])
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('wingedSprite')
  })
})

describe('serializeAppearance - HammerBroPlatformAppearance → kind=hammerBroPlatform', () => {
  it('serializes correctly', () => {
    const app = new HammerBroPlatformAppearance(NO_PARTS, [NO_PARTS, NO_PARTS])
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('hammerBroPlatform')
  })
})

describe('serializeAppearance - SuperKoopaAppearance → kind=superKoopa', () => {
  it('serializes correctly', () => {
    const pose = { flapA: NO_PARTS, flapB: NO_PARTS } as const
    const app = new SuperKoopaAppearance(pose, pose, pose, pose, false)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('superKoopa')
  })
})

describe('serializeAppearance - VolcanoLotusAppearance → kind=volcanoLotus', () => {
  it('serializes correctly', () => {
    const app = new VolcanoLotusAppearance(NO_PARTS, [NO_PARTS, NO_PARTS])
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('volcanoLotus')
  })
})

describe('serializeAppearance - RopeMechanismAppearance → kind=ropeMechanism', () => {
  it('serializes correctly', () => {
    const app = new RopeMechanismAppearance([NO_PARTS], NO_PARTS, NO_PARTS, [NO_PARTS], 3)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('ropeMechanism')
  })
})

describe('serializeAppearance - LineCheckerPlatAppearance → kind=lineCheckerPlat', () => {
  it('serializes correctly', () => {
    const app = new LineCheckerPlatAppearance(NO_PARTS, 0x28, 80)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('lineCheckerPlat')
  })
})

describe('serializeAppearance - LineBrownPlatAppearance → kind=lineBrownPlat', () => {
  it('serializes correctly', () => {
    const app = new LineBrownPlatAppearance(NO_PARTS, 'forward')
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('lineBrownPlat')
  })
})

describe('serializeAppearance - SpikeTopAppearance → kind=spikeTop', () => {
  it('serializes correctly', () => {
    const app = new SpikeTopAppearance(NO_PARTS, NO_PARTS)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('spikeTop')
  })

  it('carries a flipped pose across the payload boundary (#134)', () => {
    const flipped = [{ char: MOCK_CHAR, palette: 8, flipX: true, flipY: false, dx: 8, dy: 0 }]
    const d = serializeSprite(makeSprite(new SpikeTopAppearance(flipped, flipped)))
    expect(d.appearance).toMatchObject({ parts0: [{ flipX: true }], parts1: [{ flipX: true }] })
  })
})

describe('serializeAppearance - MontyMoleAppearance → kind=montyMole', () => {
  it('serializes both SubSprGfx0 frames, not the StaticSpriteAppearance fallback', () => {
    const app = MontyMoleAppearance.fromParts(NO_PARTS)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('montyMole')
  })

  it('carries the emerged annotation across the payload boundary', () => {
    // The annotation is constructor state; without this field the webview
    // rehydrates a mole with no ghost and nothing else goes red.
    const emerged = [
      { char: MOCK_CHAR, palette: 8, flipX: false, flipY: false, dx: 0, dy: 0 },
      { char: MOCK_CHAR, palette: 8, flipX: false, flipY: false, dx: 8, dy: 0 },
    ]
    const app = new MontyMoleAppearance(NO_PARTS, NO_PARTS, emerged)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('montyMole')
    const desc = d.appearance as { kind: 'montyMole'; emerged: readonly unknown[] }
    expect(desc.emerged).toHaveLength(2)
  })

  it('$4E (fromParts) serializes an empty emerged list', () => {
    const d = serializeSprite(makeSprite(MontyMoleAppearance.fromParts(NO_PARTS)))
    expect((d.appearance as { emerged: readonly unknown[] }).emerged).toEqual([])
  })
})

describe('serializeAppearance - HammerBroAppearance → kind=hammerBro', () => {
  it('serializes correctly', () => {
    const app = new HammerBroAppearance(NO_PARTS)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('hammerBro')
  })
})

describe('serializeAppearance - PSwitchAppearance → kind=static (issue #293)', () => {
  it('serializes through the StaticSpriteAppearance branch', () => {
    // PSwitchAppearance now extends StaticSpriteAppearance; the payload
    // ships `{kind: 'static', parts}` and the webview's
    // `buildSpriteAppearance(spriteId=0x3E, parts)` reconstructs the
    // PSwitchAppearance class. Single-registration replaces the old
    // `pSwitch` kind branch.
    const app = new PSwitchAppearance(NO_PARTS)
    const d = serializeSprite(makeSprite(app))
    expect(d.appearance.kind).toBe('static')
  })
})

// ── serializeSprite - behavior metadata true branches ────────────────────────

describe('serializeSprite - displayName/spawns/isGenerator defined (true branches)', () => {
  it('includes displayName, spawns, and isGenerator in output when all are defined', () => {
    // Covers the three `if (s.behavior.X !== undefined)` true branches
    // in serializeSprite (serialize.ts) that are never reached by other
    // tests whose MOCK_BEH omits those fields.
    const beh = {
      kind: 'sprite_3e',
      displayName: 'P-Switch',
      spawns: 0x3f,
      isGenerator: true,
    }
    const sprite = new Sprite(0x3e, 32, 32, new StaticSpriteAppearance(NO_PARTS), beh)
    const d = serializeSprite(sprite)
    expect(d.behavior.displayName).toBe('P-Switch')
    expect(d.behavior.spawns).toBe(0x3f)
    expect(d.behavior.isGenerator).toBe(true)
  })
})
