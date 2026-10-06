const fs = require('fs')
const path = require('path')
// Usage: node gen.cjs [assets.json] [out.html]; run probe.ts first.
const A = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, 'assets.json'), 'utf8'))
const { img, win, x0, y0, blocks, added, cands, bg, map, mapName } = A
const W = win[0].length, H = win.length
const hex = (n) => n.toString(16)
const SINGLE_TEXT = 'Coin'
const MULTI_TEXT = 'Coins until the timer runs out'
// Every block holds an indicator: the plain coin for single-coin blocks, the candidate for multi-coin blocks.
const ind = (key) => `<span class="bd"><img src="${img[key]}">${key === 'C4b' ? `<img class="pl" src="${img.plus7}">` : ''}</span>`
function block(x, y, b, key, extra = '') {
  const text = `Map16 $${hex(b.id)}${b.label ? ' at ' + b.label.split(' at ')[1] : ''}: ${b.kind === 'multi' ? MULTI_TEXT : SINGLE_TEXT}`
  return `<div class="blk${extra}" style="--x:${x};--y:${y}" data-text="${text}"><img class="t0" src="${img['t' + b.id]}">${ind(key)}</div>`
}
const keyOf = (b, cand) => (b.kind === 'multi' ? cand : 'coin')
function scene(cand, z) {
  let h = `<div class="scene" style="--z:${z}"><div class="cap">${z}x</div><div class="stage">`
  win.forEach((row, y) => row.forEach((id, x) => { if (id !== 0x25) h += `<img class="t" src="${img['t' + id]}" style="--x:${x};--y:${y}">` }))
  for (const b of [...blocks, ...added]) h += block(b.x - x0, b.y - y0, b, keyOf(b, cand))
  return h + `</div><div class="msg">&nbsp;</div></div>`
}
// one block alone, at rest and with the hover state forced
const ID = { s1: 0x11c, m1: 0x11b, s2: 0x124, m2: 0x123 }
const cell = (z, id, kind, key, cap) => {
  const b = { id, kind }
  return `<div class="cell"><div class="stage s1" style="--z:${z}">${block(0, 0, b, key, cap === 'hover' ? ' force' : '')}</div><figcaption>${cap}</figcaption></div>`
}
function detail(cand, z) {
  const fig = (label, id, kind) =>
    `<figure>${cell(z, id, kind, keyOf({ kind }, cand), 'at rest')}${cell(z, id, kind, keyOf({ kind }, cand), 'hover')}<figcaption class="w">${label}</figcaption></figure>`
  return `<div class="detail"><div class="cap">${z}x</div><div class="figs">` +
    fig(`single coin $${hex(ID.s1)} (D4)`, ID.s1, 'single') + fig(`multi-coin $${hex(ID.m1)}`, ID.m1, 'multi') +
    fig(`single coin $${hex(ID.s2)} (D4)`, ID.s2, 'single') + fig(`multi-coin $${hex(ID.m2)}`, ID.m2, 'multi') +
    `</div></div>`
}
let body = ''
for (const [code, name] of Object.entries(cands)) {
  body += `<section><h2>${code}. ${name}</h2><div class="row">${[1, 2, 3].map((z) => scene(code, z)).join('')}</div>${[4, 8].map((z) => detail(code, z)).join('')}</section>`
}
// all candidates side by side on the same block, so the choice is one glance
function compare(z) {
  const col = (label, key, kind) => `<figure>${cell(z, ID.m1, kind, key, 'at rest')}${cell(z, ID.m1, kind, key, 'hover')}<figcaption class="w">${label}</figcaption></figure>`
  return `<div class="detail"><div class="cap">${z}x</div><div class="figs">${col('single coin (D4)', 'coin', 'single')}${Object.entries(cands).map(([c, n]) => col(`${c}. ${n}`, c, 'multi')).join('')}</div></div>`
}
const props = [['Map16 $' + hex(ID.s1), SINGLE_TEXT], ['Map16 $' + hex(ID.m1), MULTI_TEXT], ['Map16 $' + hex(ID.m2), MULTI_TEXT]]
  .map(([t, c]) => `<div class="props"><div class="pr"><span>Tile</span><b>${t}</b></div><div class="pr"><span>Contains</span><b>${c}</b></div></div>`).join('')
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Multiple-coin indicator mockup</title>
<style>
body{margin:0;padding:16px 24px 48px;background:#1e1e1e;color:#ccc;font:13px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif}
h1{font-size:15px;margin:0 0 4px}h2{font-size:13px;font-weight:600;margin:28px 0 10px;color:#e7e7e7}
.note{color:#9d9d9d;margin:0 0 8px;max-width:900px}
.row{display:flex;gap:24px;align-items:flex-start;overflow-x:auto;padding-bottom:8px}.scene{flex:none;--z:1;--u:calc(16px*var(--z))}
.stage{position:relative;width:calc(${W}*var(--u));height:calc(${H}*var(--u));background:var(--bg);image-rendering:pixelated;outline:1px solid #3c3c3c;--u:calc(16px*var(--z))}
body{--bg:${bg}}body.dark{--bg:#1e1e1e}
.stage img{image-rendering:pixelated;display:block}
.t,.blk{position:absolute;left:calc(var(--x)*var(--u));top:calc(var(--y)*var(--u))}
.t{width:var(--u);height:var(--u)}.blk{width:var(--u);height:var(--u);cursor:pointer}.t0{width:100%;height:100%}
.bd{position:absolute;z-index:5;right:0;bottom:0;width:calc(8px*var(--z));height:calc(8px*var(--z));pointer-events:none;transition:width .1s,height .1s}
.blk:hover .bd,.blk.force .bd{width:var(--u);height:var(--u)}
.bd img{position:absolute;left:0;top:0;width:100%;height:100%}
.bd img.pl{left:auto;top:auto;right:0;bottom:0;width:7px;height:7px}
.msg{min-height:20px;margin-top:6px;font-size:12px;color:#9cdcfe}.cap{font-size:11px;color:#858585;margin-bottom:4px;height:14px}
.detail{margin-top:14px}.figs{display:flex;gap:28px;flex-wrap:wrap}figure{margin:0}.cell{display:inline-block;margin-right:10px;vertical-align:top}
.s1{width:var(--u);height:var(--u);outline:none}.s1 .blk{left:0;top:0}
figcaption{font-size:11px;color:#858585;margin-top:4px}figcaption.w{color:#9cdcfe;max-width:260px}
.props{display:inline-block;margin:8px 18px 0 0;background:#252526;border:1px solid #3c3c3c;padding:6px 10px;min-width:300px}
.pr{display:flex;gap:12px;padding:2px 0}.pr span{width:70px;color:#858585}.pr b{font-weight:400;color:#ccc}
label{margin-left:12px}
</style></head><body>
<h1>Multiple-coin blocks, map ${map} (${mapName})</h1>
<p class="note">A multiple-coin block pays one coin per hit until a timer runs out, so there is no count and no numeral. Each candidate is the D4 indicator (half scale in the bottom-right quadrant, full block on hover, no outline). The map shows a real multiple-coin block ($11b at column 77, row 20) and two real single-coin blocks ($11c); the question-style pair $123 (multi) and $124 (single) is added in free cells of row 20 because this map holds none in the window. Hover a block to grow its indicator to the full block; click it for its text. <label><input type="checkbox" id="dk"> dark background instead of the map backdrop</label></p>
<p class="note">The single and multiple-coin tiles share their graphic cell for cell ($11b = $11c, $123 = $124), so without an indicator the two cannot be told apart.</p>
<p class="note">Properties panel, Contains row:</p>${props}
<section><h2>All candidates on the same block ($${hex(ID.m1)})</h2>${[2, 4, 8].map(compare).join('')}</section>
${body}
<script>
document.getElementById('dk').addEventListener('change',e=>document.body.classList.toggle('dark',e.target.checked))
document.querySelectorAll('.scene .blk').forEach(b=>b.addEventListener('click',()=>{const m=b.closest('.scene').querySelector('.msg');if(m)m.textContent=b.dataset.text}))
</script></body></html>`
fs.writeFileSync(process.argv[3] || path.join(__dirname, 'mockup.html'), html)
console.log('mockup.html', html.length, 'bytes;', (html.match(/class="blk/g) || []).length, 'block elements')
