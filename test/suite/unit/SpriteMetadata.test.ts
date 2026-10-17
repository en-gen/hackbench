import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SPRITE_METADATA,
  SCROLL_COMMANDS,
  getSpriteMetadata,
  type SpriteMetadata,
} from '../../../src/rom/model/sprites/SpriteMetadata'
import { Sprite } from '../../../src/rom/model/sprites/Sprite'
import type { SpriteBehavior } from '../../../src/rom/model/sprites/SpriteBehavior'
import { StaticSpriteAppearance } from '../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { serializeSprite } from '../../../src/rom/model/serialize'
import { buildSprite } from '../../../src/rom/model/rehydrate'
import type { Char } from '../../../src/rom/model/chars/Char'
import { makeTransparentPlaceholderChar } from '../../../src/rom/model/tiles/TileFactory'

describe('getSpriteMetadata', () => {
  it('returns Lakitu displayName without spawns/isGenerator', () => {
    const m = getSpriteMetadata(0x1e)
    expect(m?.displayName).toBe('Lakitu')
    expect(m?.spawns).toBeUndefined()
    expect(m?.isGenerator).toBeUndefined()
  })

  it('0xC9 is the Bullet Bill shooter, 0xCA the Torpedo Ted launcher (shooters, ShooterNumber = id - $C8)', () => {
    expect(getSpriteMetadata(0xc9)).toMatchObject({
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
    })
    expect(getSpriteMetadata(0xca)).toMatchObject({
      displayName: 'Torpedo Ted Launcher',
      spawns: 0x44,
    })
  })

  it('0xCE picks Para-Goomba or Para-Bomb at random, so it has no single spawn', () => {
    expect(getSpriteMetadata(0xce)?.spawns).toBeUndefined()
  })

  it('defines every id up to 0xFF', () => {
    for (let id = 0; id <= 0xff; id++) expect(getSpriteMetadata(id), `id ${id}`).toBeDefined()
  })

  it('returns display name for common sprite IDs', () => {
    expect(getSpriteMetadata(0x00)?.displayName).toBe('Green Koopa (no shell)')
    expect(getSpriteMetadata(0x0f)?.displayName).toBe('Goomba')
    expect(getSpriteMetadata(0x26)?.displayName).toBe('Thwomp')
  })

  it.each([
    [0xc9, 0x1c],
    [0xcb, 0x38],
    [0xcc, 0x3f],
    [0xcd, 0x40],
    [0xcf, 0x41],
    [0xd0, 0x41],
    [0xd1, 0x17],
    [0xd3, 0x71],
    [0xd4, 0x9d],
    [0xd5, 0x1c],
    [0xd6, 0x1c],
    [0xd7, 0x1c],
    [0xd8, 0xb3],
    [0xde, 0x39],
    [0xe0, 0xa3],
  ])('sprite 0x%s spawns 0x%s', (id, spawns) => {
    expect(getSpriteMetadata(id)?.spawns).toBe(spawns)
  })
})

// A table entry in 0xC9..0xFF is only as good as its citation (#985): the
// names there were wrong once because nothing tied them to the disassembly.
// Form: 'bank_02.asm:6861 (in LaunchTorpedo, 6835)' = cited line, the label
// enclosing it, that label's own line.
const SOURCE_RE = /^(bank_0[0-9A-F]\.asm):(\d+) \(in (\w+), (\d+)\)$/
const CITED_IDS = Array.from({ length: 0xff - 0xc9 + 1 }, (_, i) => 0xc9 + i)

type Table = Readonly<Record<number, Readonly<SpriteMetadata>>>

/** Ids in C9..FF whose citation is missing or malformed; `visited` counts the ids examined. */
function uncitedIds(table: Table, visited: number[] = []): number[] {
  const bad: number[] = []
  for (const id of CITED_IDS) {
    visited.push(id)
    const src = table[id]?.source
    if (src === undefined || !SOURCE_RE.test(src)) bad.push(id)
  }
  return bad
}

describe('0xC9..0xFF carry a SMWDisX citation', () => {
  it('visits all 55 ids and finds none uncited', () => {
    const visited: number[] = []
    expect(uncitedIds(SPRITE_METADATA, visited)).toEqual([])
    expect(visited).toHaveLength(55)
    expect(new Set(visited).size).toBe(55)
  })

  it('fails on a table with one source removed', () => {
    const planted = { ...SPRITE_METADATA, 0xd8: { ...SPRITE_METADATA[0xd8], source: undefined } }
    expect(uncitedIds(planted)).toEqual([0xd8])
  })

  it('fails on a malformed source, including the old label-only form', () => {
    const planted = { ...SPRITE_METADATA, 0xe9: { ...SPRITE_METADATA[0xe9], source: 'bank_05' } }
    expect(uncitedIds(planted)).toEqual([0xe9])
    const old = {
      ...SPRITE_METADATA,
      0xca: { ...SPRITE_METADATA[0xca], source: 'bank_02.asm:6861 LaunchTorpedo' },
    }
    expect(uncitedIds(old)).toEqual([0xca])
  })
})

describe('generator flags (C9/CA are shooters, a separate system: bank_02.asm:5744, 6809)', () => {
  it('CB..D8 with a spawn are generators; C9 and CA are not', () => {
    for (let id = 0xcb; id <= 0xd8; id++) {
      if (SPRITE_METADATA[id].spawns !== undefined)
        expect(SPRITE_METADATA[id].isGenerator, `id ${id}`).toBe(true)
    }
    expect(SPRITE_METADATA[0xc9].isGenerator).toBeUndefined()
    expect(SPRITE_METADATA[0xca].isGenerator).toBeUndefined()
  })

  it('pins names that carry a direction or kind', () => {
    expect(SPRITE_METADATA[0xd5].displayName).toBe('Bullet Bill Generator')
    expect(SPRITE_METADATA[0xe2].displayName).toBe('Boo Ring (angle step +1)')
    expect(SPRITE_METADATA[0xe3].displayName).toBe('Boo Ring (angle step -1)')
    expect(SPRITE_METADATA[0xd2].displayName).toContain('stops respawns')
  })
})

describe('scroll commands E7..FF', () => {
  it('the table has the 15 entries of bank_05.asm:4583-4597', () => {
    expect(SCROLL_COMMANDS).toHaveLength(15)
  })

  it('names every command by its table position', () => {
    for (let cmd = 0; cmd < 15; cmd++) {
      expect(SPRITE_METADATA[0xe7 + cmd].displayName).toBe(
        `Scroll command ${cmd}: ${SCROLL_COMMANDS[cmd]}`,
      )
      expect(SPRITE_METADATA[0xe7 + cmd].source).toContain(`bank_05.asm:${4583 + cmd} `)
    }
  })

  it('F6..FF say the result is undefined', () => {
    for (let id = 0xf6; id <= 0xff; id++) {
      expect(SPRITE_METADATA[id].displayName).toBe(
        `Scroll command ${id - 0xe7}: undefined, past the end of the table (the game jumps into code bytes)`,
      )
    }
  })
})

describe('Koopa shell ids name the Special World swap (bank_02.asm:5464-5471)', () => {
  it.each([
    [0xda, 'Green Koopa Shell (yellow after Special World)'],
    [0xdb, 'Red Koopa Shell (blue after Special World)'],
    [0xdc, 'Blue Koopa Shell'],
    [0xdd, 'Yellow Koopa Shell'],
  ])('0x%s', (id, name) => expect(SPRITE_METADATA[id].displayName).toBe(name))
})

// The citations are checked against the disassembly itself. SMWDisX is a
// separate checkout (not in CI), so this skips without it: HACKBENCH_SMWDISX,
// else a sibling `SMWDisX` folder found by walking up from here.
function findSmwdisx(): string | undefined {
  const env = process.env.HACKBENCH_SMWDISX
  // A set variable is authoritative, so pointing it nowhere forces the skip.
  if (env !== undefined) return fs.existsSync(path.join(env, 'bank_02.asm')) ? env : undefined
  let dir = __dirname
  for (;;) {
    const cand = path.join(dir, 'SMWDisX')
    if (fs.existsSync(path.join(cand, 'bank_02.asm'))) return cand
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}
const smwdisx = findSmwdisx()

describe.skipIf(!smwdisx)('0xC9..0xFF citations match the disassembly', () => {
  const files = new Map<string, string[]>()
  const bank = (name: string): string[] => {
    let l = files.get(name)
    if (!l) files.set(name, (l = fs.readFileSync(path.join(smwdisx!, name), 'utf8').split(/\r?\n/)))
    return l
  }
  // Mirrors the label rule the citations were built with: a column-0 name and colon.
  const labelAt = (lines: string[], line: number) =>
    /^([A-Za-z_]\w*):/.exec(lines[line - 1] ?? '')?.[1]

  /** Problems with one citation; empty when the label, enclosure and spawn byte all check out. */
  function problems(id: number, entry: Readonly<SpriteMetadata>): string[] {
    const m = SOURCE_RE.exec(entry.source ?? '')
    if (!m) return [`${id}: malformed`]
    const [, file, lineS, label, labelLineS] = m
    const lines = bank(file)
    const line = Number(lineS)
    const labelLine = Number(labelLineS)
    const out: string[] = []
    if (labelAt(lines, labelLine) !== label)
      out.push(`${id}: ${label} is not defined at ${labelLine}`)
    if (!(labelLine <= line)) out.push(`${id}: line ${line} is before its label`)
    for (let i = labelLine + 1; i <= line; i++) {
      if (labelAt(lines, i) !== undefined) {
        out.push(`${id}: line ${line} is past the next label ${labelAt(lines, i)} at ${i}`)
        break
      }
    }
    if (entry.spawns !== undefined) {
      const hex = entry.spawns.toString(16).toUpperCase().padStart(2, '0')
      if (!new RegExp(String.raw`\$${hex}\b`).test(lines[line - 1] ?? ''))
        out.push(`${id}: line ${line} lacks $${hex}`)
    }
    return out
  }

  it('every cited label, enclosure and spawn byte checks out (55 ids visited)', () => {
    const all: string[] = []
    for (const id of CITED_IDS) all.push(...problems(id, SPRITE_METADATA[id]))
    expect(all).toEqual([])
  })

  it('goes red on planted line, label and spawn defects', () => {
    const e = SPRITE_METADATA[0xd5]
    expect(
      problems(0xd5, { ...e, source: 'bank_02.asm:99999 (in GenerateBullet, 6385)' }),
    ).not.toEqual([])
    expect(problems(0xd5, { ...e, source: 'bank_02.asm:6396 (in Nonsense, 6385)' })).not.toEqual([])
    expect(problems(0xd5, { ...e, spawns: 0x1d })).not.toEqual([])
    // 6468 sits in CODE_02B115, not in the generator it was once filed under
    expect(
      problems(0xd6, {
        ...SPRITE_METADATA[0xd6],
        source: 'bank_02.asm:6468 (in GenerateBullet, 6385)',
      }),
    ).not.toEqual([])
  })
})

describe('SpriteBehavior serialize/rehydrate round-trip', () => {
  const placeholder = makeTransparentPlaceholderChar()
  const chars = new Map<number, Char>()

  function roundTrip(behavior: SpriteBehavior) {
    const sprite = new Sprite(0xd3, 16, 32, new StaticSpriteAppearance([]), behavior)
    const desc = serializeSprite(sprite)
    const rehydrated = buildSprite(desc, chars, placeholder)
    return { desc, rehydrated }
  }

  it('preserves all metadata fields through serialize → rehydrate', () => {
    const { desc, rehydrated } = roundTrip({
      kind: 'sprite_d3',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
    expect(desc.behavior).toEqual({
      kind: 'sprite_d3',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
    expect(rehydrated.behavior).toEqual({
      kind: 'sprite_d3',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
  })

  it('omits optional keys from the descriptor when source behavior lacks them', () => {
    const { desc, rehydrated } = roundTrip({ kind: 'sprite_00' })
    expect(Object.keys(desc.behavior)).toEqual(['kind'])
    expect(rehydrated.behavior.kind).toBe('sprite_00')
    expect(rehydrated.behavior.displayName).toBeUndefined()
    expect(rehydrated.behavior.spawns).toBeUndefined()
    expect(rehydrated.behavior.isGenerator).toBeUndefined()
  })

  it('survives a JSON.parse(JSON.stringify) trip (postMessage safe)', () => {
    const sprite = new Sprite(0xc9, 0, 0, new StaticSpriteAppearance([]), {
      kind: 'sprite_c9',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
    const desc = serializeSprite(sprite)
    const wireFormat = JSON.parse(JSON.stringify(desc))
    const rehydrated = buildSprite(wireFormat, chars, placeholder)
    expect(rehydrated.behavior).toEqual({
      kind: 'sprite_c9',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
  })
})
