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

export function animatedColumns(
  targets: PaletteAnimTargetDto[],
  cgramRow: number | null,
): Set<number> {
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
  return `${group.label} · ${group.variants[variant]?.label ?? `Variant ${variant}`}`
}

export function cellTitle(group: PaletteGroupDto, cgramRow: number | null, index: number): string {
  if (cgramRow === null) return `${group.label} · ${index}`
  const idx = (cgramRow * 16 + index).toString(16).toUpperCase().padStart(2, '0')
  return `CGRAM $${idx} · ${group.label}`
}

export function viewWidgetId(groupId: string, variant: number | undefined): string {
  return variant === undefined
    ? `${PALETTE_GROUP_VIEW_ID}:${groupId}`
    : `${PALETTE_GROUP_VIEW_ID}:${groupId}:${variant}`
}
