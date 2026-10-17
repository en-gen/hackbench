import { describe, expect, it } from 'vitest'
import {
  filterTree,
  mapSlotRow,
  paletteSearchRow,
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

  it('a root of rows nothing can match is not searchable, so the filter leaves it alone', () => {
    const msg = node('root', [node('message')])
    expect(filterTree(msg, parseQuery('zzz'), rowOf).searchable).toBe(false)
    const { root } = build()
    expect(filterTree(root, parseQuery('zzz'), rowOf).searchable).toBe(true)
  })

  it('the root is never a row: a rowOf that classifies it does not make a message-only tree searchable', () => {
    // Music's rowOf calls any non-leaf a folder, Maps' falls through to a map.
    const root = node('root', [node('message')], { row: { folder: true, texts: ['audio'] } })
    const r = filterTree(root, parseQuery('zzz'), rowOf)
    expect(r.searchable).toBe(false)
    expect(r.matches).toEqual([])
    // Nor can it match: a query naming the root's own text finds nothing.
    expect(filterTree(root, parseQuery('audio'), rowOf).matches).toEqual([])
    const empty = node('root', [], { row: { id: 1, texts: ['x'] } })
    expect(filterTree(empty, parseQuery('x'), rowOf).searchable).toBe(false)
  })

  it('an incomplete query shows nothing and matches nothing', () => {
    const { root } = build()
    expect(filterTree(root, parseQuery('$'), rowOf).matches).toEqual([])
  })
})

describe('pickSelectTarget', () => {
  type R = { name: string; row: SearchRow }
  const r = (name: string, row: SearchRow): R => ({ name, row })
  const rowOf = (n: R) => n.row
  it('prefers a leaf over an earlier folder', () => {
    const a = r('a', { folder: true, texts: [] })
    const b = r('b', { texts: [] })
    expect(pickSelectTarget([a, b], rowOf)).toBe(b)
  })
  it('prefers an openable leaf over an earlier marker row (Enter acts on the selection)', () => {
    const marker = r('marker', { openable: false, texts: [] })
    const map = r('map', { openable: true, texts: [] })
    const unflagged = r('unflagged', { texts: [] })
    expect(pickSelectTarget([marker, map], rowOf)).toBe(map)
    expect(pickSelectTarget([marker, unflagged], rowOf)).toBe(unflagged)
  })
  it('falls back to a marker, then a folder, when nothing better matched', () => {
    const marker = r('marker', { openable: false, texts: [] })
    const folder = r('folder', { folder: true, texts: [] })
    expect(pickSelectTarget([folder, marker], rowOf)).toBe(marker)
    expect(pickSelectTarget([folder], rowOf)).toBe(folder)
    expect(pickSelectTarget([], rowOf)).toBeUndefined()
  })
})

describe('palette rows', () => {
  const group = (row: number | undefined, name = 'Level Sprite Colors') =>
    paletteSearchRow({ kind: 'group', name, row })!
  const variant = (name: string) => paletteSearchRow({ kind: 'variant', name })!

  it('a group row number is DECIMAL, as the view shows it: 14 finds row 14, $e does not', () => {
    expect(rowMatches(parseQuery('14'), group(14))).toBe(true)
    expect(rowMatches(parseQuery('14'), group(20))).toBe(false)
    expect(rowMatches(parseQuery('8'), group(8))).toBe(true)
    expect(rowMatches(parseQuery('$e'), group(14))).toBe(false)
  })

  it('$ and 0x stay hex, so they never read a group row as decimal', () => {
    expect(rowMatches(parseQuery('$14'), group(14))).toBe(false)
    expect(rowMatches(parseQuery('0x14'), group(14))).toBe(false)
    expect(rowMatches(parseQuery('$14'), group(20))).toBe(false)
  })

  it('a group with no CGRAM row is found by name only', () => {
    expect(rowMatches(parseQuery('0'), group(undefined))).toBe(false)
    expect(rowMatches(parseQuery('sprite'), group(undefined))).toBe(true)
  })

  it('"palette 3" finds the variant labelled Palette 3 and not Palette 2', () => {
    expect(rowMatches(parseQuery('palette 3'), variant('Palette 3'))).toBe(true)
    expect(rowMatches(parseQuery('palette 3'), variant('Palette 2'))).toBe(false)
    expect(rowMatches(parseQuery('$3'), variant('Palette 3'))).toBe(true)
  })

  it('a named variant has no id: $1 does not find Luigi, its name does', () => {
    for (const name of ['Mario', 'Luigi', 'Fire Luigi']) {
      expect(rowMatches(parseQuery('$1'), variant(name)), name).toBe(false)
    }
    expect(rowMatches(parseQuery('luigi'), variant('Luigi'))).toBe(true)
  })

  it('an informational row is not searchable', () => {
    expect(paletteSearchRow({ kind: 'note', name: 'Open a project' })).toBeUndefined()
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

  // The filter opened group:music and bank:level under it; the user then folded
  // group:music, which leaves bank:level open below a folded folder. A restore
  // that descends only into currently expanded folders never reaches it.
  it('closes a folder the filter opened below one the user folded afterwards', () => {
    const root = tree(['bank:overworld', 'bank:level'])
    const plan = restorePlan(root, new Set(['bank:overworld']))
    expect(plan.map(p => [p.node.id, p.expand])).toEqual([['bank:level', false]])
    apply(root, plan)
    expect(openIds(root)).toEqual(['bank:overworld'])
  })
})

describe('the displayed id text matches in any base (D79 call 5)', () => {
  it('a palette group matches its CGRAM row in decimal (the tree does not draw it) and a hex-drawn map $105 answers to "105"', () => {
    const palette = paletteSearchRow({ kind: 'group', name: 'Row', row: 12 })!
    const map = mapSlotRow(0x105, 'Somewhere', {})
    expect(rowMatches(parseQuery('12'), palette)).toBe(true)
    expect(rowMatches(parseQuery('105'), map)).toBe(true)
  })

  it('palette variants and groups carry their decimal text', () => {
    expect(
      rowMatches(parseQuery('12'), paletteSearchRow({ kind: 'variant', name: 'Pal 12' })!),
    ).toBe(true)
    expect(
      rowMatches(parseQuery('14'), paletteSearchRow({ kind: 'group', name: 'G', row: 14 })!),
    ).toBe(true)
  })
})

describe('map aliases (D79 call 1)', () => {
  const aliases = { '105': 'Castle Rush', '0A': 'Tiny Hall' }

  it('"rush" finds the aliased map and no other', () => {
    expect(rowMatches(parseQuery('rush'), mapSlotRow(0x105, 'Valley', aliases))).toBe(true)
    expect(rowMatches(parseQuery('rush'), mapSlotRow(0x106, 'Valley', aliases))).toBe(false)
  })

  it('finds a two-digit key on its slot, case-insensitively', () => {
    expect(rowMatches(parseQuery('TINY'), mapSlotRow(0x0a, null, aliases))).toBe(true)
  })

  it('the ROM name still matches, and an alias leaves the id match alone', () => {
    const row = mapSlotRow(0x105, 'Valley', aliases)
    expect(rowMatches(parseQuery('valley'), row)).toBe(true)
    expect(rowMatches(parseQuery('$105'), row)).toBe(true)
  })

  it('a row that is not a slot (index -1) takes no alias', () => {
    expect(mapSlotRow(-1, 'x', { '-1': 'nope', FF: 'nope' }).texts).toEqual(['x'])
  })
})
