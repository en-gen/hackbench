# Palette Explorer and Per-Group Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-sidebar Palettes widget with a left activity-bar tree whose items open ordinary, dockable main-area tabs, and show detected palette animation with editable frame colors.

**Architecture:** A `TreeWidget` explorer (same shape as the Graphics explorer) emits open events; a contribution routes them through `PreviewTabs` to one `PaletteGroupViewWidget` class keyed by group and optional variant. The view composes three shared React components (`PaletteSwatchRow`, `PaletteFrameStrip`, `PaletteInspector`). The backend adds one `animation` field to `RomPalettesDto`, built by a theia-free module from the existing detector.

**Tech Stack:** TypeScript, Eclipse Theia 1.75 (`TreeWidget`, `ReactWidget`, `AbstractViewContribution`, `WidgetFactory`), React (via `@theia/core/shared/react`), Vitest (node env), Playwright (`_electron`-free browser-app specs in `theia/browser-app/test/`).

**Spec:** `docs/superpowers/specs/2026-09-22-palette-explorer-tabs-design.md`

## Global Constraints

- Worktree: `C:/Projects/.worktrees/hackbench/palette-explorer`, branch `feature/palette-explorer-tabs`. PRs target `develop`.
- No em-dashes in any added line (pre-commit `check-staged-content.sh` blocks them). US spelling: "color", never "colour", in new text.
- No AI attribution in commits or PR bodies.
- `npm run lint` is `--max-warnings 0`; `npm run format:check` must pass. Run both before every commit.
- Never fall back to a vanilla value. An unreadable animation handler reports unavailable with the detector's reason.
- Every ROM claim in a comment cites `SMWDisX file:line`.
- Toggle command id stays `hackbench.palettes.focus`.
- Swatch and hatch styling carries over unchanged from `style/palette.css`.
- Size budget ~900-1,100 changed lines including tests. Stop and ask past 1,300.
- Unit tests run without a ROM (CI has none). Corpus tests use `describe.skipIf`, never a loop over a file listing.
- Sub-agents write Playwright specs; the orchestrator runs them.

## Review Focus

1. A project switch while a palette tab is open: the tab must close, never keep showing the previous ROM's colors or accept an edit against it. Pinned in Task 6's Playwright test "switching projects closes palette tabs".
2. An edit whose `oldHex` no longer matches (another tab edited the same word first): the inspector shows the stale refusal inline and the grid stays. Pinned in Task 6 "a stale refusal in one tab leaves its grid visible".
3. A repeated frame word (non-contiguous mask): editing frame N must visibly change every frame cell sharing its address. Pinned in Task 3's unit test `linkedIndices` and Task 6 "editing a frame persists an op file and updates every linked frame".
4. The explorer restored from a saved layout before contributions start: rows must still open tabs. Pinned in Task 5 by wiring existing widgets in `onStart`, and in Task 6 "a reloaded window's explorer still opens tabs".
5. A tab docked narrow: the inspector must wrap below the grid rather than clip. Pinned in Task 6 "a narrow tab wraps the inspector below the grid".

---

## File Structure

| File | Responsibility |
|---|---|
| `src/rom/PaletteAnimationDetect.ts` (modify) | `FlashKernel.maskAddr`; each target gains `frameAddrs` and `timing` |
| `src/rom/PaletteAnimationView.ts` (create) | Theia-free: level detection to a view model with per-frame addresses |
| `theia/extension/src/common/palette-protocol.ts` (modify) | `PaletteAnimationDto` on `RomPalettesDto` |
| `theia/extension/src/node/palette-server.ts` (modify) | Fills `animation` |
| `theia/extension/src/browser/palette-view-model.ts` (create) | Pure helpers: chunking, linked frames, markers, titles, frame phase |
| `theia/extension/src/browser/palette-swatch-row.tsx` (create) | Shared row of N swatches |
| `theia/extension/src/browser/palette-frame-strip.tsx` (create) | Frames in rows of 8 |
| `theia/extension/src/browser/palette-inspector.tsx` (create) | Preview, frames, details, edit, notes |
| `theia/extension/src/browser/palette-group-view-widget.tsx` (create) | Main-area tab for a group or one variant |
| `theia/extension/src/browser/palette-explorer-widget.tsx` (create) | Left tree |
| `theia/extension/src/browser/palette-explorer-contribution.ts` (create) | View registration and open routing |
| `theia/extension/src/browser/palette-frontend-module.ts` (modify) | Bindings |
| `theia/extension/src/browser/palette-view-widget.tsx`, `palette-view-contribution.ts` (delete) | Replaced |
| `theia/extension/src/browser/style/palette.css` (modify) | Drop nav/layout rules, add view/inspector/frames rules |
| `test/suite/unit/PaletteAnimationDetect.synthetic.test.ts` (modify) | `maskAddr`, `frameAddrs`, `timing` |
| `test/suite/unit/PaletteAnimationView.test.ts` (create) | View model incl. fail-closed |
| `test/suite/unit/paletteViewModel.test.ts` (create) | Pure helpers |
| `theia/browser-app/test/palette-view.spec.cjs` (rewrite) | End to end |

---

### Task 1: Detector records mask address, frame addresses and timing

**Files:**
- Modify: `src/rom/PaletteAnimationDetect.ts` (`FlashKernel` ~line 106, `PaletteAnimTarget` ~line 132, `decodeKernel` ~line 272, `toTarget` ~line 778)
- Test: `test/suite/unit/PaletteAnimationDetect.synthetic.test.ts`

**Interfaces:**
- Produces: `FlashKernel.maskAddr: number` (SNES address of the `AND #imm` opcode); `PaletteAnimTarget.frameAddrs: number[]` (one SNES address per entry of `colors`, same order); `PaletteAnimTarget.timing: { maskAddr: number; mask: number; shift: number; counterDp: number }`.

- [ ] **Step 1: Write the failing tests.** Append to the synthetic test file (it already defines `buildRom`, `KERNEL`, `TABLE`):

```ts
describe('targets carry their own frame addresses and timing', () => {
  it('maskAddr is the AND #imm after STA $2121 and LDA dp', () => {
    // STA abs (3 bytes) + LDA dp (2 bytes) precede the AND in the stock shape.
    expect(decodeFlashKernel(buildRom(), KERNEL)!.maskAddr).toBe(KERNEL + 5)
  })

  it('frameAddrs are the table plus each phase offset, in counter order', () => {
    const t = detectPaletteAnimation(buildRom()).level.targets[0]!
    const k = decodeFlashKernel(buildRom(), KERNEL)!
    expect(t.frameAddrs).toEqual(k.phaseOffsets.map(o => t.tableAddr + o))
    expect(t.frameAddrs.length).toBe(t.colors.length)
  })

  it('timing reports the mask and shift the kernel actually holds', () => {
    const t = detectPaletteAnimation(buildRom({ mask: 0x0c })).level.targets[0]!
    expect(t.timing).toEqual({ maskAddr: KERNEL + 5, mask: 0x0c, shift: 1, counterDp: 0x14 })
  })
})
```

- [ ] **Step 2: Run to confirm red.** `npx vitest run test/suite/unit/PaletteAnimationDetect.synthetic.test.ts` - expect failures on `maskAddr`/`frameAddrs`/`timing` being undefined.

- [ ] **Step 3: Implement.** In `FlashKernel` add:

```ts
  /** SNES address of the kernel's `AND #imm`, the byte that sets phase count and speed. */
  maskAddr: number
```

In `PaletteAnimTarget` add:

```ts
  /** SNES address of each entry of `colors`, same order: table plus phase offset. */
  frameAddrs: number[]
  /** The kernel operands that set count and speed (bank_00.asm:4667-4670). Read-only facts. */
  timing: { maskAddr: number; mask: number; shift: number; counterDp: number }
```

In `decodeKernel`'s `yes({...})` add `maskAddr,`. In `toTarget` build the addresses alongside `colors`:

```ts
  const colors: number[] = []
  const frameAddrs: number[] = []
  for (const offset of kernel.phaseOffsets) {
    const addr = kernel.tableAddr + baseOffset + offset
    const word = rom.readWord(addr)
    if (word === null) return null
    colors.push(word)
    frameAddrs.push(addr)
  }
  return {
    cgramIdx: site.cgramIdx,
    cgramIdxAddr: site.cgramIdxAddr,
    tableAddr: kernel.tableAddr + baseOffset,
    phaseCount: kernel.phaseOffsets.length,
    frameStride: kernel.frameStride,
    colors,
    frameAddrs,
    timing: {
      maskAddr: kernel.maskAddr,
      mask: kernel.phaseMask,
      shift: kernel.shift,
      counterDp: kernel.counterDp,
    },
    kernelAddr: kernel.addr,
  }
```

- [ ] **Step 4: Run green.** Same command; also `npx vitest run test/suite/unit/PaletteAnimation` (all palette animation tests) and `npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit.**

```bash
git add src/rom/PaletteAnimationDetect.ts test/suite/unit/PaletteAnimationDetect.synthetic.test.ts
git commit -m "feat(rom): palette animation targets carry frame addresses and timing"
```

---

### Task 2: Animation on the wire

**Files:**
- Create: `src/rom/PaletteAnimationView.ts`
- Modify: `theia/extension/src/common/palette-protocol.ts`, `theia/extension/src/node/palette-server.ts`
- Test: `test/suite/unit/PaletteAnimationView.test.ts`

**Interfaces:**
- Consumes: `PaletteAnimDetection`, `PaletteAnimTarget.frameAddrs/timing` (Task 1).
- Produces:

```ts
// src/rom/PaletteAnimationView.ts
export interface AnimFrameView { color: RgbaColor; romAddr: number }
export interface AnimTargetView {
  cgramIdx: number
  frameStride: number
  intervalMs: number
  sharedWithOtherTargets: boolean
  timing: { maskAddr: number; mask: number; shift: number; counterDp: number }
  frames: AnimFrameView[]
}
export interface LevelAnimationView { available: boolean; notes: string[]; targets: AnimTargetView[] }
export function buildLevelAnimation(detection: PaletteAnimDetection): LevelAnimationView

// palette-protocol.ts
export interface PaletteAnimFrameDto { color: PaletteColorDto; romAddr: number }
export interface PaletteAnimTargetDto {
  cgramIdx: number
  frameStride: number
  intervalMs: number
  sharedWithOtherTargets: boolean
  timing: { maskAddr: number; mask: number; shift: number; counterDp: number }
  frames: PaletteAnimFrameDto[]
}
export interface PaletteAnimationDto { available: boolean; notes: string[]; targets: PaletteAnimTargetDto[] }
// RomPalettesDto gains: animation: PaletteAnimationDto
```

- [ ] **Step 1: Write the failing test** `test/suite/unit/PaletteAnimationView.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildLevelAnimation } from '../../../src/rom/PaletteAnimationView'
import type {
  PaletteAnimContext,
  PaletteAnimDetection,
  PaletteAnimTarget,
} from '../../../src/rom/PaletteAnimationDetect'

const timing = { maskAddr: 0x00a423, mask: 0x1c, shift: 1, counterDp: 0x14 }

function target(over: Partial<PaletteAnimTarget> = {}): PaletteAnimTarget {
  return {
    cgramIdx: 0x64,
    cgramIdxAddr: 0x00a41a,
    tableAddr: 0x00b60c,
    phaseCount: 4,
    frameStride: 4,
    colors: [0x001f, 0x03e0, 0x7c00, 0x001f],
    frameAddrs: [0x00b60c, 0x00b60e, 0x00b610, 0x00b60c],
    timing,
    kernelAddr: 0x00a41e,
    ...over,
  }
}

const ctx = (c: Partial<PaletteAnimContext>): PaletteAnimContext => ({
  context: 'level',
  available: true,
  targets: [],
  notes: [],
  ...c,
})

const detection = (level: PaletteAnimContext, overworld = ctx({ context: 'overworld' })): PaletteAnimDetection => ({
  level,
  overworld,
})

describe('buildLevelAnimation', () => {
  it('gives every frame its own color and ROM address, in counter order', () => {
    const v = buildLevelAnimation(detection(ctx({ targets: [target()] })))
    expect(v.available).toBe(true)
    expect(v.targets[0]!.frames.map(f => f.romAddr)).toEqual([0x00b60c, 0x00b60e, 0x00b610, 0x00b60c])
    expect(v.targets[0]!.frames[0]!.color).toEqual([255, 0, 0, 255])
    expect(v.targets[0]!.timing).toEqual(timing)
    expect(v.targets[0]!.intervalMs).toBe(67)
  })

  it('reports unavailable with the detector notes and no targets when the level context is blind', () => {
    const v = buildLevelAnimation(
      detection(ctx({ available: false, notes: ['$00A418 holds 0x60, wanted SEP #$20'] })),
    )
    expect(v).toEqual({ available: false, notes: ['$00A418 holds 0x60, wanted SEP #$20'], targets: [] })
  })

  it('never emits targets for an unavailable context even if the detector left some behind', () => {
    const v = buildLevelAnimation(detection(ctx({ available: false, targets: [target()] })))
    expect(v.targets).toEqual([])
  })

  it('flags a target whose frame words another target also reads', () => {
    const ow = ctx({ context: 'overworld', targets: [target({ cgramIdx: 0x6d, frameAddrs: [0x00b610] })] })
    const v = buildLevelAnimation(detection(ctx({ targets: [target()] }), ow))
    expect(v.targets[0]!.sharedWithOtherTargets).toBe(true)
  })

  it('does not flag a target whose words no other target reads', () => {
    const ow = ctx({ context: 'overworld', targets: [target({ cgramIdx: 0x6d, frameAddrs: [0x00b700] })] })
    const v = buildLevelAnimation(detection(ctx({ targets: [target()] }), ow))
    expect(v.targets[0]!.sharedWithOtherTargets).toBe(false)
  })
})
```

- [ ] **Step 2: Run red.** `npx vitest run test/suite/unit/PaletteAnimationView.test.ts` - module not found.

- [ ] **Step 3: Implement** `src/rom/PaletteAnimationView.ts`:

```ts
/**
 * The level palette animation as the palette view shows it: one entry per
 * animated CGRAM index, each frame with the ROM word it came from so an edit
 * can target it. Built only from what PaletteAnimationDetect read off the
 * cart; an unavailable context yields no targets, never stock's (CLAUDE.md,
 * "Never fall back to the vanilla value"). Timing is reported, not editable:
 * it lives in the kernel's AND mask and LSR count (bank_00.asm:4667-4670).
 */
import { bgr555ToRgba, RgbaColor } from './GraphicsDecoder'
import { framesToMs } from './timing'
import type { PaletteAnimDetection, PaletteAnimTarget } from './PaletteAnimationDetect'

export interface AnimFrameView {
  color: RgbaColor
  romAddr: number
}

export interface AnimTargetView {
  cgramIdx: number
  frameStride: number
  intervalMs: number
  /** Another target, in either context, reads one of these frame words. */
  sharedWithOtherTargets: boolean
  timing: PaletteAnimTarget['timing']
  frames: AnimFrameView[]
}

export interface LevelAnimationView {
  available: boolean
  notes: string[]
  targets: AnimTargetView[]
}

export function buildLevelAnimation(detection: PaletteAnimDetection): LevelAnimationView {
  const { level, overworld } = detection
  if (!level.available) return { available: false, notes: [...level.notes], targets: [] }

  const everyTarget = [...level.targets, ...(overworld.available ? overworld.targets : [])]
  const targets = level.targets.map(
    (t): AnimTargetView => ({
      cgramIdx: t.cgramIdx,
      frameStride: t.frameStride,
      intervalMs: Math.round(framesToMs(t.frameStride)),
      sharedWithOtherTargets: everyTarget.some(
        o => o !== t && o.frameAddrs.some(a => t.frameAddrs.includes(a)),
      ),
      timing: t.timing,
      frames: t.colors.map((word, i) => ({ color: bgr555ToRgba(word), romAddr: t.frameAddrs[i]! })),
    }),
  )
  return { available: true, notes: [...level.notes], targets }
}
```

- [ ] **Step 4: Protocol.** In `palette-protocol.ts`, add the three DTO interfaces from **Interfaces** above (after `PaletteGroupDto`) and to `RomPalettesDto`:

```ts
  /**
   * Level palette animation, read from the NMI handler
   * (src/rom/PaletteAnimationDetect.ts). `available: false` means the
   * handler did not decode or is not reached; `targets` is then empty.
   */
  animation: PaletteAnimationDto
```

- [ ] **Step 5: Server.** In `palette-server.ts`:

```ts
import { detectPaletteAnimation } from '../../../../src/rom/PaletteAnimationDetect'
import { buildLevelAnimation, LevelAnimationView } from '../../../../src/rom/PaletteAnimationView'
```

In `currentPalettes`, change the `palettes:` line to:

```ts
      palettes: toDto(
        buildStockTables(rom.rom),
        countCustomPaletteLevels(rom.rom),
        buildLevelAnimation(detectPaletteAnimation(rom.rom)),
      ),
```

and extend `toDto`:

```ts
function toDto(
  groups: AttributedGroup[],
  customPaletteLevelCount: number,
  animation: LevelAnimationView,
): RomPalettesDto {
  return {
    customPaletteLevelCount,
    animation: {
      available: animation.available,
      notes: animation.notes,
      targets: animation.targets.map(t => ({
        ...t,
        frames: t.frames.map(f => ({ color: toColorDto(f.color), romAddr: f.romAddr })),
      })),
    },
    groups: /* unchanged */ groups.map(...),
  }
}
```

(keep the existing `groups.map(...)` body verbatim).

- [ ] **Step 6: Green.** `npx vitest run test/suite/unit/PaletteAnimationView.test.ts`, `npx tsc --noEmit -p .`, `npm run lint`, `npm run format:check`.

- [ ] **Step 7: Commit.**

```bash
git add src/rom/PaletteAnimationView.ts test/suite/unit/PaletteAnimationView.test.ts theia/extension/src/common/palette-protocol.ts theia/extension/src/node/palette-server.ts
git commit -m "feat(palette): serve level palette animation with per-frame ROM addresses"
```

---

### Task 3: Pure view-model helpers

**Files:**
- Create: `theia/extension/src/browser/palette-view-model.ts`
- Test: `test/suite/unit/paletteViewModel.test.ts`

**Interfaces:**
- Consumes: `PaletteAnimTargetDto`, `PaletteGroupDto` (Task 2).
- Produces:

```ts
export const FRAMES_PER_ROW = 8
export function chunk<T>(items: T[], size: number): T[][]
export function linkedIndices(frames: { romAddr: number }[], selected: number): Set<number>
export function animatedColumns(targets: PaletteAnimTargetDto[], cgramRow: number | null): Set<number>
export function targetFor(targets: PaletteAnimTargetDto[], cgramRow: number | null, col: number): PaletteAnimTargetDto | undefined
export function framePhase(gameFrame: number, frameStride: number, frameCount: number): number
export function tabTitle(group: PaletteGroupDto, variant: number | undefined): string
export function cellTitle(group: PaletteGroupDto, cgramRow: number | null, index: number): string
export function viewWidgetId(groupId: string, variant: number | undefined): string
export const PALETTE_GROUP_VIEW_ID = 'hackbench.palette-group-view'
```

- [ ] **Step 1: Failing test** `test/suite/unit/paletteViewModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  chunk,
  linkedIndices,
  animatedColumns,
  targetFor,
  framePhase,
  tabTitle,
  cellTitle,
  viewWidgetId,
} from '../../../theia/extension/src/browser/palette-view-model'
import type {
  PaletteAnimTargetDto,
  PaletteGroupDto,
} from '../../../theia/extension/src/common/palette-protocol'

const target = (cgramIdx: number): PaletteAnimTargetDto => ({
  cgramIdx,
  frameStride: 4,
  intervalMs: 67,
  sharedWithOtherTargets: false,
  timing: { maskAddr: 0x00a423, mask: 0x1c, shift: 1, counterDp: 0x14 },
  frames: [],
})

const group = (over: Partial<PaletteGroupDto> = {}): PaletteGroupDto => ({
  id: 'sprite_sets',
  label: 'Shared Sprite Colors',
  description: '',
  cgRamRow: 4,
  variants: [{ label: 'Shared', romAddr: 0x00b250, rows: [] }],
  ...over,
})

describe('chunk', () => {
  it('wraps 9 frames into 8 + 1 and 17 into 8 + 8 + 1', () => {
    expect(chunk([...Array(9).keys()], 8).map(r => r.length)).toEqual([8, 1])
    expect(chunk([...Array(17).keys()], 8).map(r => r.length)).toEqual([8, 8, 1])
    expect(chunk([], 8)).toEqual([])
  })
})

describe('linkedIndices', () => {
  it('returns every frame sharing the selected frame word', () => {
    const frames = [0xb60c, 0xb60e, 0xb60c, 0xb610].map(romAddr => ({ romAddr }))
    expect([...linkedIndices(frames, 0)]).toEqual([0, 2])
    expect([...linkedIndices(frames, 3)]).toEqual([3])
  })
})

describe('animatedColumns / targetFor', () => {
  it('maps a CGRAM index to its row and column', () => {
    expect([...animatedColumns([target(0x64)], 6)]).toEqual([4])
    expect(animatedColumns([target(0x64)], 5).size).toBe(0)
    expect(targetFor([target(0x64)], 6, 4)?.cgramIdx).toBe(0x64)
    expect(targetFor([target(0x64)], 6, 5)).toBeUndefined()
  })

  it('has no markers for a row with no CGRAM row (Back Area Colors)', () => {
    expect(animatedColumns([target(0x00)], null).size).toBe(0)
    expect(targetFor([target(0x00)], null, 0)).toBeUndefined()
  })
})

describe('framePhase', () => {
  it('advances one frame per stride of game frames and wraps', () => {
    expect([0, 3, 4, 7, 8, 31, 32].map(f => framePhase(f, 4, 8))).toEqual([0, 0, 1, 1, 2, 7, 0])
  })
})

describe('titles and ids', () => {
  it('names a group tab, a variant tab and a cell', () => {
    const g = group({ id: 'bg', label: 'Layer 2 Background', variants: [0, 1, 2, 3].map(i => ({ label: `Variant ${i}`, romAddr: null, rows: [] })) })
    expect(tabTitle(g, undefined)).toBe('Layer 2 Background')
    expect(tabTitle(g, 3)).toBe('Layer 2 Background \u00b7 Variant 3')
    expect(cellTitle(g, 1, 4)).toBe('CGRAM $14 \u00b7 Layer 2 Background')
    expect(cellTitle(group({ label: 'Back Area Colors', cgRamRow: null }), null, 3)).toBe('Back Area Colors \u00b7 3')
    expect(viewWidgetId('bg', undefined)).toBe('hackbench.palette-group-view:bg')
    expect(viewWidgetId('bg', 3)).toBe('hackbench.palette-group-view:bg:3')
  })
})
```

- [ ] **Step 2: Run red.** `npx vitest run test/suite/unit/paletteViewModel.test.ts`.

- [ ] **Step 3: Implement** `palette-view-model.ts`:

```ts
/**
 * Pure helpers for the palette explorer and tabs. No Theia or React import,
 * so they are testable from Vitest's node environment like palette-color-format.
 */
import type { PaletteAnimTargetDto, PaletteGroupDto } from '../common/palette-protocol'

export const PALETTE_GROUP_VIEW_ID = 'hackbench.palette-group-view'
export const FRAMES_PER_ROW = 8

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** A non-contiguous phase mask repeats table entries; editing one word edits them all. */
export function linkedIndices(frames: { romAddr: number }[], selected: number): Set<number> {
  const addr = frames[selected]?.romAddr
  const out = new Set<number>()
  frames.forEach((f, i) => {
    if (f.romAddr === addr) out.add(i)
  })
  return out
}

export function animatedColumns(targets: PaletteAnimTargetDto[], cgramRow: number | null): Set<number> {
  const out = new Set<number>()
  if (cgramRow === null) return out
  for (const t of targets) if (t.cgramIdx >> 4 === cgramRow) out.add(t.cgramIdx & 15)
  return out
}

export function targetFor(
  targets: PaletteAnimTargetDto[],
  cgramRow: number | null,
  col: number,
): PaletteAnimTargetDto | undefined {
  if (cgramRow === null) return undefined
  return targets.find(t => t.cgramIdx === cgramRow * 16 + col)
}

/** Phase-locked to the game counter, as the kernel derives it from EffFrame (bank_00.asm:4668-4670). */
export function framePhase(gameFrame: number, frameStride: number, frameCount: number): number {
  return Math.floor(gameFrame / frameStride) % frameCount
}

export function tabTitle(group: PaletteGroupDto, variant: number | undefined): string {
  if (variant === undefined) return group.label
  return `${group.label} \u00b7 ${group.variants[variant]?.label ?? `Variant ${variant}`}`
}

export function cellTitle(group: PaletteGroupDto, cgramRow: number | null, index: number): string {
  if (cgramRow === null) return `${group.label} \u00b7 ${index}`
  const idx = (cgramRow * 16 + index).toString(16).toUpperCase().padStart(2, '0')
  return `CGRAM $${idx} \u00b7 ${group.label}`
}

export function viewWidgetId(groupId: string, variant: number | undefined): string {
  return variant === undefined
    ? `${PALETTE_GROUP_VIEW_ID}:${groupId}`
    : `${PALETTE_GROUP_VIEW_ID}:${groupId}:${variant}`
}
```

- [ ] **Step 4: Green**, lint, format.

- [ ] **Step 5: Commit** `feat(palette): pure view-model helpers for the explorer and tabs`.

---

### Task 4: Shared components and the group view widget

**Files:**
- Create: `palette-swatch-row.tsx`, `palette-frame-strip.tsx`, `palette-inspector.tsx`, `palette-group-view-widget.tsx` (all in `theia/extension/src/browser/`)
- Modify: `theia/extension/src/browser/style/palette.css`

Component rendering is verified by Task 6's Playwright specs; the logic they depend on is unit-tested in Task 3.

**Interfaces:**
- Consumes: Task 3 helpers; `palette-color-format` (`cssColor`, `formatBgr555`, `formatRomAddr`, `bgr555HexToCssHex`, `cssHexToBgr555`, `normalizeBgr555Hex`); `frameClock` from `../../../../src/webview/shared/frameClock`.
- Produces:

```ts
// palette-swatch-row.tsx
export interface PaletteSwatchRowProps {
  cells: PaletteCellDto[]
  gutter?: string
  selectedIndex?: number
  highlighted?: Set<number>
  marker?: Set<number>
  previewOverride?: { index: number; cssColor: string }
  label?: (index: number) => string | undefined
  onSelect?: (index: number) => void
}
export function PaletteSwatchRow(props: PaletteSwatchRowProps): React.ReactElement

// palette-frame-strip.tsx
export interface PaletteFrameStripProps {
  frames: PaletteAnimFrameDto[]
  playingIndex: number | undefined
  selectedIndex: number | undefined
  onSelect: (index: number) => void
}
export function PaletteFrameStrip(props: PaletteFrameStripProps): React.ReactElement

// palette-inspector.tsx
export interface EditableWord { color: PaletteColorDto; table: string; romAddr: number }
export interface PaletteInspectorProps {
  title: string
  word: EditableWord | undefined
  wordLabel?: string
  animation?: PaletteAnimTargetDto
  selectedFrame: number | undefined
  onSelectFrame: (index: number | undefined) => void
  error: string | undefined
  onCommit: (romAddr: number, oldHex: string, newHex: string) => void
  onDismissError: () => void
}
export class PaletteInspector extends React.Component<PaletteInspectorProps, InspectorState>

// palette-group-view-widget.tsx
export interface PaletteGroupViewOptions { manifestPath: string; groupId: string; variant?: number }
export class PaletteGroupViewWidget extends ReactWidget {
  result: LoadPaletteResult | undefined   // exposed for tests
  async open(options: PaletteGroupViewOptions): Promise<void>
  shows(options: PaletteGroupViewOptions): boolean
}
```

- [ ] **Step 1: `palette-swatch-row.tsx`.** Moves `renderRow`/`renderCell` out of the old widget; draws `cells.length` swatches.

```tsx
/**
 * One row of palette swatches, any length: a CGRAM row is 16, Back Area
 * Colors is 8. Indices are positions in this row, not CGRAM indices; the
 * caller supplies the gutter text. Unwritten cells are hatched and carry
 * no color and no BGR555, so nothing fabricated is ever shown.
 */
import * as React from '@theia/core/shared/react'
import { PaletteCellDto } from '../common/palette-protocol'
import { cssColor, formatBgr555 } from './palette-color-format'

export interface PaletteSwatchRowProps {
  cells: PaletteCellDto[]
  gutter?: string
  selectedIndex?: number
  /** Cells tied to the selection (frames sharing one ROM word). */
  highlighted?: Set<number>
  /** Cells the level animation overwrites every frame. */
  marker?: Set<number>
  /** A picked but uncommitted color, shown only on its own swatch. */
  previewOverride?: { index: number; cssColor: string }
  /** Caption under a swatch, e.g. a frame number. */
  label?: (index: number) => string | undefined
  onSelect?: (index: number) => void
}

export function PaletteSwatchRow(props: PaletteSwatchRowProps): React.ReactElement {
  return (
    <div className="hb-palette-row">
      {props.gutter !== undefined && <span className="hb-palette-row-gutter">{props.gutter}</span>}
      <div className="hb-palette-swatches">{props.cells.map((c, i) => swatch(props, c, i))}</div>
    </div>
  )
}

function swatch(props: PaletteSwatchRowProps, cell: PaletteCellDto, i: number): React.ReactNode {
  const caption = props.label?.(i)
  if (!cell.written) {
    return (
      <span key={i} className="hb-palette-swatch-cell">
        <span
          className="hb-palette-swatch hb-palette-swatch-unwritten"
          title={`Index ${i}: not written by any table this view reads`}
        />
        {caption !== undefined && <span className="hb-palette-swatch-caption">{caption}</span>}
      </span>
    )
  }
  const classes = ['hb-palette-swatch']
  if (props.selectedIndex === i) classes.push('hb-palette-swatch-selected')
  if (props.highlighted?.has(i)) classes.push('hb-palette-swatch-linked')
  if (props.marker?.has(i)) classes.push('hb-palette-swatch-animated')
  const bg = props.previewOverride?.index === i ? props.previewOverride.cssColor : cssColor(cell.color)
  const c = cell.color
  return (
    <span key={i} className="hb-palette-swatch-cell">
      <span
        className={classes.join(' ')}
        style={{ background: bg }}
        title={`Index ${i} \u00b7 ${cell.table} \u00b7 ${formatBgr555(c)} \u00b7 RGB ${c.r}, ${c.g}, ${c.b}`}
        onClick={() => props.onSelect?.(i)}
      />
      {caption !== undefined && <span className="hb-palette-swatch-caption">{caption}</span>}
    </span>
  )
}
```

- [ ] **Step 2: `palette-frame-strip.tsx`.**

```tsx
/**
 * Animation frames under the inspector preview, 8 per row so the strip is
 * never wider than the preview column. The playing frame is highlighted;
 * a selected frame also highlights every frame reading the same ROM word.
 */
import * as React from '@theia/core/shared/react'
import { PaletteAnimFrameDto, PaletteCellDto } from '../common/palette-protocol'
import { PaletteSwatchRow } from './palette-swatch-row'
import { chunk, FRAMES_PER_ROW, linkedIndices } from './palette-view-model'

export interface PaletteFrameStripProps {
  frames: PaletteAnimFrameDto[]
  playingIndex: number | undefined
  selectedIndex: number | undefined
  onSelect: (index: number) => void
}

export function PaletteFrameStrip(props: PaletteFrameStripProps): React.ReactElement {
  const linked =
    props.selectedIndex === undefined ? new Set<number>() : linkedIndices(props.frames, props.selectedIndex)
  const rows = chunk(
    props.frames.map((f, i) => ({ f, i })),
    FRAMES_PER_ROW,
  )
  return (
    <div className="hb-palette-frames">
      {rows.map((row, r) => {
        const base = r * FRAMES_PER_ROW
        const cells: PaletteCellDto[] = row.map(({ f }) => ({
          written: true,
          color: f.color,
          table: 'Animation frame',
          romAddr: f.romAddr,
        }))
        const local = (s: Set<number>) =>
          new Set([...s].filter(i => i >= base && i < base + row.length).map(i => i - base))
        const selected = props.selectedIndex ?? props.playingIndex
        return (
          <PaletteSwatchRow
            key={r}
            cells={cells}
            selectedIndex={selected !== undefined && selected >= base ? selected - base : undefined}
            highlighted={local(linked)}
            label={i => String(base + i)}
            onSelect={i => props.onSelect(base + i)}
          />
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: `palette-inspector.tsx`.** Ports the old widget's pick logic (`onColorPick`, `onHexFieldChange`, `onOkClick`, `cancelPick`, Escape on document, the quantize note) into component state; the parent remounts it with `key={word?.romAddr}` so a new word always starts with no pick.

```tsx
/**
 * Details and editing for one BGR555 word, plus, for an animated CGRAM
 * index, a playing preview with its frames directly beneath.
 *
 * Nothing is written until OK (or Enter): an earlier live-preview layer
 * left `old` unable to match the committed bytes by the time OK ran, so
 * every commit refused. The parent owns the service call; this component
 * owns only the pick.
 */
import * as React from '@theia/core/shared/react'
import { PaletteAnimTargetDto, PaletteColorDto } from '../common/palette-protocol'
import {
  bgr555HexToCssHex,
  cssColor,
  cssHexToBgr555,
  formatBgr555,
  formatRomAddr,
  normalizeBgr555Hex,
} from './palette-color-format'
import { PaletteFrameStrip } from './palette-frame-strip'
import { framePhase } from './palette-view-model'
import { frameClock, FrameSubscription } from '../../../../src/webview/shared/frameClock'

export interface EditableWord {
  color: PaletteColorDto
  table: string
  romAddr: number
}

export interface PaletteInspectorProps {
  title: string
  word: EditableWord | undefined
  /** Shown above the details, e.g. "Stock value, overwritten every frame". */
  wordLabel?: string
  animation?: PaletteAnimTargetDto
  selectedFrame: number | undefined
  onSelectFrame: (index: number | undefined) => void
  error: string | undefined
  onCommit: (romAddr: number, oldHex: string, newHex: string) => void
  onDismissError: () => void
}

interface InspectorState {
  pickedHex?: string
  pickedCssHex?: string
  hexDraft?: string
  playing: number
}

export class PaletteInspector extends React.Component<PaletteInspectorProps, InspectorState> {
  override state: InspectorState = { playing: 0 }
  protected clock: FrameSubscription | undefined

  protected readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && (this.state.pickedHex !== undefined || this.state.hexDraft !== undefined)) {
      this.cancel()
    }
  }

  override componentDidMount(): void {
    document.addEventListener('keydown', this.onKeyDown)
    this.syncClock()
  }

  override componentDidUpdate(): void {
    this.syncClock()
  }

  override componentWillUnmount(): void {
    document.removeEventListener('keydown', this.onKeyDown)
    this.clock?.stop()
  }

  /** Plays only while animated and no frame is pinned; stops with the tab via rAF. */
  protected syncClock(): void {
    const a = this.props.animation
    const shouldRun = !!a && a.frames.length > 0 && this.props.selectedFrame === undefined
    if (shouldRun && !this.clock) {
      this.clock = frameClock.every(
        () => a!.frameStride,
        () => {
          const anim = this.props.animation
          if (!anim) return
          this.setState({ playing: framePhase(frameClock.frame, anim.frameStride, anim.frames.length) })
        },
      )
      this.clock.start()
    } else if (!shouldRun && this.clock) {
      this.clock.stop()
      this.clock = undefined
    }
  }

  protected cancel(): void {
    this.setState({ pickedHex: undefined, pickedCssHex: undefined, hexDraft: undefined })
    this.props.onDismissError()
  }

  protected commit(): void {
    const w = this.props.word
    const newHex = this.state.pickedHex
    if (!w || !newHex) return
    const committed = formatBgr555(w.color)
    if (newHex === committed) return
    this.setState({ pickedHex: undefined, pickedCssHex: undefined, hexDraft: undefined })
    this.props.onCommit(w.romAddr, committed, newHex)
  }

  override render(): React.ReactNode {
    const { word, animation } = this.props
    const committed = word ? formatBgr555(word.color) : '$----'
    const shown = this.state.pickedHex ?? committed
    const hasPick = !!word && this.state.pickedHex !== undefined && this.state.pickedHex !== committed
    const quantized =
      !!word && this.state.pickedCssHex !== undefined && this.state.pickedHex === committed
    const previewColor =
      animation && animation.frames.length > 0 && this.props.selectedFrame === undefined
        ? cssColor(animation.frames[this.state.playing % animation.frames.length]!.color)
        : word
          ? bgr555HexToCssHex(shown)
          : undefined

    return (
      <aside className={'hb-palette-inspector' + (word ? '' : ' hb-palette-inspector-empty')}>
        <div className="hb-palette-inspector-title">{this.props.title}</div>
        <div className="hb-palette-preview" style={previewColor ? { background: previewColor } : undefined} />
        {animation && (
          <PaletteFrameStrip
            frames={animation.frames}
            playingIndex={this.props.selectedFrame === undefined ? this.state.playing : undefined}
            selectedIndex={this.props.selectedFrame}
            onSelect={i => this.props.onSelectFrame(this.props.selectedFrame === i ? undefined : i)}
          />
        )}
        {this.props.wordLabel && <div className="hb-palette-inspector-wordlabel">{this.props.wordLabel}</div>}
        <dl className="hb-palette-inspector-readout">
          <dt>Table</dt>
          <dd>{word ? `${word.table} ${formatRomAddr(word.romAddr)}` : '-'}</dd>
          <dt>Value</dt>
          <dd>{committed}</dd>
          <dt>RGB</dt>
          <dd>{word ? `${word.color.r}, ${word.color.g}, ${word.color.b}` : '-, -, -'}</dd>
        </dl>
        <div className="hb-palette-inspector-edit">
          <input
            type="color"
            className="hb-palette-inspector-color"
            disabled={!word}
            value={word ? bgr555HexToCssHex(shown) : '#000000'}
            onChange={e => {
              const v = e.currentTarget.value
              let hex: string | undefined
              try {
                hex = cssHexToBgr555(v)
              } catch {
                return
              }
              this.setState({ pickedCssHex: v, pickedHex: hex, hexDraft: undefined })
            }}
          />
          <input
            type="text"
            className="hb-palette-inspector-hex"
            disabled={!word}
            placeholder="$----"
            value={this.state.hexDraft ?? (word ? shown.slice(1) : '')}
            onChange={e => {
              const v = e.currentTarget.value
              let hex: string | undefined
              try {
                hex = normalizeBgr555Hex(v)
              } catch {
                hex = undefined
              }
              this.setState({ hexDraft: v, pickedCssHex: undefined, pickedHex: hex })
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') this.commit()
              else if (e.key === 'Escape') this.cancel()
            }}
            // No onBlur: clearing the draft on blur ate the typed value before OK's click read it.
          />
          <button type="button" className="hb-palette-inspector-ok" disabled={!hasPick} onClick={() => this.commit()}>
            OK
          </button>
          <button type="button" className="hb-palette-inspector-cancel" disabled={!hasPick} onClick={() => this.cancel()}>
            Cancel
          </button>
        </div>
        <div className={'hb-palette-inspector-from' + (this.props.error ? ' hb-palette-inspector-from-error' : '')}>
          {this.props.error ??
            (quantized
              ? 'That color rounds to the same BGR555 word already here - nothing to apply. Try the hex field for an exact value.'
              : word
                ? ''
                : 'Click a swatch to inspect and edit it')}
        </div>
        {animation && <AnimationNotes animation={animation} />}
      </aside>
    )
  }
}

function AnimationNotes({ animation }: { animation: PaletteAnimTargetDto }): React.ReactElement {
  const t = animation.timing
  const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')
  return (
    <div className="hb-palette-inspector-notes">
      <div>
        {`${animation.frames.length} frames, every ${animation.frameStride} frames (~${animation.intervalMs} ms): ` +
          `AND #$${hex2(t.mask)} + ${t.shift} LSR at ${formatRomAddr(t.maskAddr)}. Timing is code, not data, and is not editable here.`}
      </div>
      {animation.sharedWithOtherTargets && (
        <div>Another animated color reads some of these frame words; editing one changes it there too.</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: `palette-group-view-widget.tsx`.**

```tsx
/**
 * One palette group, or one variant of it, as an ordinary main-area tab.
 * Opened from the Palettes explorer through PreviewTabs, so it docks,
 * splits and pins like any other editor tab.
 *
 * One class for both kinds: a variant tab is a group tab filtered to one
 * variant. Every tab re-fetches when the working copy changes, so an edit
 * in one shows in every other tab holding the same word, with no
 * tab-to-tab messages. A project switch closes the tab: it belongs to a
 * ROM that is no longer open.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ReactWidget } from '@theia/core/lib/browser'
import {
  LoadPaletteResult,
  PaletteGroupDto,
  PaletteService,
  SetColorResult,
} from '../common/palette-protocol'
import { ProjectContext } from './project-context'
import { PaletteFrontendClient } from './palette-push-client'
import { PaletteSwatchRow } from './palette-swatch-row'
import { EditableWord, PaletteInspector } from './palette-inspector'
import { animatedColumns, cellTitle, tabTitle, targetFor, viewWidgetId } from './palette-view-model'

export interface PaletteGroupViewOptions {
  manifestPath: string
  groupId: string
  variant?: number
}

interface CellSelection {
  variantIdx: number
  rowIdx: number
  colIdx: number
}

@injectable()
export class PaletteGroupViewWidget extends ReactWidget {
  @inject(PaletteService) protected readonly palettes!: PaletteService
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(PaletteFrontendClient) protected readonly pushClient!: PaletteFrontendClient

  /** Exposed for tests: the service's last answer. */
  result: LoadPaletteResult | undefined
  protected options: PaletteGroupViewOptions | undefined
  protected error: string | undefined
  protected editError: string | undefined
  protected selection: CellSelection | undefined
  protected selectedFrame: number | undefined
  /** Discards a response superseded by a later request. */
  protected requestToken = 0

  @postConstruct()
  protected init(): void {
    this.addClass('hb-palette-group-view')
    this.title.closable = true
    this.title.iconClass = 'codicon codicon-symbol-color'
    this.node.tabIndex = 0
    this.toDispose.push(
      this.pushClient.onChanged(mp => {
        if (mp === this.options?.manifestPath) void this.fetch()
      }),
    )
    this.toDispose.push(
      this.context.onChanged(p => {
        if (this.options && p?.manifestPath !== this.options.manifestPath) this.close()
      }),
    )
  }

  shows(o: PaletteGroupViewOptions): boolean {
    return (
      !!this.options &&
      this.options.manifestPath === o.manifestPath &&
      this.options.groupId === o.groupId &&
      this.options.variant === o.variant
    )
  }

  async open(options: PaletteGroupViewOptions): Promise<void> {
    const same = this.options && this.shows(options)
    this.options = options
    this.id = viewWidgetId(options.groupId, options.variant)
    if (!same) {
      this.selection = undefined
      this.selectedFrame = undefined
      this.editError = undefined
    }
    await this.fetch()
  }

  protected async fetch(): Promise<void> {
    const o = this.options
    if (!o) return
    const token = ++this.requestToken
    try {
      const result = await this.palettes.loadPalettes(o.manifestPath)
      if (token !== this.requestToken) return
      this.result = result
      this.error = undefined
    } catch (err) {
      if (token !== this.requestToken) return
      this.error = (err as Error).message
    }
    const g = this.group()
    this.title.label = g ? tabTitle(g, o.variant) : o.groupId
    this.title.caption = this.title.label
    this.update()
  }

  protected group(): PaletteGroupDto | undefined {
    return this.result?.status === 'ok'
      ? this.result.palettes.groups.find(g => g.id === this.options?.groupId)
      : undefined
  }

  protected async commit(romAddr: number, oldHex: string, newHex: string): Promise<void> {
    const mp = this.options?.manifestPath
    if (!mp) return
    let r: SetColorResult
    try {
      r = await this.palettes.setColor(mp, romAddr, oldHex, newHex)
    } catch (err) {
      this.editError = (err as Error).message
      this.update()
      return
    }
    if (this.options?.manifestPath !== mp) return
    if (r.status === 'stale' || r.status === 'io-error') {
      this.editError = r.reason
    } else {
      this.result = r
      this.editError = undefined
    }
    this.update()
  }

  protected render(): React.ReactNode {
    if (this.error) return <div className="hb-palette-error">{this.error}</div>
    const r = this.result
    if (!r) return <div className="hb-palette-empty">Reading the ROM...</div>
    if (r.status === 'rom-not-located')
      return <div className="hb-palette-empty">{`Locate ${r.baseRom.title || 'the base ROM'} to view its palettes`}</div>
    if (r.status === 'unreadable') return <div className="hb-palette-error">{r.reason}</div>
    const g = this.group()
    if (!g) return <div className="hb-palette-error">{`No palette group "${this.options?.groupId}"`}</div>

    const variants = g.variants
      .map((v, vi) => ({ v, vi }))
      .filter(({ vi }) => this.options?.variant === undefined || vi === this.options.variant)
    const targets = r.palettes.animation.targets

    return (
      <div className="hb-palette-view-layout">
        <div className="hb-palette-main">
          <header className="hb-palette-header">
            <h2 className="hb-palette-title">{this.title.label}</h2>
            <div className="hb-palette-selection-note">{g.description}</div>
          </header>
          {variants.map(({ v, vi }) => (
            <section key={vi} className="hb-palette-variant">
              {this.options?.variant === undefined && <div className="hb-palette-variant-label">{v.label}</div>}
              {v.rows.map((row, ri) => {
                const cgramRow = g.cgRamRow !== null ? g.cgRamRow + ri : null
                const sel = this.selection
                return (
                  <PaletteSwatchRow
                    key={ri}
                    cells={row}
                    gutter={cgramRow !== null ? `CGRAM ${cgramRow}` : undefined}
                    marker={animatedColumns(targets, cgramRow)}
                    selectedIndex={sel && sel.variantIdx === vi && sel.rowIdx === ri ? sel.colIdx : undefined}
                    onSelect={ci => {
                      this.selection = { variantIdx: vi, rowIdx: ri, colIdx: ci }
                      this.selectedFrame = undefined
                      this.editError = undefined
                      this.update()
                    }}
                  />
                )
              })}
            </section>
          ))}
        </div>
        {this.renderInspector(g)}
      </div>
    )
  }

  protected renderInspector(g: PaletteGroupDto): React.ReactNode {
    const sel = this.selection
    const targets = this.result?.status === 'ok' ? this.result.palettes.animation.targets : []
    const cell = sel ? g.variants[sel.variantIdx]?.rows[sel.rowIdx]?.[sel.colIdx] : undefined
    const cgramRow = sel && g.cgRamRow !== null ? g.cgRamRow + sel.rowIdx : null
    const animation = sel ? targetFor(targets, cgramRow, sel.colIdx) : undefined
    const frame = animation && this.selectedFrame !== undefined ? animation.frames[this.selectedFrame] : undefined

    let word: EditableWord | undefined
    let wordLabel: string | undefined
    if (frame) {
      word = { color: frame.color, table: 'Animation frame', romAddr: frame.romAddr }
      wordLabel = `Frame ${this.selectedFrame}`
    } else if (cell?.written && cell.romAddr !== null) {
      word = { color: cell.color, table: cell.table, romAddr: cell.romAddr }
      wordLabel = animation ? 'Stock value, overwritten every frame by the animation' : undefined
    }

    return (
      <PaletteInspector
        key={word?.romAddr ?? 'none'}
        title={sel ? cellTitle(g, cgramRow, sel.colIdx) : g.label}
        word={word}
        wordLabel={wordLabel}
        animation={animation}
        selectedFrame={this.selectedFrame}
        onSelectFrame={i => {
          this.selectedFrame = i
          this.editError = undefined
          this.update()
        }}
        error={this.editError}
        onCommit={(a, o, n) => void this.commit(a, o, n)}
        onDismissError={() => {
          this.editError = undefined
          this.update()
        }}
      />
    )
  }
}
```

- [ ] **Step 5: CSS.** In `style/palette.css`: delete the rule blocks `.hb-palette-layout`, `.hb-palette-nav`, `.hb-palette-nav-*`, `.hb-palette-warning` (moved to the explorer as tree rows) and the `grid-row`/`grid-column` lines in `.hb-palette-main`. Keep every `.hb-palette-swatch*`, `.hb-palette-row*`, `.hb-palette-inspector*` rule unchanged. Append:

```css
/* A group tab: grid and inspector side by side, inspector below when narrow. */
.hb-palette-view-layout {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 1em;
  padding: 0.8em 1em;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}

.hb-palette-view-layout > .hb-palette-main {
  flex: 1 1 auto;
  min-width: 0;
}

.hb-palette-view-layout > .hb-palette-inspector {
  flex: 0 0 18em;
}

.hb-palette-inspector-title {
  font-weight: 600;
  margin-bottom: 0.5em;
}

/* The preview and the frames beneath it read as one unit. */
.hb-palette-preview {
  width: 4.5em;
  height: 4.5em;
  border: 1px solid var(--theia-editorWidget-border);
  background-image: repeating-linear-gradient(
    45deg,
    var(--theia-descriptionForeground) 0,
    var(--theia-descriptionForeground) 1px,
    var(--theia-editor-background) 2px,
    var(--theia-editor-background) 5px
  );
}

.hb-palette-frames {
  margin: 0.4em 0 0.6em;
}

.hb-palette-swatch-cell {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}

.hb-palette-swatch-caption {
  font-size: var(--theia-ui-font-size0);
  color: var(--theia-descriptionForeground);
}

.hb-palette-swatch-linked {
  outline: 1px dashed var(--theia-focusBorder);
  outline-offset: 1px;
}

/* Corner marker: this color is overwritten every frame by the animation. */
.hb-palette-swatch-animated {
  position: relative;
}

.hb-palette-swatch-animated::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  border-style: solid;
  border-width: 0 0.45em 0.45em 0;
  border-color: transparent var(--theia-focusBorder) transparent transparent;
}

.hb-palette-inspector-wordlabel,
.hb-palette-inspector-notes {
  font-size: var(--theia-ui-font-size0);
  color: var(--theia-descriptionForeground);
  margin-top: 0.4em;
}
```

Use the existing hatch gradient values verbatim for `.hb-palette-preview` if they differ from the above (copy from the current `.hb-palette-swatch-unwritten` rule).

- [ ] **Step 6: Verify.** `npx tsc --noEmit -p .`, `npm run lint`, `npm run format:check`, and in `theia/`: `yarn --cwd extension build` (or the `prepare` script) must compile.

- [ ] **Step 7: Commit** `feat(palette): shared swatch row, frame strip and inspector; group view widget`.

---

### Task 5: Explorer, contribution, module wiring; delete the old view

**Files:**
- Create: `palette-explorer-widget.tsx`, `palette-explorer-contribution.ts`
- Modify: `palette-frontend-module.ts`
- Delete: `palette-view-widget.tsx`, `palette-view-contribution.ts`

**Interfaces:**
- Consumes: `PaletteGroupViewWidget`, `PALETTE_GROUP_VIEW_ID`, `PreviewTabs`.
- Produces:

```ts
export const PALETTE_EXPLORER_ID = 'hackbench.palette-explorer'
export interface PaletteOpenRequest { manifestPath: string; groupId: string; variant?: number; pinned: boolean }
export class PaletteExplorerWidget extends TreeWidget {
  result: LoadPaletteResult | undefined   // exposed for tests
  readonly onOpen: Event<PaletteOpenRequest>
  async load(manifestPath: string | undefined): Promise<void>
}
export class PaletteExplorerContribution extends AbstractViewContribution<PaletteExplorerWidget> {
  async openGroup(req: PaletteOpenRequest): Promise<PaletteGroupViewWidget>   // public for tests
}
```

- [ ] **Step 1: `palette-explorer-widget.tsx`.** Model it on `gfx-explorer-widget.tsx` (same `storeState`/`restoreState` override, same `onSelectionChanged` preview + `handleDblClickEvent` pin, same `createTreeContainer` factory, `globalSelection: true`). Differences:

```tsx
export const PALETTE_EXPLORER_ID = 'hackbench.palette-explorer'

export interface PaletteOpenRequest {
  manifestPath: string
  groupId: string
  variant?: number
  pinned: boolean
}

export interface PaletteTreeNode extends CompositeTreeNode, SelectableTreeNode, ExpandableTreeNode {
  kind: 'group' | 'variant' | 'note'
  groupId?: string
  variant?: number
  sub?: string
}
```

Title: `label/caption 'Palettes'`, `iconClass 'codicon codicon-symbol-color'`, closable.

`load(manifestPath)`: with no project, root = one note "Open a project to see its palettes". Else call `loadPalettes` with a `requestToken` guard; `rom-not-located` gives a note `Locate <title> to see its palettes`; `unreadable` gives a note with the reason. `ok` builds, in order:
1. A note per warning: `customPaletteLevelCount > 0` gives "N level(s) override these tables with a Lunar Magic custom palette this view does not read."; `!animation.available` gives "Level palette animation unavailable: <notes joined with '; '>".
2. One `group` node per `groups[]`, served order. `sub` is `N variant(s)`. A group with `variants.length > 1` gets `variant` children (`name` = the variant label) and `expanded: false`; a single-variant group has no children and no `expanded` key.
3. A final note "Overworld palettes are loaded by a different routine and are not shown here yet."

`fireOpen(node, pinned)`: `group` fires `{ groupId }`; `variant` fires `{ groupId, variant }`; `note` fires nothing. `renderCaption`: notes in italic description color via class `hb-palette-note`; groups/variants show `name` plus a `hb-palette-tree-sub` span with `sub`. `renderIcon`: `codicon-symbol-color` for group, none otherwise.

Subscribes to `ProjectContext.onChanged` and to `PaletteFrontendClient.onChanged` (same manifest: reload, keeping expansion because node ids are stable: group id `palette:<groupId>`, variant id `palette:<groupId>:<vi>`).

- [ ] **Step 2: `palette-explorer-contribution.ts`.**

```ts
/**
 * Puts Palettes in the left activity bar and routes a row to its tab.
 * Same shape as GfxExplorerContribution, including wiring an explorer that
 * Theia restored with the saved layout before this contribution started.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import { PaletteExplorerWidget, PaletteOpenRequest, PALETTE_EXPLORER_ID } from './palette-explorer-widget'
import { PaletteGroupViewWidget } from './palette-group-view-widget'
import { PALETTE_GROUP_VIEW_ID } from './palette-view-model'
import { PreviewTabs } from './preview-tabs'

export const ShowPaletteExplorerCommand: Command = {
  id: 'hackbench.palettes.focus',
  label: 'Palettes',
  category: 'HackBench',
}

@injectable()
export class PaletteExplorerContribution extends AbstractViewContribution<PaletteExplorerWidget> {
  @inject(PreviewTabs) protected readonly previews!: PreviewTabs

  constructor() {
    super({
      widgetId: PALETTE_EXPLORER_ID,
      widgetName: 'Palettes',
      defaultWidgetOptions: { area: 'left', rank: 300 },
      toggleCommandId: ShowPaletteExplorerCommand.id,
    })
  }

  async onStart(): Promise<void> {
    this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
      if (factoryId === PALETTE_EXPLORER_ID) this.wire(widget as PaletteExplorerWidget)
    })
    for (const existing of this.widgetManager.getWidgets(PALETTE_EXPLORER_ID)) {
      this.wire(existing as PaletteExplorerWidget)
    }
    await this.openView({ activate: false, reveal: false })
  }

  protected wire(explorer: PaletteExplorerWidget): void {
    explorer.onOpen(req => void this.openGroup(req))
  }

  /** Public so Playwright can open a tab without synthesising tree clicks. */
  async openGroup(req: PaletteOpenRequest): Promise<PaletteGroupViewWidget> {
    const opts = { manifestPath: req.manifestPath, groupId: req.groupId, variant: req.variant }
    const apply = (w: PaletteGroupViewWidget) => w.open(opts)
    if (req.pinned) {
      return this.previews.pin<PaletteGroupViewWidget>(
        PALETTE_GROUP_VIEW_ID,
        { groupId: req.groupId, variant: req.variant ?? null },
        apply,
        p => p.shows(opts),
      )
    }
    return this.previews.preview<PaletteGroupViewWidget>(PALETTE_GROUP_VIEW_ID, apply)
  }
}
```

- [ ] **Step 3: Module.** Replace `palette-frontend-module.ts`'s widget bindings (keep the CSS import, the client and the service proxy):

```ts
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: PALETTE_EXPLORER_ID,
      createWidget: () => createPaletteExplorerWidget(ctx.container),
    }))
    .inSingletonScope()

  // One widget per group or variant, keyed by PreviewTabs, so reopening focuses the existing tab.
  bind(PaletteGroupViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: PALETTE_GROUP_VIEW_ID,
      createWidget: () => ctx.container.get(PaletteGroupViewWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, PaletteExplorerContribution)
  bind(FrontendApplicationContribution).toService(PaletteExplorerContribution)
```

- [ ] **Step 4: Delete** `palette-view-widget.tsx` and `palette-view-contribution.ts`. `git grep -n "palette-view-widget\|PaletteViewWidget\|PALETTE_VIEW_ID\|palette-view-contribution"` must return only `theia/browser-app/test/palette-view.spec.cjs` (rewritten in Task 6) and docs.

- [ ] **Step 5: Verify** as Task 4 Step 6, plus build and launch: in `theia/`, `yarn build:browser`, then `yarn --cwd browser-app theia start --port <free port> --hostname 127.0.0.1` and confirm the Palettes icon shows in the left bar (orchestrator step).

- [ ] **Step 6: Commit** `feat(palette): Palettes explorer in the left activity bar opens per-group tabs`.

---

### Task 6: Playwright spec

**Files:**
- Rewrite: `theia/browser-app/test/palette-view.spec.cjs`

Keep, verbatim, the file's existing header block through `test.afterEach`, `GET_SVC`, `bgr555ToRgbTriplet`, `parseRgbTriplet`, `EXPECTED_GROUPS` and `COLS`. Replace the helpers and tests with the below. The implementing sub-agent writes the file; the orchestrator runs it.

- [ ] **Step 1: Helpers.**

```js
const EXPLORER = 'hackbench.palette-explorer'
const sel = id => '#' + id.replace(/[.:]/g, m => '\\' + m)

async function createProject(page, dir, romPath = ROM, name = 'MyHack') {
  return page.evaluate(
    async ({ romPath, directory, name }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name, directory }),
    { romPath, directory: dir, name },
  )
}

/** Opens a project in the shell the way File > Open does, so every palette widget reacts to it. */
async function openProject(page, dir, romPath) {
  const project = await createProject(page, dir, romPath)
  await page.evaluate(p => {
    getSvc('ProjectContext').current = p
  }, project)
  await page.waitForTimeout(500)
  return project
}

async function revealExplorer(page) {
  await page.evaluate(id => getSvc('ApplicationShell').activateWidget(id), EXPLORER)
  await page.waitForTimeout(800)
}

async function explorerResult(page) {
  return page.evaluate(async id => (await getWidget(id)).result, EXPLORER)
}

/** Opens a group or variant tab through the contribution, returning its widget id. */
async function openTab(page, manifestPath, groupId, variant, pinned = true) {
  const id = await page.evaluate(
    async ({ manifestPath, groupId, variant, pinned }) => {
      const w = await getSvc('PaletteExplorerContribution').openGroup({
        manifestPath,
        groupId,
        variant: variant === null ? undefined : variant,
        pinned,
      })
      return w.id
    },
    { manifestPath, groupId, variant: variant ?? null, pinned },
  )
  await page.waitForSelector(`${sel(id)} .hb-palette-swatch`, { timeout: 15000 })
  return id
}
```

- [ ] **Step 2: Tests.** Each asserts behavior.

```js
test('Palettes is in the left activity bar and reveals a tree of the six groups in served order', async ({ page }) => {
  const project = await openProject(page, path.join(tmp, 'MyHack'))
  const inLeft = await page.evaluate(
    id => getSvc('ApplicationShell').getWidgets('left').some(w => w.id === id),
    EXPLORER,
  )
  expect(inLeft).toBe(true)
  await revealExplorer(page)
  const labels = await page.evaluate(
    s => [...document.querySelectorAll(`${s} .theia-TreeNode`)].map(n => n.textContent),
    sel(EXPLORER),
  )
  const r = await explorerResult(page)
  expect(r.palettes.groups.map(g => g.id)).toEqual(EXPECTED_GROUPS.map(g => g.id))
  for (const g of r.palettes.groups) expect(labels.some(l => l.includes(g.label))).toBe(true)
  expect(project.manifestPath).toBeTruthy()
})

test('single click previews a group in an italic tab, double click pins it', async ({ page }) => {
  await openProject(page, path.join(tmp, 'MyHack'))
  await revealExplorer(page)
  const node = page.locator(`${sel(EXPLORER)} .theia-TreeNode`, { hasText: 'Shared Sprite Colors' })
  // Rendered style, not just the class: index.css styles .hb-preview-tab .theia-tab-icon-label.
  const tabStyles = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.lm-TabBar-tab, .p-TabBar-tab')]
        .filter(t => (t.textContent || '').includes('Shared Sprite Colors'))
        .map(t => getComputedStyle(t.querySelector('.theia-tab-icon-label')).fontStyle),
    )
  await node.click()
  await page.waitForTimeout(500)
  expect(await tabStyles()).toEqual(['italic'])
  await node.dblclick()
  await page.waitForTimeout(500)
  expect(await tabStyles()).toEqual(['normal'])
})

test('a variant row opens a tab with exactly that one variant', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'bg', 3)
  const state = await page.evaluate(s => {
    const el = document.querySelector(s)
    return { sections: el.querySelectorAll('.hb-palette-variant').length, rows: el.querySelectorAll('.hb-palette-row').length }
  }, sel(id))
  expect(state).toEqual({ sections: 1, rows: 2 })
  expect(await page.evaluate(i => document.getElementById(i) && getSvc('ApplicationShell').getWidgetById(i).title.label, id)).toBe(
    'Layer 2 Background \u00b7 Variant 3',
  )
})

test('column 0 is hatched in every Layer 2 variant and Back Area Colors draws 8 swatches at the same size', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const bg = await openTab(page, p.manifestPath, 'bg')
  const col0 = await page.evaluate(
    s => [...document.querySelectorAll(`${s} .hb-palette-variant`)].map(v => v.querySelector('.hb-palette-swatch').classList.contains('hb-palette-swatch-unwritten')),
    sel(bg),
  )
  expect(col0).toEqual(Array(8).fill(true))
  const ref = await page.locator(`${sel(bg)} .hb-palette-swatch`).first().evaluate(e => e.getBoundingClientRect().width)
  const ba = await openTab(page, p.manifestPath, 'back_area')
  const swatches = page.locator(`${sel(ba)} .hb-palette-swatch`)
  expect(await swatches.count()).toBe(8)
  expect(await page.locator(`${sel(ba)} .hb-palette-row-gutter`).count()).toBe(0)
  expect(await swatches.first().evaluate(e => e.getBoundingClientRect().width)).toBe(ref)
})

test('a group tab dragged into a split keeps rendering and accepting edits', async ({ page }) => {
  const dir = path.join(tmp, 'MyHack')
  const p = await openProject(page, dir)
  const player = await openTab(page, p.manifestPath, 'player')
  const bg = await openTab(page, p.manifestPath, 'bg')
  await page.evaluate(
    ({ player, bg }) => {
      const shell = getSvc('ApplicationShell')
      shell.addWidget(shell.getWidgetById(player), { area: 'main', mode: 'split-right', ref: shell.getWidgetById(bg) })
    },
    { player, bg },
  )
  await page.waitForTimeout(500)
  const boxes = await page.evaluate(
    ids => ids.map(i => document.getElementById(i).getBoundingClientRect().left),
    [player, bg],
  )
  expect(boxes[0]).not.toBe(boxes[1]) // side by side, both visible
  await page.locator(`${sel(player)} .hb-palette-variant`).first().locator('.hb-palette-swatch').nth(9).click()
  const hex = page.locator(`${sel(player)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(400)
  const opFiles = fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.json'))
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'ops', opFiles[0]), 'utf8'))
  expect(layer.ops).toContainEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })
})

test('an edit in a variant tab updates the same cell in an open group tab', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const group = await openTab(page, p.manifestPath, 'player')
  const variant = await openTab(page, p.manifestPath, 'player', 0)
  const groupSwatch = page.locator(`${sel(group)} .hb-palette-variant`).first().locator('.hb-palette-swatch').nth(9)
  await page.locator(`${sel(variant)} .hb-palette-swatch`).nth(9).click()
  const hex = page.locator(`${sel(variant)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(600)
  expect(parseRgbTriplet(await groupSwatch.evaluate(e => getComputedStyle(e).backgroundColor))).toEqual(bgr555ToRgbTriplet(0x03e0))
})

test('the animated color plays in the preview, with its frames directly beneath', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  const r = await explorerResult(page)
  const t = r.palettes.animation.targets.find(x => x.cgramIdx === 0x64)
  expect(r.palettes.animation.available).toBe(true)
  expect(t.frames.length).toBeGreaterThan(1)
  // CGRAM $64 is Shared Sprite Colors row index 2 (CGRAM 6), column 4.
  const cell = page.locator(`${sel(id)} .hb-palette-row`).nth(2).locator('.hb-palette-swatch').nth(4)
  await expect(cell).toHaveClass(/hb-palette-swatch-animated/)
  await cell.click()
  const samples = await page.evaluate(async s => {
    const el = document.querySelector(`${s} .hb-palette-preview`)
    const out = []
    const t0 = performance.now()
    while (performance.now() - t0 < 1600) {
      out.push({ t: performance.now() - t0, c: getComputedStyle(el).backgroundColor })
      await new Promise(r => setTimeout(r, 16))
    }
    return out
  }, sel(id))
  const distinct = new Set(samples.map(s => s.c))
  const expectedDistinct = new Set(t.frames.map(f => `${f.color.r},${f.color.g},${f.color.b}`)).size
  expect(distinct.size).toBe(expectedDistinct)
  // No frozen span: the color must change at least once in any 4 frame periods.
  let last = samples[0]
  let longest = 0
  for (const s of samples) {
    if (s.c !== last.c) {
      longest = Math.max(longest, s.t - last.t)
      last = s
    }
  }
  longest = Math.max(longest, samples[samples.length - 1].t - last.t)
  expect(longest).toBeLessThan(4 * t.intervalMs + 100)
  // Frames sit directly under the preview.
  const gap = await page.evaluate(s => {
    const pv = document.querySelector(`${s} .hb-palette-preview`).getBoundingClientRect()
    const fr = document.querySelector(`${s} .hb-palette-frames`).getBoundingClientRect()
    return fr.top - pv.bottom
  }, sel(id))
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThan(16)
})

test('editing a frame persists an op file and updates every linked frame', async ({ page }) => {
  const dir = path.join(tmp, 'MyHack')
  const p = await openProject(page, dir)
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  await page.locator(`${sel(id)} .hb-palette-row`).nth(2).locator('.hb-palette-swatch').nth(4).click()
  const frames = page.locator(`${sel(id)} .hb-palette-frames .hb-palette-swatch`)
  await frames.nth(0).click()
  const r = await explorerResult(page)
  const t = r.palettes.animation.targets.find(x => x.cgramIdx === 0x64)
  const addr = t.frames[0].romAddr
  const linked = t.frames.map((f, i) => (f.romAddr === addr ? i : -1)).filter(i => i >= 0)
  const hex = page.locator(`${sel(id)} .hb-palette-inspector-hex`)
  const old = await hex.inputValue()
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(600)
  for (const i of linked) {
    expect(parseRgbTriplet(await frames.nth(i).evaluate(e => getComputedStyle(e).backgroundColor))).toEqual(bgr555ToRgbTriplet(0x03e0))
  }
  const opFiles = fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.json'))
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'ops', opFiles[0]), 'utf8'))
  const a = '$' + addr.toString(16).toUpperCase().padStart(6, '0')
  expect(layer.ops).toContainEqual({ address: a, old: '$' + old, new: '$03E0' })
})

test('a ROM whose level animation routine is patched out shows the reason and no markers', async ({ page }) => {
  // $00A418 poked to RTS: the routine is intact but never reaches its write (CLAUDE.md, "Existing is not the same as reached").
  const romPath = path.join(tmp, 'patched.sfc')
  const bytes = fs.readFileSync(ROM)
  bytes[0x2418] = 0x60
  fs.writeFileSync(romPath, bytes)
  const p = await openProject(page, path.join(tmp, 'Patched'), romPath)
  await revealExplorer(page)
  const r = await explorerResult(page)
  expect(r.palettes.animation.available).toBe(false)
  expect(r.palettes.animation.targets).toEqual([])
  const text = await page.evaluate(s => document.querySelector(s).innerText, sel(EXPLORER))
  expect(text).toMatch(/Level palette animation unavailable/)
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  expect(await page.locator(`${sel(id)} .hb-palette-swatch-animated`).count()).toBe(0)
})

test('switching projects closes palette tabs', async ({ page }) => {
  const a = await openProject(page, path.join(tmp, 'A'))
  const id = await openTab(page, a.manifestPath, 'player')
  await openProject(page, path.join(tmp, 'B'))
  expect(await page.evaluate(i => !!getSvc('ApplicationShell').getWidgetById(i), id)).toBe(false)
})

test('a stale refusal in one tab leaves its grid visible', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'player')
  await page.locator(`${sel(id)} .hb-palette-variant`).first().locator('.hb-palette-swatch').nth(9).click()
  // Real races are not a reliable oracle (the push refresh usually wins), so
  // the service answers this tab's edit with the refusal WorkingRom.append gives.
  await page.evaluate(i => {
    const w = getSvc('ApplicationShell').getWidgetById(i)
    const real = w.palettes
    w.palettes = {
      loadPalettes: mp => real.loadPalettes(mp),
      setColor: async () => ({ status: 'stale', reason: '$00B2CE no longer holds $391F' }),
    }
  }, id)
  const hex = page.locator(`${sel(id)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(400)
  await expect(page.locator(`${sel(id)} .hb-palette-inspector-from-error`)).toHaveText(/no longer holds/)
  expect(await page.locator(`${sel(id)} .hb-palette-swatch`).count()).toBeGreaterThan(0)
})

test('a narrow tab wraps the inspector below the grid', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForTimeout(400)
  const pos = await page.evaluate(s => {
    const m = document.querySelector(`${s} .hb-palette-main`).getBoundingClientRect()
    const i = document.querySelector(`${s} .hb-palette-inspector`).getBoundingClientRect()
    return { inspectorTop: i.top, gridBottom: m.bottom, inspectorRight: i.right, tabRight: document.querySelector(s).getBoundingClientRect().right }
  }, sel(id))
  expect(pos.inspectorTop).toBeGreaterThanOrEqual(pos.gridBottom - 1)
  expect(pos.inspectorRight).toBeLessThanOrEqual(pos.tabRight + 1)
})

test("a reloaded window's explorer still opens tabs", async ({ page }) => {
  await openProject(page, path.join(tmp, 'MyHack'))
  await revealExplorer(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await openProject(page, path.join(tmp, 'Again'))
  await revealExplorer(page)
  await page.locator(`${sel(EXPLORER)} .theia-TreeNode`, { hasText: 'Player Palettes' }).dblclick()
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => !!document.querySelector('[id^="hackbench.palette-group-view:player"] .hb-palette-swatch'))).toBe(true)
})
```

Also port, adapted to `openProject` + `openTab`, the existing tests "every written cell's colour matches the actual ROM bytes at the address it cites" (now iterating `explorerResult`), "a cartridge too short ... unreadable" (explorer shows a note with the reason; no `.hb-palette-swatch` anywhere), "no project open shows an explicit empty state" (explorer shows "Open a project to see its palettes"), "the palette view is labelled and carries a real, defined codicon class" (for `hackbench.palette-explorer`), the picker + OK and Cancel/Escape tests (inside a `player` tab), and "a stale response never overwrites a newer one" (stub `w.palettes` on a `PaletteGroupViewWidget` and call `open` twice).

- [ ] **Step 3: Plant defects to prove the spec can go red** (orchestrator): (a) remove `this.close()` in the view's `context.onChanged`: the project-switch test must fail; (b) replace `framePhase` return with `0`: the animation test must fail; (c) drop `flex-wrap: wrap`: the narrow-tab test must fail. Revert each.

- [ ] **Step 4: Commit** `test(e2e): palette explorer, tabs, frame editing`.

---

### Task 7: Finish

- [ ] Full unit suite with and without the ROM corpus (report both skip counts), `npm run lint`, `npm run format:check`, `yarn build:browser`, full `palette-view.spec.cjs` run.
- [ ] `npm run gitnexus`, then `detect_changes` against `develop`.
- [ ] Two fresh-agent reviews (adversarial on the most capable model, and simplification) against the branch diff; fix findings.
- [ ] Open the PR against `develop`. Log a follow-up issue for editing animation timing.
