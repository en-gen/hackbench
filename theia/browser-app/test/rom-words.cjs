const fs = require('fs')

const CART = /cartridge|\bcarts?\b/i

async function shownWords(page, selector) {
  return page.evaluate(s => {
    const root = document.querySelector(s)
    const attrs = [...root.querySelectorAll('[title],[aria-label]')].map(
      el => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`,
    )
    return [root.textContent, ...attrs].join(' ')
  }, selector)
}

/**
 * Point a manifest at an untitled ROM this machine has never seen: the one
 * state that shows the fallback wording instead of the ROM's header title.
 */
function makeUntitledAndUnlocated(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = ''
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

module.exports = { CART, shownWords, makeUntitledAndUnlocated }
