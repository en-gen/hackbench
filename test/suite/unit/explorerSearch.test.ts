import { describe, expect, it } from 'vitest'
import {
  filterTree,
  parseQuery,
  pickSelectTarget,
  restorePlan,
  rowMatches,
  type SearchRow,
} from '../../../theia/extension/src/browser/explorer-match'
import { parseHexId } from '../../../src/project/HexId'

const hex = (n: number) => n.toString(16)

describe('parseHexId', () => {
  it('reads every spelling of every id in the slot range to the same number', () => {
    for (let n = 0; n <= 0x1ff; n++) {
      const h = hex(n)
      for (const form of [
        h,
        h.toUpperCase(),
        `$${h}`,
        `0x${h}`,
        `0X${h.toUpperCase()}`,
        ` $${h} `,
      ]) {
        expect(parseHexId(form), form).toBe(n)
      }
    }
  })

  it('refuses text that is not hex', () => {
    for (const bad of ['', '$', '0x', 'xyz', '1g', '$$1', '10 5', 'castle']) {
      expect(parseHexId(bad), bad).toBeNull()
    }
  })
})

describe('rowMatches', () => {
  const slot = (n: number) => ({ id: n, texts: ['Donut Plains 1'] })

  it('matches a row by id in any form, and only that row', () => {
    for (let n = 0; n <= 0x1ff; n++) {
      const other = (n + 1) & 0x1ff
      for (const q of [hex(n), `$${hex(n)}`, `0x${hex(n)}`]) {
        expect(rowMatches(parseQuery(q), { id: n, texts: [] }), q).toBe(true)
        expect(rowMatches(parseQuery(q), { id: other, texts: [] }), q).toBe(false)
      }
    }
  })

  it('a $ or 0x prefix is id-only, so a name containing the digits does not match', () => {
    const row = { id: 5, texts: ['Level 105 castle'] }
    expect(rowMatches(parseQuery('105'), row)).toBe(true)
    expect(rowMatches(parseQuery('$105'), row)).toBe(false)
    expect(rowMatches(parseQuery('0x105'), row)).toBe(false)
    expect(rowMatches(parseQuery('$5'), row)).toBe(true)
  })

  it('matches names by case-insensitive substring across all texts', () => {
    const row = { id: 9, texts: ['DONUT PLAINS 1', 'my alias'] }
    expect(rowMatches(parseQuery('plains'), row)).toBe(true)
    expect(rowMatches(parseQuery('ALIAS'), row)).toBe(true)
    expect(rowMatches(parseQuery('nope'), row)).toBe(false)
  })

  it('a row with no id never matches by number, and an empty query matches nothing', () => {
    expect(rowMatches(parseQuery('0'), { texts: ['Folder'] })).toBe(false)
    expect(rowMatches(parseQuery(''), slot(0))).toBe(false)
    expect(rowMatches(parseQuery('   '), slot(0))).toBe(false)
  })
})

describe('id-only queries (a literal prefix in a row text must not leak through)', () => {
  // Every text holds the query's own characters; only the id-only flag keeps
  // them from matching. Row id 0x99 differs from 0x1d, so id never matches.
  const row = { id: 0x99, texts: ['Level $1D castle', 'x 0x1d y', 'tag 0X1D'] }

  it.each(['$1D', '$1d', '0x1d', '0X1D', '0x1D'])('%s matches no text', q => {
    expect(rowMatches(parseQuery(q), row)).toBe(false)
  })

  it.each(['$1D', '0x1d', '0X1D'])('%s is flagged id-only, case-insensitively', q => {
    expect(parseQuery(q).idOnly).toBe(true)
  })

  it('the same digits without a prefix do match the text', () => {
    expect(rowMatches(parseQuery('1d'), row)).toBe(true)
  })
})

describe('incomplete id prefixes', () => {
  it.each(['$', '0x', '0X', ' $ '])('%j is incomplete and matches nothing', q => {
    const parsed = parseQuery(q)
    expect(parsed.incomplete).toBe(true)
    expect(rowMatches(parsed, { id: 0, texts: ['$', '0x', 'a'] })).toBe(false)
  })

  it.each(['$1', '0x0', '1', 'a', '$x'])('%j is not incomplete', q => {
    expect(parseQuery(q).incomplete).toBe(false)
  })
})

interface N {
  id: string
  name: string
  row?: SearchRow
  expanded?: boolean
  parent?: N
  children?: N[]
}

function node(id: string, kids?: N[], init: Partial<N> = {}): N {
  const n: N = { id, name: id, ...init }
  if (kids) {
    n.children = kids
    kids.forEach(k => (k.parent = n))
  }
  return n
}
const rowOf = (n: N) => n.row

describe('filterTree', () => {
  const build = () => {
    const leaf = node('leaf', undefined, { row: { id: 1, texts: ['castle'] } })
    const inner = node(
      'inner',
      [leaf, node('other', undefined, { row: { id: 2, texts: ['x'] } })],
      {
        row: { folder: true, texts: ['Unassigned'] },
      },
    )
    const top = node('top', [inner, node('lonely', undefined, { row: { id: 3, texts: ['y'] } })], {
      row: { folder: true, texts: ['Group'] },
    })
    return { root: node('root', [top]), leaf }
  }

  it('shows a matching leaf and its ancestors only', () => {
    const { root, leaf } = build()
    const r = filterTree(root, parseQuery('castle'), rowOf)
    expect(r.matches).toEqual([leaf])
    expect([...r.shown].sort()).toEqual(['inner', 'leaf', 'root', 'top'])
  })

  it('a matching folder shows everything under it, and its own match does not need a leaf', () => {
    const { root } = build()
    const r = filterTree(root, parseQuery('unassigned'), rowOf)
    expect(r.matches.map(m => m.id)).toEqual(['inner'])
    expect([...r.shown].sort()).toEqual(['inner', 'leaf', 'other', 'root', 'top'])
  })

  it('an incomplete query shows nothing and matches nothing', () => {
    const { root } = build()
    expect(filterTree(root, parseQuery('$'), rowOf).matches).toEqual([])
  })
})

describe('pickSelectTarget', () => {
  const isFolder = (n: { f: boolean }) => n.f
  it('prefers a leaf over an earlier folder', () => {
    const a = { f: true }
    const b = { f: false }
    expect(pickSelectTarget([a, b], isFolder)).toBe(b)
  })
  it('takes the folder when it is all there is, and nothing when nothing matched', () => {
    const a = { f: true }
    expect(pickSelectTarget([a], isFolder)).toBe(a)
    expect(pickSelectTarget([], isFolder)).toBeUndefined()
  })
})

describe('restorePlan', () => {
  // The music case: before the filter only bank:overworld was open (under a
  // folded group:music); the user folded group:music and bank:level, and the
  // filter `$1` then opened both.
  const tree = (open: string[]) => {
    const e = (id: string, kids?: N[]) => node(id, kids, { expanded: open.includes(id) })
    const overworld = e('bank:overworld', [node('t1')])
    const level = e('bank:level', [node('t2')])
    return node('root', [e('group:music', [overworld, level]), e('group:sfx', [node('s1')])])
  }
  const apply = (root: N, plan: ReturnType<typeof restorePlan<N>>) =>
    plan.forEach(p => (p.node.expanded = p.expand))
  const openIds = (root: N): string[] => {
    const out: string[] = []
    const walk = (n: N) => {
      if (n.expanded) out.push(n.id)
      n.children?.forEach(walk)
    }
    walk(root)
    return out.sort()
  }

  it('closes what the filter opened below a folder the user had closed', () => {
    const root = tree(['group:music', 'bank:level', 'bank:overworld', 'group:sfx'])
    apply(root, restorePlan(root, new Set(['bank:overworld'])))
    expect(openIds(root)).toEqual(['bank:overworld'])
  })

  it('reopens what was open, and leaves a matching state alone', () => {
    const root = tree([])
    const plan = restorePlan(root, new Set(['group:music', 'group:sfx']))
    expect(plan.map(p => p.node.id)).toEqual(['group:music', 'group:sfx'])
    apply(root, plan)
    expect(openIds(root)).toEqual(['group:music', 'group:sfx'])
    expect(restorePlan(root, new Set(['group:music', 'group:sfx']))).toEqual([])
  })

  it('never touches a node that cannot expand', () => {
    const root = tree([])
    expect(restorePlan(root, new Set(['t1'])).map(p => p.node.id)).toEqual([])
  })
})
