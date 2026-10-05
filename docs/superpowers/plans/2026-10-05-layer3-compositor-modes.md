# Layer 3 on every level mode Implementation Plan

> **Execution (this repo's loop, not the skill's options):** one Sonnet
> implementer does Tasks 1 to 7 in order, in the worktree
> `C:/Projects/.worktrees/hackbench/562-layer3-compositor` (branch
> `feature/layer3-compositor-modes`). Then simplify-reviewer, adversarial-reviewer,
> the verifier (the only agent that runs Playwright) and the steward, who opens
> ONE PR labelled needs-owner. The implementer writes the Playwright specs and
> does not run them. Steps use checkbox syntax.

**Goal:** Draw layer 3 on every non-Mode-7 level mode by compositing the main and
sub screens separately and doing SNES color math between them.

**Architecture:** A pure `screenPlanes` function turns the mode tables and the
BG3 priority bit into main and sub plane lists. A pure `composeScreen` function
(`src/rom/model/`, no shell imports) composites those lists and applies
CGADSUB color math. The node backend sends the lists and the math inputs in
`MapScreenResult`; the widget runs `composeScreen` into one composite canvas per
screen on every layer toggle.

**Tech Stack:** TypeScript, Vitest (unit), Theia widget (React), Playwright specs
(`theia/browser-app/test/map-view.spec.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-05-layer3-compositor-modes-design.md`
(read it first; this plan argues from it).

## Global Constraints

- Plain TypeScript in `src/rom/`: no Theia, no VS Code imports. The browser may import it only because it touches no file.
- No em-dashes anywhere (commits, docs, comments); the content gate blocks them. No ROM-derived byte runs in tests or docs; synthetic fixtures only (`test/suite/support/l3Rom.ts`).
- No AI attribution in commits. One commit per task, on `feature/layer3-compositor-modes`; do not push, merge or touch `develop`.
- Before editing a symbol run GitNexus `impact` on it (`buildL3Verdict`, `layoutRefusal`, `readModeLayouts`, `screenResult`, `mapPlaneOrder`); run `detect_changes()` before each commit. Report HIGH or CRITICAL risk, do not ignore it.
- CGWSEL is $02: add the sub screen, no clip, no prevent (bank_00.asm:1285). Windows are not modeled.
- Color math is in 5-bit space: `v5 = c8 >> 3`, expand with `(v << 3) | (v >> 2)`, clamp per channel to 0..31. Add halves as `(a + b) >> 1`; subtract as `max(a - b, 0)`, halved `>> 1`.
- Half is skipped when the sub screen drew nothing and the fixed color is used. Cite `snes9x tileimpl.h:176-181` (`MATHS1_2::Calc`) and `bsnes sfc/ppu-fast/line.cpp:111` in a code comment and pin it with a unit test.
- Mode 0C (CGADSUB $70 with the standard layout) renders from the table like every other mode: the rule is to do what the ROM says. There is no capture task; the synthetic add-and-half tests are the check.
- CGADSUB table: bank_05.asm:495-499, stored at :548-549. BG3 (bit 2) is removed wherever CODE_009FB8 clears it (bank_00.asm:4170-4199; the only path that keeps it is the camera-locked byte $81-$BF off Castle 1 and Underground 1). Fixed color = `BackAreaColors[header byte1 >> 5]` (bank_00.asm:5623-5628), the same entry as the back color the view already carries (`model.backArea`).
- Layer 2 is interactive when `ModeLayout.vertical & 0x80` (bank_00.asm:11736-11738).
- Wire mapping: BG1 `l1`, BG2 `l2`, BG3 `l3`; main designation $212C and sub $212D bit 0 BG1, bit 1 BG2, bit 2 BG3, bit 4 OBJ (dropped until #564), bit 3 BG4 ignored.
- CGADSUB participation is keyed by layer in `ColorMath.ts` (one bit per layer in a `LAYER_BIT` map: l1 1, l2 2, l3 4, backdrop $20), so the sprite layer (#564, OBJ bit $10, palettes 4-7 only: snes9x gfx.cpp:819, bsnes ppu-fast/object.cpp:125) is a new input later, not a redesign. Do not build a sprite path now.
- Out of scope: #563 camera-locked layer 3, #571 vertical maps, #115 tide animation, #564 sprite toggle, #569. Mode 7 rooms stay refused with their reason.
- Every verdict or gate test needs a planted-defect test proving it can go red. CI has no ROM: corpus tests use `describe.skipIf(!hasRom(VANILLA))`, never a loop over a corpus listing.
- Gates before the last commit: `npm run lint`, `npm run format:check`, `npm run test:unit`, `npm run typecheck:theia`, then `yarn --cwd theia/extension build` before `yarn --cwd theia build:browser`.
- Stop and ask if the total passes about 1300 lines.

## Review Focus

1. A hacked or unreadable mode-table loader: layout falls back to the #561 order with `math: null`, pixels unchanged (Task 4 test).
2. A hack with a non-black back color on a standard map: backdrop plus layer 2 sums and clamps, no overflow wrap (Task 3 test).
3. Every layer toggled off, or lists naming only hidden layers: composite fully transparent, no throw, right buffer length (Task 3 test).
4. BG3 only on the sub screen with priority set or clear (modes 1E, 1F): sub list order follows the priority bit (Task 2 test).
5. A Mode 7 room (special setting nonzero): refused with its reason, old order, no math (Tasks 1 and 4 tests).
6. Layer 2 tooltip independent of whether layer 3 draws: Foreground on an interactive mode even when layer 3 is refused (Tasks 4, 6 and 7 tests).

---

### Task 1: Mode tables carry CGADSUB; refuse only special-setting modes

Estimate: about 25 impl + 55 tests = 80 lines.

**Files:**
- Modify: `src/rom/LevelScreenTables.ts` (interface, `CGADSUB_AT`, `readModeLayouts`, `layoutRefusal`)
- Modify: `test/suite/support/l3Rom.ts` (write the cgadsub table, `STANDARD.cgadsub`)
- Test: `test/suite/unit/LevelScreenTables.test.ts`

**Interfaces:**
- Produces: `ModeLayout { main; sub; cgadsub; special; vertical }` (all `number`); `readModeLayouts(rom)` unchanged signature; `layoutRefusal(l: ModeLayout): string | null` returns non-null only when `l.special !== 0`.

- [ ] **Step 1: Confirm what special means.** Read the bank_00.asm uses of `IRQNMICommand` ($0D9B) and say in the commit body what the nonzero values select. Word the refusal accordingly ("Layer 3 not drawn: Mode 7 level mode" if that is what it is; otherwise name what it is). The spec says to re-derive; do not copy the brief's claim.
- [ ] **Step 2: Write failing tests** in `LevelScreenTables.test.ts` (add `cgadsub` to every `ModeLayout` literal in that file first):

```ts
it('reads the CGADSUB operand of the load site', () => {
  const layouts = sweepLayouts().map((l, m) => ({ ...l, cgadsub: 0x20 + (m & 0x0f) }))
  const r = readModeLayouts(modeTablesRom(layouts))
  expect(r.ok && r.layouts.map(l => l.cgadsub)).toEqual(layouts.map(l => l.cgadsub))
})

it('refuses only a nonzero special setting: interactive and odd screens are drawn now', () => {
  expect(layoutRefusal({ ...STANDARD, special: 0xc0 })).toMatch(/Layer 3 not drawn/)
  expect(layoutRefusal({ ...STANDARD, vertical: 0x80 })).toBeNull()
  expect(layoutRefusal({ ...STANDARD, main: 0x17, sub: 0x00 })).toBeNull()
  expect(layoutRefusal(STANDARD)).toBeNull()
})
```
- [ ] **Step 3: Run** `npx vitest run test/suite/unit/LevelScreenTables.test.ts`. Expected: FAIL (no `cgadsub`).
- [ ] **Step 4: Implement.** In `LevelScreenTables.ts` add `cgadsub: number` to `ModeLayout`, `const CGADSUB_AT = 15` (the third `LDA.L`'s operand; pattern bytes 14..17), read it in `readModeLayouts` like `main` and `sub`, and replace `layoutRefusal`:

```ts
/** Why layer 3 is not drawn for this mode: only a special-level setting is refused (#562). */
export function layoutRefusal(l: ModeLayout): string | null {
  return l.special !== 0 ? 'Layer 3 not drawn: Mode 7 level mode' : null // wording per Step 1
}
```
Update the file's header comment (it no longer decides "standard"). In `l3Rom.ts` add `'cgadsub'` to the table-writing `for (const key of ...)` loop and set `STANDARD = { main: 0x15, sub: 0x02, cgadsub: 0x24, special: 0, vertical: 0 }`. Fix other compile errors (`npm run typecheck:theia`).
- [ ] **Step 5: Run** the file's tests. `MapScreenL3.test.ts` still fails where it asserts the old refusals; leave those for Task 4. Commit: `git commit -m "Mode tables carry CGADSUB; layer 3 refuses only special-setting modes (#562)"`.

### Task 2: `screenPlanes`, the per-screen plane lists

Estimate: about 50 impl + 120 tests = 170 lines.

**Files:**
- Create: `src/rom/model/ScreenPlanes.ts`
- Test: `test/suite/unit/ScreenPlanes.test.ts`

**Interfaces:**
- Consumes: `ppuDrawOrder(bg3Priority): readonly RenderPass[]` from `src/rom/model/RenderPass.ts`; `readModeLayouts` and `modeTablesRom` (Task 1).
- Produces: `type PlaneKey = 'l2Low' | 'l1Low' | 'l2High' | 'l1High' | 'l3Low' | 'l3High'`; `interface ScreenPlanes { main: PlaneKey[]; sub: PlaneKey[] }`; `screenPlanes(main: number, sub: number, bg3Priority: boolean): ScreenPlanes`; `FALLBACK_SCREENS: ScreenPlanes` (`main: ['l2Low','l1Low','l2High','l1High']`, `sub: []`, the pre-#561 order).

- [ ] **Step 1: Write the failing test.** The expected lists come from a hand-written literal copy of the mode 1 table (strings, not `ppuDrawOrder`), so the oracle is independent:

```ts
import { describe, it, expect } from 'vitest'
import { screenPlanes, FALLBACK_SCREENS, type ScreenPlanes } from '../../../src/rom/model/ScreenPlanes'
import { readModeLayouts } from '../../../src/rom/LevelScreenTables'
import { modeTablesRom } from '../support/l3Rom'

// docs/snes-superfamicom-selected.md:501-518, back to front, BG layers only.
const SET = ['l3Low', 'l2Low', 'l1Low', 'l2High', 'l1High', 'l3High']
const CLEAR = ['l3Low', 'l3High', 'l2Low', 'l1Low', 'l2High', 'l1High']
const BITS: Record<string, number> = { l1: 1, l2: 2, l3: 4 }
const on = (order: string[], mask: number) => order.filter(k => mask & BITS[k.slice(0, 2)]!)
const expected = (main: number, sub: number, pri: boolean) => ({ main: on(pri ? SET : CLEAR, main), sub: on(pri ? SET : CLEAR, sub) }) // prettier-ignore

/** 32 modes with distinct, deliberately odd designations (bits 3 and 4 set on some). */
const layouts = Array.from({ length: 32 }, (_, m) => ({
  main: (m * 5 + 1) & 0x1f, sub: (m * 11 + 3) & 0x1f, cgadsub: 0x24, special: 0, vertical: 0,
}))
/** The modes (and priority bits) a candidate gets wrong, read from synthetic tables. */
const wrong = (impl: typeof screenPlanes) => {
  const r = readModeLayouts(modeTablesRom(layouts))
  if (!r.ok) throw new Error(r.reason)
  return r.layouts.flatMap((l, m) => [true, false].filter(p => JSON.stringify(impl(l.main, l.sub, p)) !== JSON.stringify(expected(l.main, l.sub, p))).map(p => `${m}:${p}`)) // prettier-ignore
}

describe('screenPlanes: all 32 modes, both priority bits', () => {
  it('matches the hand table for every mode read from synthetic tables', () => {
    expect(wrong(screenPlanes)).toEqual([])
  })
  it('the #561 standard layout is the case main $15, sub $02', () => {
    expect(screenPlanes(0x15, 0x02, true)).toEqual<ScreenPlanes>({ main: ['l3Low', 'l1Low', 'l1High', 'l3High'], sub: ['l2Low', 'l2High'] }) // prettier-ignore
    expect(screenPlanes(0x15, 0x02, false)).toEqual<ScreenPlanes>({ main: ['l3Low', 'l3High', 'l1Low', 'l1High'], sub: ['l2Low', 'l2High'] }) // prettier-ignore
  })
  it('BG3 on the sub screen follows the priority bit (modes 1E, 1F style)', () => {
    expect(screenPlanes(0x01, 0x04, true).sub).toEqual(['l3Low', 'l3High'])
    expect(screenPlanes(0x02, 0x16, false).sub).toEqual(['l3Low', 'l3High', 'l2Low', 'l2High'])
  })
  it('fallback is the old BG1/BG2 order', () => {
    expect(FALLBACK_SCREENS).toEqual({ main: ['l2Low', 'l1Low', 'l2High', 'l1High'], sub: [] })
  })
})

describe('the per-mode oracle can fail (planted defects)', () => {
  it('catches BG3 high in the wrong slot, a sub list read from main, and BG4 not ignored', () => {
    const swapHigh: typeof screenPlanes = (m, s, p) => {
      const r = screenPlanes(m, s, p)
      return { ...r, main: r.main.map(k => (k === 'l3High' ? 'l3Low' : k)) as ScreenPlanes['main'] }
    }
    const subFromMain: typeof screenPlanes = (m, _s, p) => screenPlanes(m, m, p)
    const bg4Breaks: typeof screenPlanes = (m, s, p) => (m & 8 ? { main: [], sub: [] } : screenPlanes(m, s, p)) // a BG4 bit that changes the answer
    for (const bad of [swapHigh, subFromMain, bg4Breaks]) expect(wrong(bad).length).toBeGreaterThan(0)
  })
})
```
- [ ] **Step 2: Run** `npx vitest run test/suite/unit/ScreenPlanes.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `ScreenPlanes.ts`:**

```ts
/**
 * Which planes each SNES screen draws, and in what order (#562). The main ($212C)
 * and sub ($212D) designations pick the layers; `ppuDrawOrder` gives the BG mode 1
 * priority order once, and each screen is that table filtered to its own layers.
 * OBJ (bit 4) is dropped until the sprite toggle exists (#564); BG4 (bit 3) does
 * not exist in mode 1. Tables: SMWDisX bank_05.asm:480-504.
 */
import { ppuDrawOrder } from './RenderPass'

export type PlaneKey = 'l2Low' | 'l1Low' | 'l2High' | 'l1High' | 'l3Low' | 'l3High'
export interface ScreenPlanes { main: PlaneKey[]; sub: PlaneKey[] }

const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const

export const FALLBACK_SCREENS: ScreenPlanes = { main: ['l2Low', 'l1Low', 'l2High', 'l1High'], sub: [] }

export function screenPlanes(main: number, sub: number, bg3Priority: boolean): ScreenPlanes {
  const order = ppuDrawOrder(bg3Priority)
  const on = (mask: number) =>
    order.flatMap(p => (p.layer !== 'sprites' && mask & BIT[p.layer] ? [`${p.layer}${p.priority ? 'High' : 'Low'}` as PlaneKey] : [])) // prettier-ignore
  return { main: on(main), sub: on(sub) }
}
```
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `npm run format` and `npm run lint` on the new files.
- [ ] **Step 5: Commit** `git commit -m "Per-screen plane lists from the mode tables (#562)"`.

### Task 3: `composeScreen`, the color math stage

Estimate: about 100 impl + 220 tests = 320 lines.

**Files:**
- Create: `src/rom/model/ColorMath.ts`
- Test: `test/suite/unit/ColorMath.test.ts`

**Interfaces:**
- Consumes: `PlaneKey`, `ScreenPlanes` (Task 2).
- Produces:
  - `type Rgb = readonly [number, number, number]`
  - `interface ColorMathInput { cgadsub: number; fixed: Rgb }`
  - `interface ScreenInput { width: number; height: number; planes: Partial<Record<PlaneKey, Uint8ClampedArray | null>>; lists: ScreenPlanes; backdrop: Rgb; math: ColorMathInput | null }`
  - `composeScreen(i: ScreenInput): Uint8ClampedArray` (RGBA, `width * height * 4`)
  - `effectiveCgadsub(table: number, bg3Cleared: boolean): number`

Output rules: the main pixel is the topmost opaque plane of `lists.main` (a plane that is `null` or alpha 0 is skipped; the list is bottom to top), else the backdrop. Its CGADSUB bit is 1 (`l1`), 2 (`l2`), 4 (`l3`), or 0x20 (backdrop). If `math` is null or the bit is clear, a layer pixel's own RGB is output untouched (no quantizing) and a backdrop pixel is output transparent. Otherwise the sub pixel (topmost opaque of `lists.sub`, or none) is added or subtracted in 5-bit space (`cgadsub & 0x80` subtracts); the fixed color is used when no sub pixel exists; half (`cgadsub & 0x40`) applies only when a sub pixel exists; clamp to 31. A main-empty pixel whose result equals the backdrop is left transparent, so the view's back-area layer still shows.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect } from 'vitest'
import { composeScreen, effectiveCgadsub, type Rgb, type ScreenInput } from '../../../src/rom/model/ColorMath'
import { screenPlanes } from '../../../src/rom/model/ScreenPlanes'

const ex = (v: number) => (v << 3) | (v >> 2)
const c5 = (r: number, g: number, b: number): Rgb => [ex(r), ex(g), ex(b)]
const plane = (c: Rgb | null) => new Uint8ClampedArray(c ? [...c, 255] : [0, 0, 0, 0])
const BACK = c5(0, 0, 0)
const rgba = (c: Rgb) => [...c, 255]
/** One pixel: l1 on the main list, l2 on the sub list, unless a test says otherwise. */
function one(o: Partial<ScreenInput> & { l1?: Rgb | null; l2?: Rgb | null } = {}): number[] {
  const { l1 = c5(10, 10, 10), l2 = c5(4, 4, 4), ...rest } = o
  return [...composeScreen({
    width: 1, height: 1, backdrop: BACK, math: { cgadsub: 0x01, fixed: BACK },
    lists: { main: ['l1Low'], sub: ['l2Low'] },
    planes: { l1Low: plane(l1), l2Low: plane(l2) }, ...rest,
  })]
}

describe('composeScreen color math', () => {
  it('adds the sub pixel to a main layer that is in CGADSUB', () => {
    expect(one()).toEqual(rgba(c5(14, 14, 14)))
  })
  it('subtracts when bit 7 is set, clamping at 0', () => {
    expect(one({ l1: c5(10, 3, 10), math: { cgadsub: 0x81, fixed: BACK } })).toEqual(rgba(c5(6, 0, 6)))
  })
  it('halves when bit 6 is set and there is a sub pixel', () => {
    expect(one({ math: { cgadsub: 0x41, fixed: BACK } })).toEqual(rgba(c5(7, 7, 7)))
  })
  it('clamps an add at 31', () => {
    expect(one({ l1: c5(30, 31, 28), l2: c5(5, 5, 5) })).toEqual(rgba(c5(31, 31, 31)))
  })
  // snes9x tileimpl.h:176-181 (MATHS1_2::Calc) and bsnes sfc/ppu-fast/line.cpp:111:
  // against the fixed color the half is NOT applied.
  it('skips the half against the fixed color (no sub pixel)', () => {
    expect(one({ l2: null, math: { cgadsub: 0x41, fixed: c5(4, 4, 4) } })).toEqual(rgba(c5(14, 14, 14))) // 10 + 4, not (10 + 4) >> 1
  })
  it('mode 11: subtract and half against a black fixed color leaves layer 1 unchanged', () => {
    expect(one({ l2: null, math: { cgadsub: 0xfb, fixed: BACK } })).toEqual(rgba(c5(10, 10, 10)))
  })
  it('a layer not in CGADSUB is untouched, byte for byte, not re-quantized', () => {
    const raw: Rgb = [81, 3, 250]
    expect(one({ l1: raw, math: { cgadsub: 0x02, fixed: c5(31, 31, 31) } })).toEqual(rgba(raw))
  })
  it('null math is the main pixel as is', () => {
    expect(one({ math: null })).toEqual(rgba(c5(10, 10, 10)))
  })
  it('the 5-bit round trip holds for all 32 values', () => {
    for (let v = 0; v < 32; v++) expect(one({ l1: c5(v, v, v), l2: c5(0, 0, 0) })).toEqual(rgba(c5(v, v, v)))
  })
})

describe('the backdrop is a main-screen layer for CGADSUB (bit 5)', () => {
  const back = (l2: Rgb | null, backdrop: Rgb = BACK) => [...composeScreen({ width: 1, height: 1, backdrop, math: { cgadsub: 0x24, fixed: backdrop }, lists: { main: ['l1Low'], sub: ['l2Low'] }, planes: { l1Low: plane(null), l2Low: plane(l2) } })] // prettier-ignore
  it('black backdrop plus layer 2 is layer 2: the #561 picture', () => {
    expect(back(c5(7, 8, 9))).toEqual(rgba(c5(7, 8, 9)))
  })
  it('a non-black back color (a hack) sums with layer 2 and clamps', () => {
    expect(back(c5(30, 2, 2), c5(5, 5, 5))).toEqual(rgba(c5(31, 7, 7)))
  })
  it('an empty pixel whose result is the backdrop stays transparent', () => {
    expect(back(null)[3]).toBe(0)
  })
  it('mode 0C style (CGADSUB $70): layer 2 over a black backdrop shows halved', () => {
    const out = [...composeScreen({ width: 1, height: 1, backdrop: BACK, math: { cgadsub: 0x70, fixed: BACK }, lists: { main: ['l1Low'], sub: ['l2Low'] }, planes: { l1Low: plane(null), l2Low: plane(c5(20, 10, 6)) } })] // prettier-ignore
    expect(out).toEqual(rgba(c5(10, 5, 3)))
  })
})

describe('layer order and toggles', () => {
  const run = (planes: ScreenInput['planes']) => [...composeScreen({ width: 1, height: 1, backdrop: BACK, math: null, lists: { main: ['l3Low', 'l1Low'], sub: [] }, planes })] // prettier-ignore
  it('the topmost opaque plane of the main list wins; a null plane drops out', () => {
    expect(run({ l1Low: plane(c5(1, 1, 1)), l3Low: plane(c5(2, 2, 2)) })).toEqual(rgba(c5(1, 1, 1)))
    expect(run({ l1Low: null, l3Low: plane(c5(2, 2, 2)) })).toEqual(rgba(c5(2, 2, 2)))
  })
  it('every plane hidden: transparent, right length, no throw', () => {
    const out = composeScreen({ width: 3, height: 2, backdrop: BACK, math: { cgadsub: 0x24, fixed: BACK }, lists: screenPlanes(0x15, 0x02, true), planes: {} }) // prettier-ignore
    expect(out.length).toBe(24)
    expect([...out].every(v => v === 0)).toBe(true)
  })
  it('mode 0E ($018): layer 3 alone on main is added onto the sub screen, and off removes the add', () => {
    const lists = screenPlanes(0x04, 0x13, false)
    const at = (l3: Rgb | null) => [...composeScreen({ width: 1, height: 1, backdrop: BACK, math: { cgadsub: 0x20 /* $24 minus BG3 is not it: BG3 stays here */ | 0x04, fixed: BACK }, lists, planes: { l3Low: plane(l3), l1Low: plane(c5(10, 20, 30)) } })] // prettier-ignore
    expect(at(c5(12, 0, 5))).toEqual(rgba(c5(22, 20, 31)))
    expect(at(null)).toEqual(rgba(c5(10, 20, 30))) // backdrop plus sub, black backdrop
  })
  it('mode 02 ($009): layer 3 sits behind layer 1', () => {
    const lists = screenPlanes(0x17, 0x00, false)
    const out = composeScreen({ width: 1, height: 1, backdrop: BACK, math: { cgadsub: 0x20, fixed: BACK }, lists, planes: { l3Low: plane(c5(2, 2, 2)), l1Low: plane(c5(9, 9, 9)) } }) // prettier-ignore
    expect([...out]).toEqual(rgba(c5(9, 9, 9)))
  })
})

describe('effectiveCgadsub', () => {
  it('drops BG3 where CODE_009FB8 clears it, keeps it for the camera-locked byte', () => {
    expect(effectiveCgadsub(0x24, true)).toBe(0x20)
    expect(effectiveCgadsub(0x24, false)).toBe(0x24)
    expect(effectiveCgadsub(0xff, true)).toBe(0xfb)
  })
})
```
Note on the $018 test: it is synthetic (mode 0E tables, BG3 kept in CGADSUB). The real $018 has layer 3 settings byte $81 on tileset 13, which `l3LoadTimeY` returns null for: camera-locked, refused until #563 (probe, vanilla ROM, 2026-10-05). So no real map shows the $018 add in this PR; see the spec's contradictions.
- [ ] **Step 2: Run** `npx vitest run test/suite/unit/ColorMath.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `ColorMath.ts`:**

```ts
/**
 * ColorMath.ts: the SNES color math stage for one screen (#562). Pure; the
 * frontend reruns it on every layer toggle. CGWSEL is $02 (add the sub screen,
 * bank_00.asm:1285), so windows, clip and prevent are not modeled.
 *
 * Half against the fixed color: when the sub screen drew nothing the fixed color
 * is used and the half bit is ignored. snes9x tileimpl.h:176-181 (MATHS1_2::Calc:
 * halve only when `SD & 0x20`, else plain add with GFX.FixedColour) and bsnes
 * sfc/ppu-fast/line.cpp:111 (`below.source != Source::COL`). Both read from
 * GitHub master on 2026-10-05; not run against hardware.
 */
import type { PlaneKey, ScreenPlanes } from './ScreenPlanes'

export type Rgb = readonly [number, number, number]
export interface ColorMathInput { cgadsub: number; fixed: Rgb }
export interface ScreenInput {
  width: number
  height: number
  planes: Partial<Record<PlaneKey, Uint8ClampedArray | null>>
  lists: ScreenPlanes
  backdrop: Rgb
  math: ColorMathInput | null
}

const LAYER_BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
const BACKDROP_BIT = 0x20
const SUBTRACT = 0x80
const HALF = 0x40
const BG3 = 0x04

/** CGADSUB as the game leaves it: the table value minus BG3 where CODE_009FB8 clears it. */
export const effectiveCgadsub = (table: number, bg3Cleared: boolean): number =>
  bg3Cleared ? table & ~BG3 & 0xff : table

const to5 = (c: number) => c >> 3
const to8 = (v: number) => (v << 3) | (v >> 2)

/** The topmost opaque pixel of a list at byte offset `at`: its plane data and layer bit, or null. */
function top(i: ScreenInput, list: readonly PlaneKey[], at: number) {
  for (let k = list.length - 1; k >= 0; k--) {
    const data = i.planes[list[k]!]
    if (data && data[at + 3] !== 0) return { data, bit: LAYER_BIT[list[k]!.slice(0, 2) as keyof typeof LAYER_BIT] }
  }
  return null
}

export function composeScreen(i: ScreenInput): Uint8ClampedArray {
  const out = new Uint8ClampedArray(i.width * i.height * 4)
  for (let p = 0; p < i.width * i.height; p++) {
    const at = p * 4
    const main = top(i, i.lists.main, at)
    const rgb: Rgb = main ? [main.data[at]!, main.data[at + 1]!, main.data[at + 2]!] : i.backdrop
    const bit = main ? main.bit : BACKDROP_BIT
    let res = rgb
    if (i.math && i.math.cgadsub & bit) {
      const sub = top(i, i.lists.sub, at)
      const s: Rgb = sub ? [sub.data[at]!, sub.data[at + 1]!, sub.data[at + 2]!] : i.math.fixed
      const half = !!(i.math.cgadsub & HALF) && sub !== null // see the header: no half against the fixed color
      res = [0, 1, 2].map(k => {
        const m = to5(rgb[k]!)
        const v = to5(s[k]!)
        let r = i.math!.cgadsub & SUBTRACT ? Math.max(m - v, 0) : m + v
        if (half) r >>= 1
        return to8(Math.min(r, 31))
      }) as unknown as Rgb
    }
    if (!main && res[0] === i.backdrop[0] && res[1] === i.backdrop[1] && res[2] === i.backdrop[2]) continue
    out.set([res[0], res[1], res[2], 255], at)
  }
  return out
}
```
- [ ] **Step 4: Run** the test file. Expected: PASS. Then run three hand mutations and revert each: halve against the fixed color (the half-skip and mode 11 tests must go red), drop the `Math.min(r, 31)` clamp (the clamp test goes red), treat subtract as add (the subtract test goes red). Record the three red runs in the commit body. Run `npm run format` and `npm run lint`.
- [ ] **Step 5: Commit** `git commit -m "Color math stage: composeScreen over main and sub plane lists (#562)"`.

### Task 4: The layer 3 verdict uses the tables

Estimate: about 50 impl + 70 tests = 120 lines.

**Files:**
- Modify: `src/rom/model/L3Model.ts` (`L3Verdict`, `buildL3Verdict`, header comment)
- Test: `test/suite/unit/MapScreenL3.test.ts` (the `buildL3Verdict` tests; the corpus sweep)

**Interfaces:**
- Consumes: `screenPlanes`, `FALLBACK_SCREENS` (Task 2), `effectiveCgadsub` (Task 3), `ModeLayout` and `layoutRefusal` (Task 1), `l3LoadTimeY` (existing).
- Produces: `L3Verdict { screens: ScreenPlanes; cgadsub: number | null; layer2Interactive: boolean; priority: boolean; l3: L3Inputs | null; reason: string | null }`. `layout` is removed. `cgadsub` is null when the mode tables are unverified or the mode is refused (no math).

- [ ] **Step 1: Write failing tests** (edit the existing ones that use `layout`; the new ones, reusing the file's `withLayer3`, `modeTablesRom`, `sweepLayouts`, `l1Of`, `chars`, `BG_OK`, `GATE_OK`, `L3_WORD`):

```ts
describe('buildL3Verdict: screens, math and the layer 2 role', () => {
  const rom = (layout: Partial<ModeLayout>, mode = 5) => withLayer3(modeTablesRom(sweepLayouts().map((l, m) => (m === mode ? { ...l, ...layout } : l))), { level: 5, tileset: 0, setting: 2, settingsByte: 0x02, word: L3_WORD(false) }) // prettier-ignore
  const v = (r: RomFile, mode = 5, pri = false) => buildL3Verdict(r, 5, l1Of(mode, 0, pri), BG_OK, chars, GATE_OK)

  it('mode 0E style: BG3 alone on main, BG1 and BG2 on sub, CGADSUB minus BG3', () => {
    const r = v(rom({ main: 0x04, sub: 0x13, cgadsub: 0x24, vertical: 0 }))
    expect(r.screens).toEqual({ main: ['l3Low', 'l3High'], sub: ['l2Low', 'l1Low', 'l2High', 'l1High'] })
    expect(r.cgadsub).toBe(0x20)
    expect(r.l3).not.toBeNull()
  })
  it('an interactive mode draws layer 3 (the #561 refusal is gone) and reports layer 2 interactive', () => {
    const r = v(rom({ main: 0x17, sub: 0x00, vertical: 0x80 }))
    expect(r).toMatchObject({ reason: null, layer2Interactive: true })
    expect(r.screens.main).toEqual(['l3Low', 'l3High', 'l2Low', 'l1Low', 'l2High', 'l1High'])
  })
  it('mode 11 style: BG2 on main but not interactive, math kept minus BG3', () => {
    const r = v(rom({ main: 0x17, sub: 0x00, cgadsub: 0xff, vertical: 0 }))
    expect(r.layer2Interactive).toBe(false)
    expect(r.cgadsub).toBe(0xfb)
  })
  it('a special-setting (Mode 7) mode: refused, old order, no math', () => {
    const r = v(rom({ special: 0xc0 }))
    expect(r).toMatchObject({ l3: null, cgadsub: null, screens: FALLBACK_SCREENS })
    expect(r.reason).toMatch(/Layer 3 not drawn/)
  })
  it('unreadable mode tables (a hooked loader): fallback order, no math, no throw', () => {
    const r = buildL3Verdict(new RomFile('x.sfc', Buffer.alloc(0x80000)), 5, l1Of(0, 0, false), BG_OK, chars, GATE_OK)
    expect(r).toMatchObject({ cgadsub: null, screens: FALLBACK_SCREENS, layer2Interactive: false })
  })
  it('camera-locked layer 3 keeps BG3 in CGADSUB (not drawn; #563 inherits this)', () => {
    const locked = withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset: 0, setting: 2, settingsByte: 0x81, word: L3_WORD(false) }) // prettier-ignore
    const r = buildL3Verdict(locked, 5, l1Of(0, 0, false), BG_OK, chars, GATE_OK)
    expect(r.reason).toMatch(/camera-locked/)
    expect(r.cgadsub! & 0x04).toBe(0x04)
  })
  it('planted defect: tables read with main and sub swapped fail the mode 0E assertions', () => {
    const swapped = rom({ main: 0x13, sub: 0x04, cgadsub: 0x24, vertical: 0 })
    expect(v(swapped).screens).not.toEqual({ main: ['l3Low', 'l3High'], sub: ['l2Low', 'l1Low', 'l2High', 'l1High'] }) // prettier-ignore
  })
})
```
Update the corpus sweep (`describe.skipIf(!hasRom(VANILLA))`): for every vanilla id, compute expected `screens` from the straight table decode with an independent mask-to-keys loop, expect `v.screens` to equal it, and expect `v.l3 !== null` to equal `special === 0 && setting > 0 && !locked` (the existing decode, minus the old `standard` factor); count verdicts (`drawn`, `noLayer3`, `locked`, `special`), assert the counts sum to `checked` and `checked > 400`.
Corpus sweep also asserts, by id: $009, $0E7 and $1CE (settings byte $81 on tileset 3 or 1) draw layer 3, and $018 and the mode 11 levels do not ($018 camera-locked, $10E and $1BD no layer 3).
- [ ] **Step 2: Run** `npx vitest run test/suite/unit/MapScreenL3.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `L3Model.ts`. Replace `layout` with the three new fields. Keep the existing order of checks and reasons; the new shape:

```ts
const priority = l1.header.layer3Priority
const base = { priority, screens: FALLBACK_SCREENS, cgadsub: null, layer2Interactive: false }
const other = (reason: string): L3Verdict => ({ ...base, l3: null, reason })
if (!bg.ok) return other(`Layer 3 not drawn: ${bg.reason}`)
const layouts = readModeLayouts(rom)
if (!layouts.ok) {
  return other(readLayer3Setting(rom, index) === 0 ? 'This map has no layer 3' : `Layer 3 not drawn: ${layouts.reason}`)
}
const layout = layouts.layouts[l1.header.levelMode & 0x1f]!
const refusal = layoutRefusal(layout)
const known = refusal
  ? base
  : { priority, screens: screenPlanes(layout.main, layout.sub, priority), cgadsub: effectiveCgadsub(layout.cgadsub, true), layer2Interactive: (layout.vertical & 0x80) !== 0 } // prettier-ignore
const none = (reason: string, over: Partial<L3Verdict> = {}): L3Verdict => ({ ...known, l3: null, reason, ...over })
if (readLayer3Setting(rom, index) === 0) return none('This map has no layer 3')
if (refusal) return none(refusal)
if (l1.isVertical) return none('Layer 3 not drawn yet: vertical maps')
if (!gate.ok) return none(HOOKED_L3_CODE)
// ... loadL3Tilemap, l3LoadTimeY as before ...
// BG3 stays in CGADSUB on this path (bank_00.asm:4170-4199); #563 draws it.
if (yPx === null) return none('Layer 3 not drawn yet: camera-locked layer 3', { cgadsub: effectiveCgadsub(layout.cgadsub, false) }) // prettier-ignore
// ... sheets check as before, then:
return { ...known, reason: null, l3: { /* as before */ } }
```
Update the file's header comment (no longer "only the standard layout").
- [ ] **Step 4: Run** the file. Expected: PASS, except tests that still call `mapPlaneOrder`, which Task 5 deletes (do not skip them: leave them failing only until the Task 5 commit, or remove them here if the file will not compile).
- [ ] **Step 5: Commit** `git commit -m "Layer 3 verdict carries the screen lists and effective CGADSUB (#562)"`.

### Task 5: The payload

Estimate: about 50 impl + 60 tests = 110 lines.

**Files:**
- Modify: `theia/extension/src/common/project-protocol.ts` (delete `mapPlaneOrder`, change `MapLayer3Dto`, `MapScreenResult`)
- Modify: `theia/extension/src/node/map-screen.ts` (`screenResult`)
- Test: `test/suite/unit/MapScreenL3.test.ts`, `test/suite/unit/MapScreen.test.ts`

**Interfaces:**
- Consumes: `L3Verdict` (Task 4), `FALLBACK_SCREENS`, `ScreenPlanes` (Task 2).
- Produces, in `MapScreenResult` (`status: 'ok'`): `layer3: { priority: boolean; reason: string | null }` (`layout` removed); `screens: { main: MapPlaneKey[]; sub: MapPlaneKey[] }`; `math: { cgadsub: number; fixed: [number, number, number] } | null`; `layer2Interactive: boolean`. `planes`, `backdrop`, `note`, `layerNotes` unchanged. `mapPlaneOrder` no longer exists.

- [ ] **Step 1: Write failing tests.** In the wire tests of `MapScreenL3.test.ts` (use the existing `wireOf` and `verdict` helpers) replace the `mapPlaneOrder` tests:

```ts
it('the wire carries both plane lists, the math and the layer 2 role', () => {
  const l3 = { ...verdict(false, l3Of([word(8, 0, L3_WORD(true))])), screens: screenPlanes(0x04, 0x13, false), cgadsub: 0x20, layer2Interactive: true } // prettier-ignore
  const w = wireOf({ ...l1Of(0, 0, false), l3 })
  expect(w.screens).toEqual(screenPlanes(0x04, 0x13, false))
  expect(w.math).toEqual({ cgadsub: 0x20, fixed: [0, 0, 0] }) // fixed = the back area, the same BackAreaColors entry
  expect(w.layer2Interactive).toBe(true)
  expect('layout' in w.layer3).toBe(false)
})
it('no verdict: fallback lists and math null, the #561 stacking', () => {
  const w = wireOf({ ...l1Of(0, 0, false), l3: undefined })
  expect(w).toMatchObject({ screens: FALLBACK_SCREENS, math: null, layer2Interactive: false })
})
it('the standard layout keeps the #561 sub list for both priority bits', () => {
  for (const pri of [true, false]) expect(screenPlanes(0x15, 0x02, pri).sub).toEqual(['l2Low', 'l2High'])
})
```
Delete the three `mapPlaneOrder` tests (around `:157-162`) and rewrite the pixel helper near `:50-56` that calls `mapPlaneOrder` so it takes `screens.main` from `wireOf(...)` and walks it bottom to top, so the `drawL3Planes` pixel tests still work. Fix `MapScreen.test.ts` for the new required fields.
- [ ] **Step 2: Run** `npx vitest run test/suite/unit/MapScreenL3.test.ts test/suite/unit/MapScreen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `project-protocol.ts` remove `mapPlaneOrder` and the `ppuDrawOrder` import it needed; change `MapLayer3Dto` to `{ priority: boolean; reason: string | null }`, and add to the `ok` branch:

```ts
/** Bottom to top, per SNES screen (#562). Both lists name planes from `planes`. */
screens: { main: MapPlaneKey[]; sub: MapPlaneKey[] }
/** Color math between the screens; null when the mode tables could not be verified. */
math: { cgadsub: number; fixed: [number, number, number] } | null
/** Layer 2 is interactive on this level mode: the toolbar calls it Foreground. */
layer2Interactive: boolean
```
In `screenResult` (`map-screen.ts`):

```ts
const l3v = model.l3
const math = l3v?.cgadsub != null
  ? { cgadsub: l3v.cgadsub, fixed: [model.backArea[0], model.backArea[1], model.backArea[2]] as [number, number, number] }
  : null // the fixed color is BackAreaColors[header byte1 >> 5], the same entry as the back area (bank_00.asm:5623-5628)
return {
  /* existing fields */
  screens: l3v?.screens ?? FALLBACK_SCREENS,
  math,
  layer2Interactive: l3v?.layer2Interactive ?? false,
  layer3: { priority: l3v?.priority ?? model.header.layer3Priority, reason: l3v ? l3v.reason : 'Layer 3 not drawn yet' },
}
```
Update the header comments that mention `mapPlaneOrder`.
- [ ] **Step 4: Run** the two files and `npm run typecheck:theia` (errors confined to `map-view-widget.tsx` until Task 6). Expected: tests PASS.
- [ ] **Step 5: Commit** `git commit -m "Map screen payload: per-screen plane lists, color math inputs, layer 2 role (#562)"`.

### Task 6: The widget composites and labels

Estimate: about 110 impl + 40 tests = 150 lines.

**Files:**
- Create: `theia/extension/src/browser/map-layer-labels.ts`
- Modify: `theia/extension/src/browser/map-view-widget.tsx` (`ScreenImages`, `fetchScreen`, `sync`, `render`, Layer 2 label)
- Modify: `theia/extension/src/browser/style/index.css` (composite canvas)
- Test: `test/suite/unit/MapViewLabels.test.ts` (new; the pure label helper)

**Interfaces:**
- Consumes: `MapScreenResult` fields (Task 5), `composeScreen` (Task 3).
- Produces: `layer2Label(l: { layer2Interactive: boolean } | undefined): string`; a composite canvas per screen with `data-layer="screen"` and `data-screen=N`; plane canvases keep `data-plane` and `data-screen`.

Design: plane canvases stay (the specs read them and their `visibility`). A plane that is in neither `screens.main` nor `screens.sub`, or whose layer is toggled off, is `visibility: hidden`. Over them, one composite canvas per screen at `zIndex: 100`, opaque where a layer or the math drew and transparent elsewhere, so the back area still shows and hiding every layer shows it.

- [ ] **Step 1: Write the failing test** `MapViewLabels.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { layer2Label } from '../../../theia/extension/src/browser/map-layer-labels'

describe('layer 2 role tooltip', () => {
  it('Foreground only when layer 2 is interactive', () => {
    expect(layer2Label({ layer2Interactive: true })).toBe('Layer 2 · Foreground')
    expect(layer2Label({ layer2Interactive: false })).toBe('Layer 2 · Background')
  })
  it('Background while the map is still loading', () => {
    expect(layer2Label(undefined)).toBe('Layer 2 · Background')
  })
})
```
- [ ] **Step 2: Run** it. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  1. `map-layer-labels.ts`: `export const layer2Label = (l?: { layer2Interactive: boolean }): string => l?.layer2Interactive ? 'Layer 2 · Foreground' : 'Layer 2 · Background'`.
  2. Widget: extend `ScreenImages` with `screens: Layout['screens']; math: Layout['math']; backdrop: Layout['backdrop']`, set from the reply `r` in `fetchScreen`. Add `protected readonly composites = new Map<number, HTMLCanvasElement>()` and a `compositeRef(s)` built like `canvasRef`. Use `layer2Label(this.mapLayout)` as the Layer 2 toggle's `label`. Drop the `mapPlaneOrder` import.
  3. In `sync`, after the plane loop:

```ts
for (const [s, canvas] of this.composites) {
  const shot = this.screens.get(this.key(s))
  if (!shot) continue
  const want = `${this.generation}:${this.key(s)}:${+this.showL1}${+this.showL2}${+this.showL3}`
  if (canvas.dataset.drawn === want) continue
  canvas.width = shot.width
  canvas.height = shot.height
  const shown = (k: MapPlaneKey) => (k.startsWith('l2') ? this.showL2 : k.startsWith('l3') ? this.showL3 : this.showL1) // prettier-ignore
  const planes = Object.fromEntries(MAP_PLANE_KEYS.map(k => [k, shown(k) ? (shot.planes[k]?.data ?? null) : null]))
  const out = composeScreen({ width: shot.width, height: shot.height, planes, lists: shot.screens, backdrop: shot.backdrop, math: shot.math }) // prettier-ignore
  canvas.getContext('2d')?.putImageData(new ImageData(out, shot.width, shot.height), 0, 0)
  canvas.dataset.drawn = want
}
```
  4. In `render`, per screen: keep the six plane canvases (all `MAP_PLANE_KEYS`) with z index from the position in `[...l.screens.sub, ...l.screens.main]` (others 0), `visibility: hidden` when the plane is in neither list or its layer is toggled off. Append `<canvas className="hb-map-view-plane hb-map-view-composite" data-layer="screen" data-screen={s} style={{ zIndex: 100 }} ref={this.compositeRef(s)} />`. Each toggle handler already calls `this.update()`; also call `this.sync()` so the composite redraws.
  5. CSS: `.hb-map-view-composite { pointer-events: none }` (it shares `.hb-map-view-plane`'s sizing).
  6. The Layer 3 toggle's `pressed` and `disabled` stay driven by `layer3.reason`.
- [ ] **Step 4: Run** `npx vitest run test/suite/unit/MapViewLabels.test.ts`, `npm run typecheck:theia`, `npm run lint`, `npm run format:check`, `yarn --cwd theia/extension build`.
- [ ] **Step 5: Commit** `git commit -m "Map tab: composite canvas per screen, layer 2 role tooltip (#562)"`.

### Task 7: Playwright specs and docs

Estimate: about 40 docs and wiring + 150 spec = 190 lines (Playwright is written, not run).

**Files:**
- Modify: `theia/browser-app/test/map-view.spec.cjs` (new tests; fix the stacking assertions that read plane z-order)
- Modify: docs that say layer 3 is standard-layout only (`grep -rn "standard layout\|non-standard" docs theia --include=*.md --include=*.ts --include=*.tsx`; `docs/architecture/theia-shell.md` if it mentions the map layers)

**Interfaces:**
- Consumes: the composite canvas `canvas[data-layer="screen"][data-screen=N]` and plane canvases (Task 6); toolbar controls `[data-control="layer-l1"]`, `layer-l2`, `layer-l3` (existing; `l3Toggle` helper near `:702`).

- [ ] **Step 1: Write the new specs** next to the existing layer 3 tests, reusing `root(index)`, `l3Toggle` and the file's open-map helper. Helpers that read pixels in the page:

```js
/** First pixel of screen 0 where `want(a1, a2, a3)` (alphas of l1Low, l2Low, l3Low) holds, as [x, y], or null. */
const findPixel = (page, index, want) =>
  page.evaluate(({ root, want }) => {
    const get = p => document.querySelector(`${root} canvas[data-screen="0"][data-plane="${p}"]`)
    const cs = ['l1Low', 'l2Low', 'l3Low'].map(get)
    const [a1, a2, a3] = cs.map(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data)
    const test = new Function('a1', 'a2', 'a3', `return (${want})`)
    for (let i = 0; i < cs[0].width * cs[0].height; i++) if (test(a1[i * 4 + 3], a2[i * 4 + 3], a3[i * 4 + 3])) return [i % cs[0].width, Math.floor(i / cs[0].width)]
    return null
  }, { root: root(index), want })
const pixel = (page, index, sel, [x, y]) =>
  page.evaluate(({ root, sel, x, y }) => Array.from(document.querySelector(`${root} ${sel}`).getContext('2d').getImageData(x, y, 1, 1).data), { root: root(index), sel, x, y }) // prettier-ignore
const COMPOSITE = 'canvas[data-layer="screen"][data-screen="0"]'
const plane = p => `canvas[data-screen="0"][data-plane="${p}"]`
```
Tests (open each map the way neighboring tests do; each asserts values, never presence; each `expect(found).not.toBeNull()` first so a missing pixel fails loudly):
  - `$009: layer 3 draws behind layers 1 and 2, and its toggle is enabled`: the toggle is enabled and pressed; a pixel with `a3 && !a1 && !a2` has composite equal to the l3 plane pixel; a pixel with `a3 && a1` has composite equal to the l1 plane pixel (layer 3 behind); toggle layer 1 off and, at a pixel with `a3 && a1 && !a2`, the composite equals the l3 plane pixel.
  - No $018 Playwright test: its layer 3 is camera-locked (#563), so the toggle is disabled with the camera-locked reason. Assert exactly that on $018 (disabled, tooltip names camera-locked) so the gap is pinned. The add itself is covered by Task 3's synthetic mode 0E test.
  - `the layer 2 tooltip`: `$009` `[data-control="layer-l2"]` carries `Layer 2 · Foreground`; the standard map the file already opens (`0x105`) and `$10E` carry `Layer 2 · Background`.
  - `standard map: the composite equals the plane stack`: for map `0x105` sample 200 pixels and assert the composite equals the topmost visible plane pixel in the #561 order, so the composite changes nothing there.
  Fix existing tests that assert plane z-order or read `composeCanvases` stacking: they read the composite for pixel values and keep reading plane `visibility` for toggle checks.
- [ ] **Step 2: Do not run Playwright.** Run `node --check theia/browser-app/test/map-view.spec.cjs`, `npm run lint` and `npm run format:check`.
- [ ] **Step 3: Docs.** Update each file the grep finds so it says layer 3 is drawn on every non-Mode-7 level mode through per-screen lists and color math, and link the spec. Add one line to `docs/architecture/theia-shell.md` under the maps section. No em-dashes.
- [ ] **Step 4: Gates.** `npm run lint`, `npm run format:check`, `npm run test:unit` (record passed and skipped, with and without the corpus: run once with `HACKBENCH_ROMS` pointing at an empty directory), `npm run typecheck:theia`, `yarn --cwd theia/extension build`, `yarn --cwd theia build:browser`.
- [ ] **Step 5: Commit** `git commit -m "Map view specs for layer 3 on every mode; docs (#562)"`. Then `npm run gitnexus`. Push nothing. Report branch, head SHA, exact test counts, files changed and risks.

## Totals

| Task | What | Lines |
| --- | --- | --- |
| 1 | CGADSUB in the mode tables; refuse only special | 80 |
| 2 | `screenPlanes` per-screen lists | 170 |
| 3 | `composeScreen` color math | 320 |
| 4 | Verdict uses the tables | 120 |
| 5 | Payload and protocol | 110 |
| 6 | Widget composite and tooltip | 150 |
| 7 | Playwright specs and docs | 190 |
| | Total | about 1140 (spec estimate 1050) |

## Self-review against the spec

- Settled design 1 (per-screen lists, `mapPlaneOrder` replaced): Tasks 2, 4, 5. 2 (generic stage, CGADSUB, fixed color, clamp, toggles rerun): Tasks 3, 4, 5, 6. 3 (layer 2 role): Tasks 1, 4, 5, 6, 7. 4 (scope, Mode 7 refusal): Tasks 1, 4.
- The half rule and its citations: Global Constraints, Task 3 comment and tests (half-skip and mode 11 cases). Mode 0C: Task 3 `mode 0C style` test, derived from the table, no capture.
- Acceptance 1 (32 modes, planted defects): Task 2. 2 (math cases): Task 3. 3 ($009 behind layers 1 and 2): Task 3 unit, Task 7 Playwright. 4 ($018 add): Task 3 synthetic only, see the contradiction. 5 (corpus sweep with counts): Task 4. 6 (standard unchanged): Task 5 list test, Task 7 sample, Task 3 black-backdrop test. 7 and 8 (Playwright, tooltip): Tasks 6 and 7.
- Contradiction found while planning: the real $018 is camera-locked (byte $81, tileset 13), so layer 3 is refused there and its add cannot show before #563. The $018 acceptance items become synthetic only (Task 3) plus a Playwright check that the toggle is disabled with that reason (Task 7).
- No placeholders except Task 1 Step 1 (the special-setting wording, derived from the ROM) and Task 7's in-page pixel scan (which pixel is found at run time).
- Names checked across tasks: `ScreenPlanes`, `PlaneKey`, `screenPlanes`, `FALLBACK_SCREENS`, `composeScreen`, `effectiveCgadsub`, `layer2Interactive`, `screens`, `math`, `layer2Label`.
- Changes from the spec: the effective CGADSUB always clears BG3 except on the camera-locked path (the verdict sets it kept there), instead of a separate `bg3InCgadsub` call; plane canvases are kept, hidden by list and toggle, so the existing visibility specs hold; the mode 0C capture was dropped on the owner's instruction.
