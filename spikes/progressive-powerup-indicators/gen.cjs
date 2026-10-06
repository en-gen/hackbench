const fs = require('fs')
const path = require('path')
// Usage: node gen.cjs [assets.json] [out.html]; run probe.ts first.
const { img, win, y0, blocks, plain, two, labels, bg, map } = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, 'assets.json'), 'utf8'))
const W = win[0].length, H = win.length
// [code, title, angle, core px, border px above/left of the core, border px below/right, core colour]
// Weights are SCREEN pixels: constant at every zoom and in the hover state.
const VARIANTS = [
  ['HO', 'HO. Horizontal split; 1px white line, 1px black border each side', 'hor', 1, 1, 1, '#fff'],
  ['HL', 'HL. Horizontal split; 1px white line, 1px black border on the mushroom side only', 'hor', 1, 0, 1, '#fff'],
  ['HD', 'HD. Horizontal split; 1px black line', 'hor', 1, 0, 0, '#000'],
  ['HD2', 'HD2. Horizontal split; 2px black line', 'hor', 2, 0, 0, '#000'],
  ['HH', 'HH. Horizontal split; hard split, no line', 'hor', 0, 0, 0, '#fff'],
  ['VO', 'VO. Vertical split (mushroom left, powerup right); 1px white line, 1px black border each side', 'ver', 1, 1, 1, '#fff'],
  ['VD', 'VD. Vertical split (mushroom left, powerup right); 1px black line', 'ver', 1, 0, 0, '#000'],
  ['VD2', 'VD2. Vertical split (mushroom left, powerup right); 2px black line', 'ver', 2, 0, 0, '#000'],
  ['VH', 'VH. Vertical split (mushroom left, powerup right); hard split, no line', 'ver', 0, 0, 0, '#fff'],
  ['DO', 'DO. Diagonal top-left to bottom-right (powerup top-right); 1px white line, 1px black border each side', 'tlbr', 1, 1, 1, '#fff'],
  ['DH', 'DH. Diagonal top-left to bottom-right (powerup top-right); hard split, no line', 'tlbr', 0, 0, 0, '#fff'],
]
const containsText = (b) => `${labels.mushroom} if Mario is small, otherwise ${labels[b.other]}`
// Both items in one indicator. The mushroom (small-Mario item) sits in the lower half (or triangle) in every variant.
const ind = (small, other) =>
  `<span class="bd"><img class="o" src="${img[other]}"><img class="m" src="${img[small]}"><i class="ln"></i></span>`
const plainInd = (key) => `<span class="bd"><img class="p" src="${img[key]}"></span>`
function block(x, y, tile, inner, text, extra = '') {
  return `<div class="blk${extra}" style="--x:${x};--y:${y}" data-text="${text}"><img class="t0" src="${img['t' + tile]}">${inner}</div>`
}
function scene(code, z) {
  let h = `<div class="scene" data-v="${code}" style="--z:${z}"><div class="cap">${z}x</div><div class="stage">`
  win.forEach((row, y) => row.forEach((id, x) => { if (id !== 0x25) h += `<img class="t" src="${img['t' + id]}" style="--x:${x};--y:${y}">` }))
  for (const b of blocks) h += block(b.x, b.y - y0, b.id, ind(b.small, b.other), `${b.label}: ${containsText(b)}`)
  for (const p of plain) h += block(p.x, p.y - y0, p.id, plainInd(p.key), `${p.label}: ${labels[p.key]}`)
  return h + `</div><div class="msg">&nbsp;</div></div>`
}
// Static detail cells at 6x: at rest and with the hover state forced.
function detail(code) {
  const cells = [blocks[0], blocks[2]].map((b) => [b, ind(b.small, b.other), containsText(b)])
  cells.push([plain[0], plainInd(plain[0].key), labels[plain[0].key]])
  let h = `<div class="detail scene" data-v="${code}" style="--z:6">`
  for (const [b, inner, text] of cells) {
    h += `<figure>${[['at rest', ''], ['hover', ' force']].map(([cap, f]) => `<div class="cell"><div class="stage s1">${block(0, 0, b.id, inner, text, f)}</div><figcaption>${cap}</figcaption></div>`).join('')}<figcaption class="w">${text}</figcaption></figure>`
  }
  return h + '</div>'
}
let body = ''
for (const [code, title, ang, lw, bt, bb, lc] of VARIANTS) {
  body += `<section data-ang="${ang}" style="--lw:${lw};--bt:${bt};--bb:${bb};--lc:${lc}"><h2>${title}</h2><div class="row">${[1, 2, 3].map((z) => scene(code, z)).join('')}</div>${detail(code)}</section>`
}
const props = [
  ...[blocks[0], blocks[2]].map((b) => [`Map16 $${b.id.toString(16)}`, containsText(b)]),
  [`Map16 $${plain[0].id.toString(16)}`, labels[plain[0].key]],
].map(([t, c]) => `<div class="props"><div class="pr"><span>Tile</span><b>${t}</b></div><div class="pr"><span>Contains</span><b>${c}</b></div></div>`).join('')
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Progressive powerup mockup</title>
<style>
body{margin:0;padding:16px 24px 48px;background:#1e1e1e;color:#ccc;font:13px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif}
h1{font-size:15px;margin:0 0 4px}h2{font-size:13px;font-weight:600;margin:28px 0 10px;color:#e7e7e7}
.note{color:#9d9d9d;margin:0 0 8px}
.row{display:flex;gap:24px;align-items:flex-start;overflow-x:auto;padding-bottom:8px}.scene{flex:none;--z:1;--u:calc(16px*var(--z))}
.stage{position:relative;width:calc(${W}*var(--u));height:calc(${H}*var(--u));background:var(--bg);image-rendering:pixelated;outline:1px solid #3c3c3c}
body{--bg:${bg}}body.dark{--bg:#1e1e1e}
.stage img{image-rendering:pixelated;display:block}
.t,.blk{position:absolute;left:calc(var(--x)*var(--u));top:calc(var(--y)*var(--u))}
.t{width:var(--u);height:var(--u)}.blk{width:var(--u);height:var(--u);cursor:pointer}.t0{width:100%;height:100%}
.bd{position:absolute;z-index:5;right:0;bottom:0;width:calc(8px*var(--z));height:calc(8px*var(--z));pointer-events:none;transition:width .1s,height .1s}
.blk:hover .bd,.blk.force .bd{width:var(--u);height:var(--u)}
.bd img{position:absolute;left:0;top:0;width:100%;height:100%}
.bd .o{clip-path:var(--co)}.bd .m{clip-path:var(--cm)}
section{--co:polygon(0 0,100% 0,100% 100%);--cm:polygon(0 0,100% 100%,0 100%);--dir:to top right}
section[data-ang=hor]{--co:polygon(0 0,100% 0,100% 50%,0 50%);--cm:polygon(0 50%,100% 50%,100% 100%,0 100%);--dir:to bottom}
section[data-ang=ver]{--co:polygon(50% 0,100% 0,100% 100%,50% 100%);--cm:polygon(0 0,50% 0,50% 100%,0 100%);--dir:to right}
.ln{display:none;position:absolute;inset:0;--a:calc(50% - var(--lw)*.5px);--b:calc(50% + var(--lw)*.5px);--p:calc(var(--a) - var(--bt)*1px);--q:calc(var(--b) + var(--bb)*1px);background:linear-gradient(var(--dir),transparent var(--p),#000 var(--p),#000 var(--a),var(--lc) var(--a),var(--lc) var(--b),#000 var(--b),#000 var(--q),transparent var(--q))}
section:not([style*="--lw:0"]) .ln{display:block}
.msg{min-height:20px;margin-top:6px;font-size:12px;color:#9cdcfe}.cap{font-size:11px;color:#858585;margin-bottom:4px;height:14px}
.detail{display:flex;gap:28px;margin-top:14px}figure{margin:0}.cell{display:inline-block;margin-right:10px;vertical-align:top}
.s1{width:calc(16px*var(--z));height:calc(16px*var(--z))}.s1 .blk{left:0;top:0}
figcaption{font-size:11px;color:#858585;margin-top:4px}figcaption.w{color:#9cdcfe;max-width:230px}
.props{display:inline-block;margin:8px 18px 0 0;background:#252526;border:1px solid #3c3c3c;padding:6px 10px;min-width:300px}
.pr{display:flex;gap:12px;padding:2px 0}.pr span{width:70px;color:#858585}.pr b{font-weight:400;color:#ccc}
label{margin-left:12px}
</style></head><body>
<h1>Progressive powerup blocks, map ${map}</h1>
<p class="note">Real blocks of map ${map} (flower and feather blocks, from its level data) beside plain blocks added in free cells (1-Up, coin, star, left to right). Hover a block to grow its indicator to the full block. <label><input type="checkbox" id="dk"> dark background instead of the map backdrop</label></p>
<p class="note">Properties panel, Contains row:</p>${props}
${body}
<script>
document.getElementById('dk').addEventListener('change',e=>document.body.classList.toggle('dark',e.target.checked))
document.querySelectorAll('.scene .blk').forEach(b=>b.addEventListener('click',()=>{const m=b.closest('.scene').querySelector('.msg');if(m)m.textContent=b.dataset.text}))
</script></body></html>`
fs.writeFileSync(process.argv[3] || path.join(__dirname, 'mockup.html'), html)
console.log('mockup.html', html.length, 'bytes;', (html.match(/class="blk/g) || []).length, 'block elements')

// ---- #623: two-outcome blocks, one sheet per option, beside the D4 coin, the #607 split and the #615 C4a.
// Same stylesheet and same .bd / clip-path machinery as above; only the compositions below are new.
if (two) {
  const plusSvg = (() => { // C4a "+": 5x5 white cross, 1px black edge, at (9,9) of the 16x16 coin art (multi-coin-indicators/probe.ts plusPx)
    const cross = (x, y) => x >= 0 && x < 5 && y >= 0 && y < 5 && (x === 2 || y === 2)
    let r = ''
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const c = cross(x - 1, y - 1) ? '#fff' : [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => cross(x - 1 + dx, y - 1 + dy)) ? '#000' : null
      if (c) r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`
    }
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="7" height="7" shape-rendering="crispEdges">${r}</svg>`)
  })()
  const S = { star: ['Star', 'invincible'], oneup: ['1-Up', 'the coin counter is zero'] }
  // [Map16 id, number, label, item shown for the state-dependent options (null = not a two-outcome block)]
  const SET = [[0x11c, 'D4 coin'], [0x11f, '#607 split'], [0x11b, 'C4a multi-coin'], [0x11a, 'star or coin', 'star'], [0x122, 'star or coin', 'star'], [0x12d, '1-Up or coin', 'oneup']]
  const strip = (opt, z, force) => {
    let h = `<div class="stage strip" style="--z:${z}">`
    SET.forEach(([id, , item], i) => {
      const inner = item ? opt(item)
        : id === 0x11f ? ind('mushroom', 'flower')
        : id === 0x11b ? `<span class="bd"><img class="p" src="${img.coin}"><img class="pl" src="${plusSvg}"></span>`
        : plainInd('coin')
      h += block(i * 1.5, 0, id, inner, '', force ? ' force' : '') + `<b class="nm" style="--x:${i * 1.5}">${i + 1}</b>`
    })
    return h + '</div>'
  }
  const OPTS = [
    ['A', 'The #607 diagonal: coin bottom-left, star or 1-Up top-right', (it) => ind('coin', it)],
    ['B', 'The coin only; the condition shows only in the Contains row (#565)', () => plainInd('coin')],
    ['C', 'The conditional item only (star or 1-Up)', (it) => plainInd(it)],
    ['D', 'The coin with the item as a half-size badge in its top-right corner, as C4a marks multi-coin in the bottom-right. Reads as a coin with a twist, and cannot be mistaken for the progressive split', (it) => `<span class="bd"><img class="p" src="${img.coin}"><img class="bg" src="${img[it]}"></span>`],
  ]
  const legend = SET.map(([id, n], i) => `${i + 1} $${id.toString(16)} ${n}`).join(' &middot; ')
  const sec = OPTS.map(([c, t, f]) => `<section id="opt${c}" style="--lw:0"><h2>${c}. ${t}</h2><p class="note">${legend}</p>` +
    [1, 2, 3].map((z) => `<div class="zr" style="--z:${z}"><div class="cap">${z}x at rest</div>${strip(f, z, false)}<div class="cap">${z}x hover</div>${strip(f, z, true)}</div>`).join('') + '</section>').join('')
  const css = html.match(/<style>[\s\S]*<\/style>/)[0].replace('</style>', `.strip{width:calc(8.5*var(--u));height:var(--u);margin-bottom:6px;--u:calc(16px*var(--z))}.zr{margin:10px 0 18px;padding:8px;background:var(--bg);display:inline-block;margin-right:20px;vertical-align:top;--z:1}
.nm{position:absolute;left:calc(var(--x)*var(--u));width:var(--u);top:calc(var(--u) + 2px);text-align:center;font:10px sans-serif;color:#fff;text-shadow:0 0 2px #000}
.bd img.pl{left:56.25%;top:56.25%;width:43.75%;height:43.75%}.bd img.bg{left:50%;top:0;width:50%;height:50%}.zr .stage{outline:none;margin-bottom:18px}</style>`)
  const html2 = `<!doctype html><html><head><meta charset="utf-8"><title>Two-outcome indicator mockup</title>${css}</head><body><h1>Two-outcome blocks (#623), map ${map} palette</h1>
<p class="note">Star or coin: $11A at column 0 of 3 and $122 (star if Mario is invincible). 1-Up or coin: $12D (1-Up once its coin counter is zero). Hover fills the whole block.</p>${sec}
<style>body{--bg:${bg}}</style></body></html>`
  fs.writeFileSync(path.join(path.dirname(process.argv[3] || __filename), 'two-outcome.html'), html2)
  console.log('two-outcome.html', html2.length, 'bytes;', (html2.match(/class="blk/g) || []).length, 'block elements')
}
