/**
 * The edit event: one CloudEvents-shaped envelope for "the working copy's
 * bytes changed", built in ONE place (WorkingCopyNotifier) and pushed to the
 * frontend on one channel (#576).
 *
 * `cloudevents` is imported for its TYPE only (ESLint no-restricted-imports
 * refuses a value import): the envelope is a plain object, so nothing of the
 * library ships.
 *
 * - `type`: `hackbench.edit.applied` for a layer going on (an edit, a redo),
 *   `hackbench.edit.reverted` for one coming off (an undo, or the rollback of
 *   an edit that never reached disk).
 * - `subject`: the project's manifest path.
 * - `data.ranges`: FILE OFFSETS into the working copy's bytes, half-open
 *   `[start, end)`, with a copier header counted if the file has one. NOT
 *   SNES addresses. Overlapping or touching ranges are coalesced. A gfx layer
 *   has no ROM range (it is addressed by file and character), so its list is
 *   empty.
 * - `data.domain`: which editor made the change. Palette and Map16 both write
 *   word ops; the op's `mask` tells them apart, because Map16 always writes
 *   the full 16 bits (FULL_WORD_MASK, persisted with the op) and a palette
 *   colour never carries a mask. That survives a reload, where a field on
 *   the layer would not (ops files hold id, label and ops only).
 */
import { randomUUID } from 'crypto'
import type { CloudEventV1 } from 'cloudevents'
import { FULL_WORD_MASK } from '../rom/PaletteOp'
import type { Layer, WorkingRom, WorkingRomChange } from './WorkingRom'

export type EditDomain = 'palette' | 'map16' | 'gfx'
export type EditEventType = 'hackbench.edit.applied' | 'hackbench.edit.reverted'

/** Half-open `[start, end)`, in file offsets of the working copy. */
export interface FileOffsetRange {
  start: number
  end: number
}

export interface EditData {
  domain: EditDomain
  ranges: FileOffsetRange[]
}

export type EditEvent = CloudEventV1<EditData> & { type: EditEventType; subject: string }

export const EDIT_EVENT_SOURCE = 'urn:hackbench:working-copy'

/** Sorted, with overlapping and touching ranges merged. */
export function coalesceRanges(ranges: readonly FileOffsetRange[]): FileOffsetRange[] {
  const sorted = ranges.map(r => ({ ...r })).sort((a, b) => a.start - b.start)
  const out: FileOffsetRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push(r)
  }
  return out
}

export function domainOf(layer: Layer): EditDomain {
  if (layer.kind === 'gfx') return 'gfx'
  if (layer.kind === 'unreadable') return 'palette' // never applied, so never reported
  return layer.ops.length > 0 && layer.ops.every(op => op.mask === FULL_WORD_MASK)
    ? 'map16'
    : 'palette'
}

/** The envelope itself; the caller supplies what the layer says. */
export function buildEditEvent(args: {
  manifestPath: string
  applied: boolean
  domain: EditDomain
  ranges: readonly FileOffsetRange[]
  id?: string
  time?: Date
}): EditEvent {
  return {
    specversion: '1.0',
    id: args.id ?? randomUUID(),
    source: EDIT_EVENT_SOURCE,
    type: args.applied ? 'hackbench.edit.applied' : 'hackbench.edit.reverted',
    subject: args.manifestPath,
    time: (args.time ?? new Date()).toISOString(),
    datacontenttype: 'application/json',
    data: { domain: args.domain, ranges: coalesceRanges(args.ranges) },
  }
}

/** The event for one change of `working`: a layer applied (append) or reverted (pop). */
export function editEventFor(
  manifestPath: string,
  change: WorkingRomChange,
  working: WorkingRom,
): EditEvent {
  return buildEditEvent({
    manifestPath,
    applied: change.kind === 'append',
    domain: domainOf(change.layer),
    ranges: working.wordOffsets(change.layer).map(start => ({ start, end: start + 2 })),
  })
}
