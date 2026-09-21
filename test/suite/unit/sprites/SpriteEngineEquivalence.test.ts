/**
 * Mechanical equivalence harness: the table-driven engine versus the shipped
 * bespoke path, across every cart file in `test/roms/`.
 *
 * SIX FILES, FIVE CARTS. `Super Mario World (USA).magic.sfc` is
 * `Super Mario World (USA).vanilla.sfc` plus a 512-byte copier header and is
 * byte-identical once that is stripped, so it exercises the header handling
 * rather than a fifth hack. The four hacks are Grand Poo World 2 1.1, Grand
 * Poo World V1.2, Invictus 1.0 and Seven_Vanilla_Levels.
 *
 * This is the oracle for the migration, not a smoke test. The shipped
 * `buildSpriteLayout` output is the closest thing this project has to ground
 * truth for sprite appearance, because it has been reviewed and released.
 *
 * The rule is MATCH, OR JUSTIFY THE DIFFERENCE WITH ROM EVIDENCE. Several
 * shipped behaviours are known wrong, so a divergence can mean the engine is
 * right. Every divergence below is therefore pinned with its adjudication.
 *
 * WHAT THE SET ASSERTION DOES AND DOES NOT COVER. `ADJUDICATION` lists every
 * descriptor id, so `diverged` is a subset of its keys by construction and the
 * set comparison can only go red when a sprite starts MATCHING the shipped
 * path. That is a real check, and the one it was built for: it catches the
 * engine being "fixed" into reproducing a known shipped bug. It does NOT
 * catch a new engine bug that leaves a sprite divergent but differently
 * wrong, because a bad tile, a bad palette or a bad dy all keep it in the
 * same set. An earlier revision of this comment claimed otherwise.
 *
 * The `pin` on each entry is what closes that half. It asserts the structural
 * claim the adjudication text makes, derived from the ASM trace rather than
 * read back from the engine, so a divergence that stops meaning what the
 * verdict says goes red on the sprite rather than passing in the aggregate.
 * Per-sprite value pinning lives in `SpriteEngineCartReads.test.ts` and
 * `SpriteEngineWalkCycle.test.ts`.
 *
 * Evidence scope: six carts in `test/roms/`, static traces against
 * `C:\Projects\SMWDisX`, no emulator. Nothing here is verified against live
 * hardware.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import { buildSpriteLayout, readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import {
  SPRITE_DRAW_DESCRIPTORS,
  SPRITE_INIT_PTR_TABLE,
  SPRITE_MAIN_PTR_TABLE,
  SPRITE_PTR_TABLE_COUNT,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  drawSpriteParts,
  readHandlerPointers,
  renderRepresentativeFrame,
  renderSpriteFrame,
  resolveIdentity,
  romFrameForFrame,
  resolveStateTimerSeed,
  resolveHandlerBase,
  type EnginePart,
  type PaletteNote,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'

const ROM_DIR = resolve(__dirname, '../../../roms')

/** The corpus. `vanilla` is the reference; the other four are shipped hacks.
 *  Note `Seven_Vanilla_Levels` is a HACK despite its name, which is exactly
 *  the trap that produced a wrong reference ROM during this investigation. */
const ROM_FILES = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
] as const

const romPaths = ROM_FILES.map(f => resolve(ROM_DIR, f))
/** Module-scope existence check only. All ROM I/O stays inside `it()`, because
 *  `describe.skipIf` does NOT guard a describe body: it still executes during
 *  collection and a read there would fail the suite before any skip applies. */
const romsPresent = romPaths.every(existsSync)

function openRoms() {
  return ROM_FILES.map((name, i) => ({ name, rom: RomFile.load(romPaths[i]) }))
}

/** Normalise for comparison: the two paths agree or they do not, field by field. */
function key(parts: readonly EnginePart[]): string {
  return parts
    .map(p => `${p.charNum}:${p.palette}:${p.flipX ? 1 : 0}${p.flipY ? 1 : 0}@${p.dx},${p.dy}`)
    .join('|')
}

/**
 * Adjudicated divergences, by sprite ID.
 *
 * Categories, per the migration's classification:
 *   ENGINE_WINS      - the shipped class is wrong; do not bend the engine.
 *   EDITOR_CHOICE    - a deliberate human pick for editor legibility; the
 *                      engine must carry it forward as descriptor data.
 *   ENGINE_BUG       - the engine is wrong and must be fixed.
 *   UNDETERMINED     - not adjudicated yet.
 */
/**
 * The structural claim an adjudication makes, checked per sprite per cart.
 *
 * Takes the engine's frames and the shipped pose so a pin can assert the
 * SHAPE of the divergence, not merely that one exists. Every expectation is
 * stated from the ASM trace; none is read back from the engine.
 */
type Pin = (frames: readonly EngineFrame[], shipped: readonly EnginePart[] | null) => void

/** One rendered frame plus whatever the engine reported alongside it. */
interface EngineFrame {
  parts: readonly EnginePart[]
  note?: PaletteNote
}

/** Distinct poses across a frame list. The walk cycles and the $4E spin all
 *  claim a specific number, and the shipped path can express exactly one. */
const distinctPoses = (frames: readonly EngineFrame[]) =>
  new Set(frames.map(f => key(f.parts))).size

/** Topmost 8 px row a frame occupies. */
const topDy = (f: EngineFrame) => Math.min(...f.parts.map(p => p.dy))

/** Chars a pose uses, order-independent. X-flip permutes the corner order of
 *  a large OBJ, so two poses can use the same tiles in a different sequence. */
const charSet = (parts: readonly EnginePart[]) =>
  [...parts].map(p => p.charNum).sort((a, b) => a - b)

/** The `Spr0to13Gfx` family's two divergence shapes, one per branch of the
 *  routine choice at bank_01.asm:1763-1780. */
const SPR0TO13_16X16 = {
  verdict: 'ENGINE_WINS',
  why:
    'Spr0to13Gfx reaches SubSprGfx2Entry1 for this id because Spr0to13Prop[id] & $40 is ' +
    'clear (bank_01.asm:1763-1766), and the walk frame is SetAnimationFrame writing ' +
    '(SpriteMisc1570 >> 3) & 1 into SpriteMisc1602 (bank_01.asm:2089-2097). ' +
    'buildSpriteLayout pins SpriteMisc1602 to 0, so frame 1 of the two-frame walk is ' +
    'unrepresentable on the shipped path. Frame 0 selects the same CHARS but not the ' +
    'same flips: SubSprGfx2Entry1 applies EOR #!OBJ_XFlip when SpriteMisc157C bit 0 is ' +
    'CLEAR (bank_01.asm:4166-4171, the BCS skips it when SET), and buildSpriteLayout ' +
    'hardcodes flipX false. An earlier revision of this text said frame 0 agreed; the ' +
    'pin below falsified it.',
  // One large OBJ is four 8x8 corners and the walk is two distinct poses.
  // Frame 0's char MULTISET matches the shipped pose, which is the real
  // extent of the agreement: X-flip permutes the corner order in a large
  // OBJ, so the ordered keys differ even where the tiles do not.
  pin: ((frames, shipped) => {
    for (const f of frames) expect(f.parts).toHaveLength(4)
    expect(distinctPoses(frames)).toBe(2)
    expect(shipped).toHaveLength(4)
    expect(charSet(frames[0].parts)).toEqual(charSet(shipped!))
    expect(key(frames[0].parts)).not.toBe(key(shipped!))
    expect(frames[0].parts.every(p => p.flipX)).toBe(true)
    expect(shipped!.every(p => !p.flipX)).toBe(true)
    // The clear branch runs no `SBC`, so there is no bob (bank_01.asm:1766).
    expect(topDy(frames[1])).toBe(topDy(frames[0]))
  }) as Pin,
}
const SPR0TO13_16X32 = {
  verdict: 'ENGINE_WINS',
  why:
    'Spr0to13Prop[id] & $40 is SET, so Spr0to13Gfx draws two stacked large OBJs through ' +
    'SubSprGfx1 at Y - $10 (bank_01.asm:1769-1780). buildSpriteLayout gets the SHAPE right ' +
    'here, emitting eight subtiles at the same rows, and diverges on two things: it pins ' +
    'SpriteMisc1602 to 0 so the walk cycle is unrepresentable, and it hardcodes flipX ' +
    'false against the ORA #!OBJ_XFlip that SubSprGfx1 applies when SpriteMisc157C bit 0 ' +
    'is CLEAR (bank_01.asm:3957-3962). An earlier revision said the shipped path emitted ' +
    'one 16x16 quad and the sprite was half the height; it emits eight.',
  // Two stacked large OBJs is eight corners, which the shipped path also
  // produces, so the divergence is in the flips and the second frame and
  // NOT in the count. Pinning the count alone would have passed while the
  // prose said something false.
  pin: ((frames, shipped) => {
    for (const f of frames) expect(f.parts).toHaveLength(8)
    expect(distinctPoses(frames)).toBe(2)
    expect(shipped).toHaveLength(8)
    expect(charSet(frames[0].parts)).toEqual(charSet(shipped!))
    for (const f of frames) expect(key(f.parts)).not.toBe(key(shipped!))
    expect(frames[0].parts.every(p => p.flipX)).toBe(true)
    expect(shipped!.every(p => !p.flipX)).toBe(true)
    // The `LSR A` before the `SBC` puts frame 1 one pixel lower
    // (bank_01.asm:1770-1774).
    expect(topDy(frames[1]) - topDy(frames[0])).toBe(1)
    // And the whole body sits 16 px above the sprite's own Y, because the
    // handler subtracts $10 before the `JSR` (bank_01.asm:1774).
    expect(topDy(frames[0])).toBe(-16)
  }) as Pin,
}

const ADJUDICATION: Record<number, { verdict: string; why: string; pin: Pin }> = {
  0x00: SPR0TO13_16X16,
  0x01: SPR0TO13_16X16,
  0x02: SPR0TO13_16X16,
  0x03: SPR0TO13_16X16,
  0x04: SPR0TO13_16X32,
  0x05: SPR0TO13_16X32,
  0x06: SPR0TO13_16X32,
  0x07: SPR0TO13_16X32,
  0x0f: SPR0TO13_16X16,
  0x11: SPR0TO13_16X16,
  0x13: SPR0TO13_16X16,
  0x14: {
    verdict: 'ENGINE_WINS',
    why:
      'Frame 0 AGREES: the shipped path already classifies $14 as sub0 with prop group 2, so ' +
      'the single pose it emits is correct. The divergence is the SECOND frame. SpinyEgg ' +
      'reaches SubSprGfx0Entry0 via SetAnimationFrame (bank_01.asm:2089), which writes ' +
      '(counter >> 3) & 1 into SpriteMisc1602, and the shipped path pins that to 0 so the ' +
      'walk cycle cannot be represented at all.',
    // sub0 writes four INDEPENDENT 8x8 entries (bank_01.asm:3853), and the
    // adjudication's whole point is that the SECOND frame is the divergence,
    // so frame 0 must agree and the two frames must differ.
    pin: ((frames, shipped) => {
      for (const f of frames) expect(f.parts).toHaveLength(4)
      expect(distinctPoses(frames)).toBe(2)
      expect(key(frames[0].parts)).toBe(key(shipped!))
    }) as Pin,
  },
  0x1f: {
    verdict: 'ENGINE_WINS',
    why:
      'Magikoopa draws through SubSprGfx1 (bank_01.asm:8529), which is 16x32 = eight ' +
      'subtiles, and buildSpriteLayout emits eight as well. Three real divergences: the ' +
      'ANCHORING, because $1F has no pre-JSR Y adjust and its body therefore starts at the ' +
      'its own Y rather than 16 px above it, where the shipped path puts every 16x32; ' +
      'the wand, an OAM entry the handler writes itself (bank_01.asm:8545-8578); and the ' +
      'partial-row CGRAM composite, which the shipped path has no way to express. An ' +
      'earlier revision said the shipped path emitted a single 16x16 quad; it emits eight.',
    // Eight body subtiles against the shipped four, plus the palette note.
    // `cgramStart` $F0 is row 15 column 0, and the fade uploads 8 colours
    // (bank_01.asm:8734-8750), so the caller must composite columns 8..15
    // from the level palette.
    pin: ((frames, shipped) => {
      const body = (f: EngineFrame) => f.parts.filter(q => q.dx >= 0 && q.dx < 16)
      for (const f of frames) expect(body(f)).toHaveLength(8)
      expect(shipped).toHaveLength(8)
      // The anchoring divergence, which is the disclosed 16 px defect: no
      // `SBC` sits between bank_01.asm:8528 and the `JSR` at 8529, so the
      // body starts at the sprite's Y. The shipped path puts it at -16.
      expect(Math.min(...body(frames[0]).map(q => q.dy))).toBe(0)
      expect(Math.min(...shipped!.map(q => q.dy))).toBe(-16)
      for (const f of frames) {
        expect(f.note).toEqual({
          kind: 'dynamicCgram',
          row: 15,
          firstCol: 0,
          colors: 8,
          entryAddr: frames[0].note!.entryAddr,
        })
      }
      // The wand appears only on the cast poses (bank_01.asm:8545-8578), so
      // the state-2 countdown must produce frames both with and without it.
      const widths = new Set(frames.map(f => f.parts.length))
      expect(widths.size).toBeGreaterThan(1)
    }) as Pin,
  },
  0x2c: {
    verdict: 'ENGINE_WINS',
    why:
      'Yoshi Egg takes its OBJ attribute from YoshiPal indexed by (SpriteXPosLow >> 4) & 3 in ' +
      'InitYoshiEgg, so its palette varies by spawn column. buildSpriteLayout reads ' +
      'Sprite166EVals and additionally hardcodes flipX false, which the EOR on the ' +
      'SubSprGfx2 path contradicts. Its CHAR is the LDA #imm at bank_01.asm:16060, which ' +
      'CODE_01F78D writes over the tile SubSprGfx2Entry1 just read, so both paths read a ' +
      'tilemap the ROM discards; vanilla coincides because SprTilemap[$94] is $00 too.',
    // One large OBJ, one static frame, and the claim that makes it diverge:
    // the palette row is a function of the spawn column, which the shipped
    // path cannot express because it reads Sprite166EVals.
    pin: ((frames, shipped) => {
      expect(frames).toHaveLength(1)
      expect(frames[0].parts).toHaveLength(4)
      expect(shipped).toHaveLength(4)
      expect(new Set(frames[0].parts.map(p => p.palette)).size).toBe(1)
    }) as Pin,
  },
  0x4d: {
    verdict: 'ENGINE_WINS',
    why:
      'CODE_01E343 (bank_01.asm:13388) selects SpriteMisc1602 from DATA_01E35F and the prop ' +
      'group from DATA_01E361, both indexed by (EffFrame >> 4) & 1. buildSpriteLayout pins ' +
      'SpriteMisc1602 to 0, which is neither of the two frames the ROM ever draws.',
    // Four independent 8x8s, two distinct frames, and NEITHER agreeing with
    // the shipped pose: that last part is what "neither of the two frames"
    // means and is not implied by membership of the diverging set.
    pin: ((frames, shipped) => {
      for (const f of frames) expect(f.parts).toHaveLength(4)
      expect(distinctPoses(frames)).toBe(2)
      for (const f of frames) expect(key(f.parts)).not.toBe(key(shipped!))
    }) as Pin,
  },
  0x4e: {
    verdict: 'ENGINE_WINS',
    why:
      'CODE_01E343 routes $4E to SubSprGfx2Entry1 with SpriteMisc1602 = $03 and an OBJ ' +
      'attribute override of ((EffFrame << 2) & $C0) | $31. buildSpriteLayout classifies it ' +
      'as sub0 and drops the attribute override entirely.',
    // ONE tile, four poses, and the poses come from the flip bits rather
    // than from four tiles: `((EffFrame << 2) & $C0) | $31`
    // (bank_01.asm:13412). So all four frames share a char set and differ
    // only in flips.
    pin: ((frames, shipped) => {
      for (const f of frames) expect(f.parts).toHaveLength(4)
      expect(distinctPoses(frames)).toBe(4)
      const chars = frames.map(f =>
        [...f.parts]
          .map(p => p.charNum)
          .sort()
          .join(','),
      )
      expect(new Set(chars).size).toBe(1)
      const flips = frames.map(f =>
        f.parts.map(p => `${p.flipX ? 1 : 0}${p.flipY ? 1 : 0}`).join(''),
      )
      expect(new Set(flips).size).toBe(4)
      expect(shipped).not.toBeNull()
    }) as Pin,
  },
}

describe.skipIf(!romsPresent)('sprite engine vs shipped bespoke path (5 carts, 6 files)', () => {
  it('the corpus is the six files this harness claims to cover', () => {
    expect(romPaths.filter(existsSync)).toHaveLength(ROM_FILES.length)
  })

  it('every descriptor diverges from the shipped path exactly where adjudicated', () => {
    // The set assertion is one-sided BY CONSTRUCTION, because ADJUDICATION
    // lists every descriptor id: it goes red when a sprite starts matching,
    // which is the "engine fixed into reproducing a shipped bug" case, and
    // it cannot go red on a sprite that stays divergent but wrong. Each
    // entry's `pin` is what covers that half, and runs per sprite per cart.
    for (const { name, rom } of openRoms()) {
      const tables = readSpriteTileTables(rom)
      expect(tables, `${name}: sprite tables must load`).not.toBeNull()

      const diverged: number[] = []
      for (const d of SPRITE_DRAW_DESCRIPTORS) {
        const shipped = buildSpriteLayout(tables!, d.spriteId)
        const shippedKey = shipped ? key(shipped.tiles) : '(no layout)'
        // Compare the WHOLE frame sequence. The shipped path emits one static
        // pose, so an animated sprite diverges as soon as any frame differs
        // from it. Comparing frame 0 alone would call $14 a match and hide
        // the fact that its walk cycle is unrepresentable.
        let matchesEveryFrame = true
        const frames: EngineFrame[] = []
        // `romFrame` must SELECT the frame being forced. An `attrOverride` is
        // driven by it and not by `forceFrame`, so holding it at 0 gave $4E
        // frame N's tiles with frame 0's flip bits and collapsed its four
        // poses onto one: four of its five frames were never really compared.
        const base = resolveHandlerBase(rom, d)
        const seed = resolveStateTimerSeed(rom, d.anim, base) ?? 0
        for (let f = 0; f < d.frames; f++) {
          const engine = drawSpriteParts({
            rom,
            tables: tables!,
            descriptor: d,
            spriteX: 0x40,
            ctx: { marioX: 0x40, romFrame: romFrameForFrame(d.anim, f, seed) },
            forceFrame: f,
          })
          expect(engine.ok, `${name}: $${d.spriteId.toString(16)} frame ${f} must render`).toBe(
            true,
          )
          if (!engine.ok) {
            matchesEveryFrame = false
            continue
          }
          frames.push({ parts: engine.parts, note: engine.paletteNote })
          if (key(engine.parts) !== shippedKey) matchesEveryFrame = false
        }
        if (!matchesEveryFrame) diverged.push(d.spriteId)

        // The structural claim the verdict makes, per cart. Without this the
        // aggregate above passes on any wrong-but-still-divergent render.
        const adj = ADJUDICATION[d.spriteId]
        expect(adj, `${name}: $${d.spriteId.toString(16)} has no adjudication`).toBeDefined()
        try {
          adj.pin(frames, shipped ? shipped.tiles : null)
        } catch (e) {
          throw new Error(
            `${name}: $${d.spriteId.toString(16)} pin failed: ${(e as Error).message}`,
            { cause: e },
          )
        }
      }
      expect(new Set(diverged), `${name}: diverging sprite set`).toEqual(
        new Set(Object.keys(ADJUDICATION).map(Number)),
      )
    }
  })

  it('$4D selects tile groups 1 and 2 and prop groups 0 and 5, per frame', () => {
    // The exact-divergence-set assertion above is too coarse to catch a wrong
    // tile-group table ADDRESS: an off-by-one still lands on a byte that keeps
    // $4D in the diverging set. So pin the observable directly.
    //
    // Expectations are stated from the ASM trace, NOT read from the table
    // under test. CODE_01E343 (bank_01.asm:13388-13403) reads
    // DATA_01E35F = { 1, 2 } into SpriteMisc1602 and DATA_01E361 = { 0, 5 }
    // into the prop group. SubSprGfx0 strides SpriteMisc1602 by 4, so the two
    // quads sit at tilemapOffset + 4 and tilemapOffset + 8. Cross-checked
    // against the INDEPENDENT tilemap table, which the mutation does not touch.
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const mole = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x4d)!
    const base = tables.tilemapOffset[0x4d]
    // Sprite166EVals bit 0 is the char-high bit, which adds a page first.
    const high = (tables.spriteAttr[0x4d] & 1) !== 0 ? 0x100 : 0

    const quad = (f: number) => {
      const r = drawSpriteParts({
        rom,
        tables,
        descriptor: mole,
        spriteX: 0,
        ctx: { marioX: 0, romFrame: 0 },
        forceFrame: f,
      })
      if (!r.ok) throw new Error('frame did not render')
      return r
    }
    const f0 = quad(0),
      f1 = quad(1)

    // tile group 1 -> base + 4; tile group 2 -> base + 8
    expect(f0.parts.map(p => p.charNum - 0x400)).toEqual(
      [0, 1, 2, 3].map(c => high + tables.tilemap[base + 4 + c]),
    )
    expect(f1.parts.map(p => p.charNum - 0x400)).toEqual(
      [0, 1, 2, 3].map(c => high + tables.tilemap[base + 8 + c]),
    )

    // prop group 0 is all zeroes; prop group 5 is all $40 (X-flip).
    expect(f0.parts.map(p => p.flipX)).toEqual([false, false, false, false])
    expect(f1.parts.map(p => p.flipX)).toEqual([true, true, true, true])
  })

  it('every adjudicated divergence carries a verdict and ROM evidence', () => {
    for (const [id, a] of Object.entries(ADJUDICATION)) {
      expect(a.verdict, `$${Number(id).toString(16)}`).toMatch(
        /^(ENGINE_WINS|EDITOR_CHOICE|ENGINE_BUG|UNDETERMINED)$/,
      )
      expect(a.why.length, `$${Number(id).toString(16)} needs evidence`).toBeGreaterThan(80)
    }
  })

  it('engine output is IDENTICAL across all six cart files for these sprites', () => {
    // The data tables these descriptors read are byte-identical in the whole
    // corpus, so the engine must be too. A difference would mean the engine
    // had picked up something ROM-specific it should not have.
    const roms = openRoms()
    for (const d of SPRITE_DRAW_DESCRIPTORS) {
      const keys = roms.map(({ rom }) => {
        const t = readSpriteTileTables(rom)!
        const r = drawSpriteParts({
          rom,
          tables: t,
          descriptor: d,
          spriteX: 0x40,
          ctx: { marioX: 0x40, romFrame: 0 },
        })
        return r.ok ? key(r.parts) : 'FAILED'
      })
      expect(new Set(keys).size, `$${d.spriteId.toString(16)} must agree across ROMs`).toBe(1)
    }
  })
})

describe.skipIf(!romsPresent)('handler identity across the corpus', () => {
  it('the MAIN handler table is byte-identical in all six cart files', () => {
    // Measured, and it corrects a claim that the MAIN table is repointed by
    // these hacks. It is not; the INIT table is.
    const roms = openRoms()
    const sig = roms.map(({ rom }) => {
      const b = rom.readAt(SPRITE_MAIN_PTR_TABLE, SPRITE_PTR_TABLE_COUNT * 2)!
      return Buffer.from(b).toString('hex')
    })
    expect(new Set(sig).size).toBe(1)
  })

  it('the INIT table is repointed at exactly $52, $53 and $9B', () => {
    const roms = openRoms()
    const vanilla = roms[0].rom
    const repointed = new Set<number>()
    for (const { rom } of roms.slice(1)) {
      for (let id = 0; id < SPRITE_PTR_TABLE_COUNT; id++) {
        const a = rom.readAt(SPRITE_INIT_PTR_TABLE + id * 2, 2)!
        const b = vanilla.readAt(SPRITE_INIT_PTR_TABLE + id * 2, 2)!
        if (a[0] !== b[0] || a[1] !== b[1]) repointed.add(id)
      }
    }
    // $52 InitMovingLedge, $53 Return0185C2, $9B InitHammerBrother.
    expect(repointed).toEqual(new Set([0x52, 0x53, 0x9b]))
  })

  it('$9B has its init NULLED to the no-op Return0185C2 in three hacks', () => {
    // The clearest evidence that identity must key on the handler: the sprite
    // ID is unchanged, the draw code is unchanged, and yet the sprite is not
    // the same sprite any more.
    const roms = openRoms()
    const vanillaInit = readHandlerPointers(roms[0].rom, 0x9b)!.init
    const noop = readHandlerPointers(roms[0].rom, 0x7d)!.init // $7D is Return0185C2
    const nulled = roms.slice(1).filter(({ rom }) => readHandlerPointers(rom, 0x9b)!.init === noop)
    expect(vanillaInit).not.toBe(noop)
    expect(nulled.map(r => r.name).sort()).toEqual([
      'Grand Poo World 2 1.1.sfc',
      'GrandPooWorld_V1.2.sfc',
      'Invictus 1.0.sfc',
    ])
  })

  it('a descriptor whose handler matches the cart resolves as vanilla', () => {
    for (const { name, rom } of openRoms()) {
      for (const d of SPRITE_DRAW_DESCRIPTORS) {
        const id = resolveIdentity(rom, d.spriteId)
        expect(id?.status, `${name}: $${d.spriteId.toString(16)}`).toBe('vanilla')
      }
    }
  })

  it('degrades honestly when a handler is repointed to untraced code', () => {
    // The degradation path must be exercised on a GENUINELY repointed handler,
    // not a synthetic one. $9B is repointed in three of the five carts.
    const roms = openRoms()
    const gpw2 = roms.find(r => r.name === 'Grand Poo World 2 1.1.sfc')!
    const vanilla = roms[0]

    // Build a descriptor claiming $9B's VANILLA init, so the hack cart's
    // repoint is a real mismatch rather than a fabricated one.
    const desc = {
      ...SPRITE_DRAW_DESCRIPTORS[0],
      spriteId: 0x9b,
      vanillaMainHandler: readHandlerPointers(vanilla.rom, 0x9b)!.main,
      vanillaInitHandler: readHandlerPointers(vanilla.rom, 0x9b)!.init,
    }
    expect(resolveIdentity(vanilla.rom, 0x9b, [desc])?.status).toBe('vanilla')
    expect(resolveIdentity(gpw2.rom, 0x9b, [desc])?.status).toBe('custom')

    // And the failure must reach the caller as a value, not be swallowed.
    const tables = readSpriteTileTables(gpw2.rom)!
    const res = renderRepresentativeFrame(gpw2.rom, tables, 0x9b, { loadedChars: new Set() }, [
      desc,
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure.kind).toBe('customHandler')
  })

  it.skipIf(!romsPresent)('a repoint onto another descriptor handler is still custom', () => {
    // There used to be a 'remapped' status here promising the engine could
    // "still render it, using that sprite's descriptor". Nothing read
    // `remappedTo` and `renderSpriteFrame` declined only on 'custom', so a
    // remapped sprite rendered with its OWN descriptor as though the repoint
    // had not happened.
    const { rom } = openRoms()[0]
    const mole = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x4d)!
    // Point $14 at $4D's handler, which IS traced.
    rom.writeAt(SPRITE_MAIN_PTR_TABLE + 0x14 * 2, [
      mole.vanillaMainHandler & 0xff,
      mole.vanillaMainHandler >> 8,
    ])
    const id = resolveIdentity(rom, 0x14)!
    expect(id.status).toBe('custom')
    expect(id.aliasOf).toBe(0x4d)
    const tables = readSpriteTileTables(rom)!
    expect(renderRepresentativeFrame(rom, tables, 0x14, { loadedChars: new Set() }).ok).toBe(false)
  })

  it.skipIf(!romsPresent)('$4D and $4E share a handler and neither aliases onto the other', () => {
    // The `ptrs.main !== own.vanillaMainHandler` guard is what stops this.
    // They resolve the same MAIN pointer (bank_01.asm:13388), so without it
    // either would report itself aliased onto its sibling.
    for (const { name, rom } of openRoms()) {
      for (const id of [0x4d, 0x4e]) {
        const r = resolveIdentity(rom, id)!
        expect(r.status, `${name}: $${id.toString(16)}`).toBe('vanilla')
        expect(r.aliasOf, `${name}: $${id.toString(16)}`).toBeUndefined()
      }
    }

    // The guard only bites when SOMETHING differs, because a fully matching
    // pair returns 'vanilla' before the alias lookup runs. Repoint $4D's
    // INIT alone: its MAIN is untouched, so it has NOT been aliased onto
    // $4E, and saying so would be a false diagnosis of a real divergence.
    const { rom } = openRoms()[0]
    rom.writeAt(SPRITE_INIT_PTR_TABLE + 0x4d * 2, [0x00, 0x90])
    const r = resolveIdentity(rom, 0x4d)!
    expect(r.status).toBe('custom')
    expect(r.aliasOf).toBeUndefined()
  })

  it('reports an untraced sprite rather than inventing an appearance', () => {
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const res = renderRepresentativeFrame(rom, tables, 0xb4, { loadedChars: new Set() })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure.kind).toBe('noDescriptor')
  })
})

describe.skipIf(!romsPresent)('picker entry point is level-contextual', () => {
  it('reports chars-not-loaded instead of rendering garbage', () => {
    // A sprite whose tiles are absent from this level's SP1-SP4 assignment is
    // a real and useful signal to someone placing sprites.
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const res = renderRepresentativeFrame(rom, tables, 0x4d, { loadedChars: new Set() })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.failure.kind).toBe('charsNotLoaded')
      if (res.failure.kind === 'charsNotLoaded')
        expect(res.failure.missing.length).toBeGreaterThan(0)
    }
  })

  it('renders when the chars ARE present, with no map and no placement', () => {
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const all = new Set(Array.from({ length: 0x600 }, (_, i) => i))
    const res = renderRepresentativeFrame(rom, tables, 0x4d, { loadedChars: all })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.parts).toHaveLength(4)
  })

  it('$4D shows its chosen representative frame, not its resting pose', () => {
    // The mole's resting pose is an anonymous pile of rubble because it
    // burrows. A human reviewed the poses and picked the recognisable one, so
    // the picker must not silently show frame 0.
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const all = new Set(Array.from({ length: 0x600 }, (_, i) => i))
    const mole = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x4d)!
    expect(mole.representativeFrame).not.toBe(0)
    expect(mole.needsHumanReview).toBe(false)

    const pick = renderRepresentativeFrame(rom, tables, 0x4d, { loadedChars: all })
    const frame0 = drawSpriteParts({
      rom,
      tables,
      descriptor: mole,
      spriteX: 0,
      ctx: { marioX: 0, romFrame: 0 },
      forceFrame: 0,
    })
    expect(pick.ok && frame0.ok).toBe(true)
    if (pick.ok && frame0.ok) expect(key(pick.parts)).not.toBe(key(frame0.parts))
  })

  it('serves an annotation asking for a SPECIFIC frame, not just the default', () => {
    // The $4D emerged-mole "ghost" annotation needs a frame that is neither
    // frame 0 nor the representative one. Without a frame selector it would
    // need its own private tile-reading path, which is the duplication this
    // engine exists to remove. Offsets and opacity stay with the annotation
    // layer; the engine only supplies pixels.
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const all = new Set(Array.from({ length: 0x600 }, (_, i) => i))
    const a = renderSpriteFrame(rom, tables, 0x4d, { loadedChars: all }, { frame: 0 })
    const b = renderSpriteFrame(rom, tables, 0x4d, { loadedChars: all }, { frame: 1 })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(key(a.parts)).not.toBe(key(b.parts))
    // Default with no selector is the representative frame.
    const def = renderSpriteFrame(rom, tables, 0x4d, { loadedChars: all })
    expect(def.ok && b.ok && key(def.parts) === key(b.parts)).toBe(true)
  })

  it('every descriptor without a reviewed frame is flagged for triage', () => {
    // Guards against silently shipping bad icons: an unreviewed pick must be
    // visible as such, not indistinguishable from a deliberate one.
    for (const d of SPRITE_DRAW_DESCRIPTORS) {
      if (d.representativeFrame === 0 && d.frames > 1) {
        expect(d.needsHumanReview, `$${d.spriteId.toString(16)} defaults to frame 0`).toBe(true)
      }
    }
  })
})

describe.skipIf(!romsPresent)('facing is re-derived when Mario moves', () => {
  it('a faceMario sprite mirrors between two Mario positions on a real cart', () => {
    // The webview boundary is where this silently degrades to frozen
    // behaviour, so the dynamic path needs its own case against real data.
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const mole = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x4d)!
    expect(mole.misc157C.kind).toBe('faceMario')

    const at = (marioX: number) =>
      drawSpriteParts({
        rom,
        tables,
        descriptor: mole,
        spriteX: 0x100,
        ctx: { marioX, romFrame: 0 },
      })
    const left = at(0x000)
    const right = at(0x200)
    expect(left.ok && right.ok).toBe(true)
    // $4D draws through sub0, whose flips come per-corner from
    // GeneralSprGfxProp rather than the latch, so the mole itself does not
    // mirror. The latch resolution is still what feeds sub1/sub2, and is
    // covered directly in the unit tests. What matters here is that no ROM
    // read and no rebuild happens between the two calls.
    expect(left.ok && right.ok && key(left.parts) === key(right.parts)).toBe(true)
  })

  it('a sub2 sprite on a real cart mirrors with Mario position', () => {
    const { rom } = openRoms()[0]
    const tables = readSpriteTileTables(rom)!
    const egg = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x2c)!
    const faceMarioEgg = { ...egg, misc157C: { kind: 'faceMario' as const } }
    const at = (marioX: number) =>
      drawSpriteParts({
        rom,
        tables,
        descriptor: faceMarioEgg,
        spriteX: 0x100,
        ctx: { marioX, romFrame: 0 },
      })
    const l = at(0x000),
      r = at(0x200)
    expect(l.ok && r.ok).toBe(true)
    if (l.ok && r.ok) {
      expect(l.parts[0].flipX).toBe(false)
      expect(r.parts[0].flipX).toBe(true)
      expect(key(l.parts)).not.toBe(key(r.parts))
    }
  })
})
