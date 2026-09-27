/** Same expansion PaletteColorFormat.bgr555HexToCssHex uses: 5-bit -> 8-bit, exact for a value that came from bgr555ToRgba. */
function bgr555ToRgbTriplet(word) {
  const r5 = word & 0x1f
  const g5 = (word >> 5) & 0x1f
  const b5 = (word >> 10) & 0x1f
  const expand = c5 => (c5 << 3) | (c5 >> 2)
  return [expand(r5), expand(g5), expand(b5)]
}

function parseRgbTriplet(cssColor) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(cssColor)
  if (!m) throw new Error(`not an rgb() color: ${cssColor}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** WCAG contrast ratio between two [r, g, b] colors. */
function contrastRatio(a, b) {
  const lum = rgb =>
    rgb
      .map(c => c / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i] * c, 0)
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

module.exports = { bgr555ToRgbTriplet, parseRgbTriplet, contrastRatio }
