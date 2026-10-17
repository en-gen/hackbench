// #825 SPIKE driver: serves bench.html + fixtures (ROM-derived, kept OUTSIDE the repo) and runs each arm
// 3 times per map in a fresh page of headless Chromium. Usage: node run.cjs <fixturesDir> <playwrightModuleDir>
const http = require('http')
const fs = require('fs')
const path = require('path')
const [fixArg, pwArg] = process.argv.slice(2)
const fixDir = path.resolve(fixArg)
const pwDir = path.resolve(pwArg)
if (!fs.statSync(fixDir, { throwIfNoEntry: false })?.isDirectory())
  throw new Error(`not a directory: ${fixDir}`)
// True when `f`, resolved against `root`, stays inside it (no '..' escape, not absolute elsewhere).
const inside = (root, f) => {
  const rel = path.relative(root, f)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}
// The widget's own composeScreen, bundled once into the (out-of-repo) fixtures dir.
require(path.join(pwDir, '..', 'esbuild')).buildSync({
  entryPoints: [path.join(__dirname, '..', 'compose-entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'CM',
  outfile: path.join(fixDir, 'compose.js'),
})
const { chromium } = require(pwDir)
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  // Allowlist: the page, its script, the bundle and the per-map fixtures; nothing else is served.
  const fix = /^\/fix\/(map-[0-9a-f]{1,3}\.json)$/.exec(u)
  const [root, name] = fix
    ? [fixDir, fix[1]]
    : u === '/compose.js'
      ? [fixDir, 'compose.js']
      : ['/bench.html', '/bench.js'].includes(u)
        ? [__dirname, u.slice(1)]
        : [null, null]
  const f = root && path.resolve(root, name)
  if (!f || !inside(root, f)) return void res.writeHead(403).end()
  fs.readFile(f, (e, b) => {
    if (e) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : f.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(b) // prettier-ignore
  })
})
const range = a => `${Math.min(...a).toFixed(1)}-${Math.max(...a).toFixed(1)}`
;(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const browser = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc', '--enable-precise-memory-info', '--enable-unsafe-swiftshader'] }) // prettier-ignore
  const out = {}
  for (const map of ['10a', '105', '101'])
    for (let run = 0; run < 3; run++)
      for (const arm of ['A', 'B', 'C']) {
        const page = await browser.newPage({ viewport: { width: 768, height: 432 } })
        await page.goto(`http://127.0.0.1:${port}/bench.html?map=${map}&arm=${arm}`)
        await page.waitForFunction('window.__result', null, { timeout: 120000 })
        const r = await page.evaluate('window.__result')
        await page.close()
        if (r.error) throw new Error(`${map} ${arm}: ${r.error}`)
        ;(out[`${map}/${arm}`] ??= []).push(r)
      }
  await browser.close()
  server.close()
  const col = (rs, f) => range(rs.map(f))
  console.log(
    'map/arm  firstPaint4  perScreenMainMs(p50|p95)  workerMs  paletteEdit4  scrollMs(p50|p95|max)  e2eMs(p50|p95)  composeMsMainA  canvasMB  gl',
  )
  for (const [k, rs] of Object.entries(out))
    console.log(
      k,
      '|',
      col(rs, r => r.firstPaintMs),
      '|',
      col(rs, r => r.dec.p50),
      col(rs, r => r.dec.p95),
      '|',
      rs[0].workerMs.length
        ? col(rs, r => r.workerMs.reduce((t, v) => t + v, 0) / r.workerMs.length)
        : '-',
      '|',
      rs[0].paletteEditMs ? col(rs, r => r.paletteEditMs) : '-',
      '|',
      col(rs, r => r.scroll.p50),
      col(rs, r => r.scroll.p95),
      col(rs, r => r.scroll.max),
      '|',
      col(rs, r => r.e2e.p50),
      col(rs, r => r.e2e.p95),
      '|',
      rs[0].composeMs.length
        ? col(rs, r => r.composeMs.reduce((t, v) => t + v, 0) / r.composeMs.length)
        : '-',
      '|',
      (rs[0].canvasBytes / 1048576).toFixed(1),
      '|',
      rs[0].gl, // prettier-ignore
    )
  fs.writeFileSync(path.join(fixDir, 'results.json'), JSON.stringify(out))
})()
