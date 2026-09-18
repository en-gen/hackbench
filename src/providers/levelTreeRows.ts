import { hex3 } from '../rom/hex'
import { LevelTreeNode, MAX_SUBTREE_NODES, MAX_SUBTREE_DEPTH } from '../rom/LevelTree'

export type RoomRole = 'entrance' | 'sub' | 'resource' | 'loop' | 'truncated'

/** Everything a room row renders, decided from plain data so it can be tested. */
export interface RoomRow {
  role: RoomRole
  label: string
  description?: string
  tooltip?: string
  icon: string
  collapsible: boolean
  contextValue: string
  /** Path under `smwrom:/<slug>/` that the row opens. */
  resourcePath: string
}

const ICONS: Record<RoomRole, string> = {
  entrance: 'home',
  sub: 'group-by-ref-type',
  resource: 'file-code',
  loop: 'issue-reopened',
  truncated: 'warning',
}

// A marker row states why it does not expand; without that it is indistinguishable
// from a genuine dead end.
const MARKERS: Partial<Record<RoomRole, { suffix: string; tooltip: (hex: string) => string }>> = {
  loop: {
    suffix: '(loops back)',
    tooltip: hex => `$${hex} is already open higher in this branch; expansion stops here.`,
  },
  truncated: {
    suffix: '(not expanded)',
    tooltip: hex => `$${hex} was not expanded: this level hit the sub-area display cap ` +
      `(${MAX_SUBTREE_NODES} rows or depth ${MAX_SUBTREE_DEPTH}), so its branch is incomplete.`,
  },
}

export function roomRow(
  index: number,
  name: string | null,
  role: RoomRole,
  childCount: number,
): RoomRow {
  const hex = hex3(index)
  const marker = MARKERS[role]
  // An unnamed room's label is already `$hex`, so repeating it here prints it twice.
  const description = name
    ? [`$${hex}`, marker?.suffix].filter(Boolean).join(' ')
    : marker?.suffix
  return {
    role,
    label: name ?? `$${hex}`,
    description,
    tooltip: marker?.tooltip(hex),
    icon: ICONS[role],
    collapsible: childCount > 0,
    contextValue: `smwRoom_${role}`,
    resourcePath: `maps/${hex}.smwmap`,
  }
}

/** Sub-area rows take their role from the node kind; a plain room is a 'sub' row. */
export function roomRowForNode(node: LevelTreeNode, name: string | null): RoomRow {
  return roomRow(
    node.index, name,
    node.kind === 'room' ? 'sub' : node.kind,
    node.children.length,
  )
}
