const fs = require('fs')
const path = require('path')
// Usage: node gen.cjs [assets.json] [out.html]; run probe.ts first.
const assetsPath = process.argv[2] || path.join(__dirname, 'assets.json')
const { img, ITEMS, bg } = JSON.parse(fs.readFileSync(assetsPath, 'utf8'))
const APPROACHES0 = [
  ['A', 'A. Contents at 50% opacity, centered on the block'],
  ['B', 'B. Contents at 50% opacity, shifted up half a tile'],
  ['C', 'C. Icon in the bottom-right quadrant; click for text'],
  ['D', 'D. Half-scale contents thumbnail, bottom-right quadrant'],
  ['D2', 'D2. Full-size contents thumbnail overhanging the bottom-right corner'],
  ['E', 'E. Icon at rest; hover shows A'],
  ['F', 'F. Clean map; click selects and shows B'],
]
const ICON = `<svg class="ic" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 4C5.791 4 4 5.791 4 8C4 10.209 5.791 12 8 12C10.209 12 12 10.209 12 8C12 5.791 10.209 4 8 4ZM7.5 5.5C7.5 5.367 7.553 5.24 7.646 5.146C7.74 5.052 7.867 5 8 5C8.133 5 8.26 5.053 8.354 5.146C8.448 5.24 8.5 5.367 8.5 5.5V8.5C8.5 8.633 8.447 8.76 8.354 8.854C8.261 8.948 8.133 9 8 9C7.867 9 7.74 8.947 7.646 8.854C7.552 8.761 7.5 8.633 7.5 8.5V5.5ZM8 11.125C7.655 11.125 7.375 10.845 7.375 10.5C7.375 10.155 7.655 9.875 8 9.875C8.345 9.875 8.625 10.155 8.625 10.5C8.625 10.845 8.345 11.125 8 11.125Z"/></svg>`
const APPROACHES = [
  ['A', 'A. Contents at 50% opacity, centered on the block'],
  ['D', 'D. Half-scale contents thumbnail, bottom-right quadrant'],
  ['C2', 'C2. Smooth vector icon with the hover outline; click for text'],
  ['E2', 'E2. C2 at rest; hover shows A'],
  ['D3', 'D3. Half-scale contents thumbnail framed with the hover outline'],
  ['D4', 'D4. Half-scale thumbnail, no frame; hover grows it to the block bounds'],
]
const ICON2 = ICON.replace('class="ic"','class="ic2"')
const W = 17, H = 7
// blocks: [x, y, kind, itemIndex]
const blocks = []
ITEMS.forEach((it, i) => blocks.push([1 + i * 2, 3, i % 2 === 0 ? 'q' : 'turn', i]))
blocks.push([15, 3, 'q', 3]) // lower of the stack
blocks.push([15, 2, 'turn', 0]) // upper of the stack, directly above
const NAME = { q: '$11F: ? block', turn: '$117: turn block' }
function scene(code, z) {
  let h = `<div class="scene" data-a="${code}" style="--z:${z}"><div class="cap">${z}x</div><div class="stage">`
  for (let x = 0; x < W; x++) {
    h += `<img class="t" src="${img.grass}" style="--x:${x};--y:5">`
    h += `<img class="t" src="${img.dirt}" style="--x:${x};--y:6">`
  }
  blocks.forEach(([x, y, k, i]) => {
    const it = ITEMS[i]
    h += `<div class="blk" style="--x:${x};--y:${y}" data-text="${NAME[k]}, contains ${it.label}"><img class="t0" src="${img[k]}">`
    const c = `<img class="ct" src="${img[it.key]}">`
    if (code === 'A' || code === 'E2') h += c.replace('ct', 'ct a')
    if (code === 'B' || code === 'F') h += c.replace('ct', 'ct b')
    if (code === 'C2' || code === 'E2') h += `<span class="bd">${ICON2}</span>`
    if (code === 'D3' || code === 'D4') h += `<span class="bd${code === "D4" ? " nf" : ""}"><img class="th" src="${img[it.key]}"></span>`
    if (code === 'D') h += c.replace('ct', 'ct d')
    if (code === 'D2') h += c.replace('ct', 'ct d2')
    h += `</div>`
  })
  h += `</div><div class="msg"></div></div>`
  return h
}
let body = ''
for (const [code, title] of APPROACHES) {
  body += `<section><h2>${title}</h2><div class="row">${[1, 2, 3].map(z => scene(code, z)).join('')}</div></section>`
}
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Block contents mockup</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css">
<style>
body{margin:0;padding:16px 24px 48px;background:#1e1e1e;color:#cccccc;font:13px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif}
h2{font-size:13px;font-weight:600;margin:28px 0 10px;color:#e7e7e7}
.row{display:flex;gap:24px;align-items:flex-start;flex-wrap:nowrap;overflow-x:auto;padding-bottom:8px}.scene{flex:none}
.scene{--z:1;--u:calc(16px*var(--z))}
.stage{position:relative;width:calc(${W}*var(--u));height:calc(${H}*var(--u));background:${bg};overflow:visible;image-rendering:pixelated;outline:1px solid #3c3c3c}
.stage img{image-rendering:pixelated;display:block}
.t,.blk{position:absolute;left:calc(var(--x)*var(--u));top:calc(var(--y)*var(--u))}
.t{width:var(--u);height:var(--u)}
.blk{width:var(--u);height:var(--u);cursor:pointer}
.t0{width:100%;height:100%}
.ct{position:absolute;pointer-events:none;z-index:5;width:var(--u);height:var(--u);left:0;top:0}
.ct.a{opacity:.5}
.ct.b{opacity:.5;top:calc(-8px*var(--z))}
.ct.d{left:auto;top:auto;right:0;bottom:0;width:calc(8px*var(--z));height:calc(8px*var(--z));outline:calc(1px*var(--z)) solid #1e1e1e}
.ct.d2{left:calc(8px*var(--z));top:calc(8px*var(--z))}
.ic{display:block;position:absolute;z-index:5;right:0;bottom:0;width:calc(8px*var(--z));height:calc(8px*var(--z));font-size:calc(8px*var(--z));line-height:calc(8px*var(--z));color:#fff;text-shadow:0 0 1px #000;pointer-events:none}
.scene[data-a=E2] .ct.a{display:none}
.scene[data-a=E2] .blk:hover .ct.a{display:block}
.bd{position:absolute;z-index:5;right:0;bottom:0;width:calc(8px*var(--z));height:calc(8px*var(--z));pointer-events:none}
.bd::after{content:"";position:absolute;inset:0;box-sizing:border-box;border:1px solid #000;box-shadow:inset 0 0 0 1px #fff;pointer-events:none}
.bd .ic2{position:absolute;left:0;top:0;width:100%;height:100%;color:#fff;image-rendering:auto;shape-rendering:geometricPrecision;text-shadow:none}
.scene[data-a=D4] .bd{transition:width .1s,height .1s}
.scene[data-a=D4] .blk:hover .bd{width:var(--u);height:var(--u)}
.bd.nf::after{display:none}
.bd .th{position:absolute;left:0;top:0;width:100%;height:100%;image-rendering:pixelated}
.scene[data-a=F] .ct.b{display:none}
.scene[data-a=F] .blk.sel .ct.b{display:block}
.scene[data-a=F] .blk.sel{outline:1px solid #007fd4}
.msg{min-height:20px;margin-top:6px;font-size:12px;color:#9cdcfe}
.cap{font-size:11px;color:#858585;margin-bottom:4px;height:14px}
</style></head><body>${body}
<script>
document.querySelectorAll('.scene').forEach(s=>{
  const a=s.dataset.a,m=s.querySelector('.msg')
  s.querySelectorAll('.blk').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation()
    if(a==='C2')m.textContent=b.dataset.text
    if(a==='F'){const was=b.classList.contains('sel');s.querySelectorAll('.blk').forEach(x=>x.classList.remove('sel'));if(!was)b.classList.add('sel')}
  }))
  if(a==='F')document.addEventListener('click',()=>s.querySelectorAll('.blk').forEach(x=>x.classList.remove('sel')))
})
</script></body></html>`
fs.writeFileSync(process.argv[3] || path.join(__dirname, 'mockup.html'), html)
console.log(html.length)
