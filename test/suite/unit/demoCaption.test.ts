import * as vm from 'vm'
import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { OVERLAY } = require('../../../theia/browser-app/test/demo.cjs') as { OVERLAY: string }

interface FakeEl {
  tag: string
  style: { cssText: string }
  children: FakeEl[]
  text: string
  id?: string
  appendChild(c: FakeEl): void
  textContent: string
}

describe('demo.cjs caption overlay', () => {
  it('renders markup-like text as text: no element is parsed, innerHTML is never assigned', () => {
    const created: FakeEl[] = []
    const innerHTMLWrites: string[] = []
    const makeEl = (tag: string): FakeEl => {
      const el = {
        tag,
        style: { cssText: '' },
        children: [] as FakeEl[],
        text: '',
        appendChild(c: FakeEl) {
          this.children.push(c)
        },
        get textContent() {
          return this.text
        },
        set textContent(v: string) {
          this.text = v
          this.children = []
        },
      } as FakeEl
      Object.defineProperty(el, 'innerHTML', { set: (v: string) => innerHTMLWrites.push(v) })
      created.push(el)
      return el
    }
    const win: { __caption?: (t: string, d: string, v?: string) => void } = {}
    const body = makeEl('body')
    vm.runInNewContext(OVERLAY, { window: win, document: { createElement: makeEl, body } })

    const evil = '<img src=x onerror=alert(1)>'
    win.__caption?.(evil, 'detail', evil)

    const overlay = body.children[0]
    expect(innerHTMLWrites).toEqual([])
    expect(created.some(e => e.tag === 'img')).toBe(false)
    expect(overlay.children.map(c => c.text)).toEqual([evil, 'detail', evil])
  })
})
