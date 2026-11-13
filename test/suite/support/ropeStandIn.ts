/**
 * A stand-in for the rope's draw (#1230): one 16 px part per tile going DOWN, 9 tiles when the slot is the high one and the
 * setting is not 0, else 5; the first part's char is the slot (the motor tile). The ROM's own draw is in the corpus tests.
 */
import type { SpriteModel, SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'

const part = (dy: number, char: number): SpritePart => ({ oam: 0, char, size: 16, palette: 8, priority: 2, flipX: false, flipY: false, dx: 0, dy, attr: 0, ox: 0, oy: 0 }) // prettier-ignore

/** `snaps` is the line-guided gate's verdict on the draw; `anchorX` lets a test move the start per slot. */
export const drawer =
  (setting: number, seen: number[] = [], anchorX = (_s: number) => 100, snaps = true) =>
  (slot: number): SpriteModel => {
    seen.push(slot)
    const n = slot >= 6 && setting !== 0 ? 9 : 5
    const parts = Array.from({ length: n }, (_, i) => part(i * 16, i === 0 ? slot : 0x40))
    return { chosen: 0, snaps, anchor: { x: anchorX(slot), y: 50 }, passes: [0, 1].map(pass => ({ pass, parts, companions: [], palette: [] })) } as unknown as SpriteModel // prettier-ignore
  }

/** A model whose first pass draws parts at these `dy`s (the first one carries the slot as its char). */
export const standIn = (dys: number[], slot: number): SpriteModel =>
  ({ chosen: 0, snaps: true, anchor: { x: 100, y: 50 }, passes: [{ pass: 0, parts: dys.map((dy, i) => part(dy, i === 0 ? slot : 0x40)), companions: [], palette: [] }] }) as unknown as SpriteModel // prettier-ignore
