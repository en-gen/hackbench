/**
 * The vscode API is not mockable in this repo (no harness, no precedent), so
 * RoomItem's decisions live in roomRow()/roomRowForNode() as plain data. These
 * tests are the only cover the Maps tree's rendering has; a regression in the
 * marker roles or the collapsible state shows up here or nowhere.
 */
import { describe, it, expect } from 'vitest'
import { roomRow, roomRowForNode } from '../../../src/providers/levelTreeRows'
import { LevelTreeNode } from '../../../src/rom/LevelTree'

const node = (kind: LevelTreeNode['kind'], children: LevelTreeNode[] = []): LevelTreeNode => ({
  index: 0x1dd,
  children,
  kind,
})
const leaf = (index: number): LevelTreeNode => ({ index, children: [], kind: 'room' })

describe('roomRow', () => {
  it('shows the hex only once for an unnamed room', () => {
    const row = roomRow(0x0e7, null, 'sub', 0)
    expect(row.label).toBe('$0E7')
    expect(row.description).toBeUndefined()
  })

  it('shows name plus hex for a named room', () => {
    const row = roomRow(0x105, "YOSHI'S ISLAND 1", 'sub', 0)
    expect(row.label).toBe("YOSHI'S ISLAND 1")
    expect(row.description).toBe('$105')
  })

  it('shows only the loop marker for an unnamed loop row, not the hex twice', () => {
    // Every loop row in the six-ROM corpus is $1DD, which decodes no name.
    const row = roomRow(0x1dd, null, 'loop', 0)
    expect(row.label).toBe('$1DD')
    expect(row.description).toBe('(loops back)')
  })

  it('keeps the hex in the description when a loop row is named', () => {
    expect(roomRow(0x1dd, 'DONUT PLAINS 3', 'loop', 0).description).toBe('$1DD (loops back)')
  })

  it('marks a truncated row and says why in the tooltip', () => {
    const row = roomRow(0x0c0, null, 'truncated', 0)
    expect(row.description).toBe('(not expanded)')
    expect(row.icon).toBe('warning')
    expect(row.tooltip).toContain('display cap')
  })

  it('gives a loop row a tooltip and a non-default icon', () => {
    const row = roomRow(0x1dd, null, 'loop', 0)
    expect(row.icon).toBe('issue-reopened')
    expect(row.tooltip).toContain('expansion stops here')
  })

  it('leaves plain rows without a tooltip', () => {
    for (const role of ['sub', 'resource'] as const) {
      expect(roomRow(0x0e7, null, role, 0).tooltip).toBeUndefined()
    }
  })

  it.each([
    { role: 'sub' as const, icon: 'group-by-ref-type' },
    { role: 'resource' as const, icon: 'file-code' },
  ])('gives a $role row the $icon icon and its own contextValue', ({ role, icon }) => {
    const row = roomRow(0x0e7, null, role, 0)
    expect(row.icon).toBe(icon)
    expect(row.contextValue).toBe(`smwRoom_${role}`)
  })

  it('opens the same virtual file whatever the role', () => {
    for (const role of ['sub', 'loop', 'truncated', 'resource'] as const) {
      expect(roomRow(0x0e7, null, role, 0).resourcePath).toBe('maps/0E7.smwmap')
    }
  })

  it('is collapsible only when it has children', () => {
    expect(roomRow(0x0e7, null, 'sub', 0).collapsible).toBe(false)
    expect(roomRow(0x0e7, null, 'sub', 2).collapsible).toBe(true)
  })
})

describe('roomRowForNode', () => {
  it('renders a plain room node as an expandable sub row', () => {
    const row = roomRowForNode(node('room', [leaf(0x0c0)]), null)
    expect(row.role).toBe('sub')
    expect(row.collapsible).toBe(true)
  })

  it('renders a loop node as a loop row that cannot expand', () => {
    const row = roomRowForNode(node('loop'), null)
    expect(row.role).toBe('loop')
    expect(row.collapsible).toBe(false)
    expect(row.description).toBe('(loops back)')
  })

  it('renders a truncated node as a truncated row that cannot expand', () => {
    const row = roomRowForNode(node('truncated'), null)
    expect(row.role).toBe('truncated')
    expect(row.collapsible).toBe(false)
  })
})
