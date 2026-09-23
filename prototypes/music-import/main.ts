// Throwaway harness. The portable parts live in src/rom/nspc/; this file only wires them to a page.
import { scanRom, ScanResult, ScannedSong } from '../../src/rom/nspc/SourceScan'
import { exportSong } from '../../src/rom/nspc/AmkExport'
import { buildSnapshot, defaultCommandPort } from '../../src/rom/nspc/SpcSnapshot'
import { spcPlayback } from '../../theia/extension/src/browser/spc-playback'
import { zip } from './zip'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const hex = (n: number, w = 2) => '$' + n.toString(16).toUpperCase().padStart(w, '0')
const esc = (s: string) =>
  s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

let scan: ScanResult | null = null
let romName = ''
let selected: ScannedSong | null = null
let playing: ScannedSong | null = null
let portOverride: number | null = null

$('file').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadRom(f.name, new Uint8Array(await f.arrayBuffer()))
})

// Test hook: load a ROM served by the dev server (HB_TEST_ROMS), for automated checks.
;(window as unknown as { loadRomFromUrl: (u: string) => Promise<void> }).loadRomFromUrl = async (
  url: string,
) =>
  loadRom(
    decodeURIComponent(url.split('/').pop()!),
    new Uint8Array(await (await fetch(url)).arrayBuffer()),
  )

// Test hook: automated checks turn playback down to inaudible and measure the signal instead.
;(window as unknown as { hbSetVolume: (v: number) => void }).hbSetVolume = (v: number) =>
  spcPlayback.setVolume(v)

function loadRom(fileName: string, bytes: Uint8Array) {
  spcPlayback.stop()
  playing = null
  romName = fileName.replace(/\.[^.]+$/, '')
  const t0 = performance.now()
  scan = scanRom(bytes)
  const ms = Math.round(performance.now() - t0)
  selected = scan.songs[0] ?? null
  portOverride = null
  if (scan.images[0])
    ($('port') as HTMLSelectElement).value = String(defaultCommandPort(scan.images[0]))
  renderHeader(ms)
  render()
}

$('port').addEventListener('change', e => {
  portOverride = Number((e.target as HTMLSelectElement).value)
})

function renderHeader(ms: number) {
  if (!scan) return
  const h = scan.header
  const layout = h.ok
    ? `<span class="pill ok">${h.best.layout}</span> ${esc(h.best.title)}`
    : `<span class="pill err">layout unknown</span>`
  const engine = scan.images[0]
    ? `<span class="pill ok">N-SPC ${scan.images[0].engine.dialect}</span>`
    : `<span class="pill err">no supported driver</span>`
  $('romInfo').innerHTML =
    `${layout} ${engine} <span class="muted">${scan.chains.length} uploads, ${scan.songs.length} songs, ${ms} ms</span>`
}

function render() {
  if (!scan) return
  const groups = new Map<string, ScannedSong[]>()
  for (const s of scan.songs) groups.set(s.image.label, [...(groups.get(s.image.label) ?? []), s])
  $('songs').innerHTML =
    [...groups]
      .map(
        ([label, songs]) =>
          `<h3>${esc(label)}</h3>` +
          songs
            .map(s => {
              const i = scan!.songs.indexOf(s)
              const secs = s.song.order.length
              return `<div class="song ${s === selected ? 'sel' : ''}" data-i="${i}">
                <button class="play ${s === playing ? 'on' : ''}" data-play="${i}" title="${s === playing ? 'Stop' : 'Play the original'}">${s === playing ? '&#9632;' : '&#9654;'}</button>
                <span class="mono muted">${hex(s.command)}</span>
                <span>Song ${s.command}</span>
                <span class="muted">${secs} sec${s.song.loopIndex === null ? '' : ', loops'}</span></div>`
            })
            .join(''),
      )
      .join('') +
    (scan.unavailable.length
      ? `<h3>Unavailable</h3>` +
        scan.unavailable
          .map(
            u =>
              `<div class="song"><span></span><span class="mono muted">${hex(u.command)}</span><span class="muted" title="${esc(u.reason)}">${esc(u.image.label)}</span><span></span></div>`,
          )
          .join('')
      : '')

  const problems = scan.problems.map(p => `<div class="notice err">${esc(p)}</div>`).join('')
  if (!selected) {
    $('detail').innerHTML = problems || '<div class="muted">No songs found.</div>'
    return
  }
  const s = selected
  const e = s.image.engine
  const ex = exportSong(s.image, s.song, {
    folder: romName,
    title: `Song ${s.command}`,
    game: scan.header.ok ? scan.header.best.title : romName,
  })
  $('detail').innerHTML = `
    ${problems}
    <div class="row">
      <button data-play="${scan.songs.indexOf(s)}">${s === playing ? 'Stop' : 'Play original'}</button>
      <button class="secondary" id="export">Export for AddmusicK (.zip)</button>
      <span class="muted">Samples ${(ex.sampleBytes / 1024).toFixed(1)} KB, ${ex.samples.length} files</span>
    </div>
    <div><h2>Driver</h2><dl>
      <dt>Dialect</dt><dd>${e.dialect}</dd>
      <dt>Song table</dt><dd class="mono">${hex(e.songTable, 4)}</dd>
      <dt>Instruments</dt><dd class="mono">${hex(e.instrTable, 4)} x ${e.instrWidth}</dd>
      <dt>Sample dir</dt><dd class="mono">${hex(e.dir, 4)}</dd>
      <dt>Entry</dt><dd class="mono">${hex(s.image.entry, 4)}</dd>
    </dl></div>
    ${ex.warnings.length ? `<div><h2>Conversion notes</h2><ul class="warns">${ex.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div><h2>AddmusicK MML</h2><pre>${esc(ex.mml)}</pre></div>`
  $('export').onclick = () => download(s)
}

document.addEventListener('click', async ev => {
  const t = ev.target as HTMLElement
  const p = t.closest<HTMLElement>('[data-play]')
  if (p && scan) {
    const s = scan.songs[Number(p.dataset.play)]
    if (playing === s) {
      spcPlayback.stop()
      playing = null
    } else {
      const port = portOverride ?? defaultCommandPort(s.image)
      const snap = buildSnapshot(s.image, s.command, port)
      if (!snap.ok) return alert(snap.reason)
      playing = (await spcPlayback.play(snap.spc)) ? s : null
    }
    return render()
  }
  const row = t.closest<HTMLElement>('.song[data-i]')
  if (row && scan) {
    selected = scan.songs[Number(row.dataset.i)]
    render()
  }
})

function download(s: ScannedSong) {
  const game = scan!.header.ok ? scan!.header.best.title : romName
  const name = `${romName} - ${hex(s.command).slice(1)}`.replace(/[^\w .-]/g, '_')
  const ex = exportSong(s.image, s.song, {
    folder: romName.replace(/[^\w .-]/g, '_'),
    title: `Song ${s.command}`,
    game,
  })
  const readme = [
    `Converted from ${game}, song ${hex(s.command)}, by the HackBench music import prototype.`,
    '',
    'To hear it through AddmusicK:',
    `1. Copy music/${name}.txt into AddmusicK's music folder.`,
    "2. Copy the samples folder over AddmusicK's samples folder (it adds one subfolder).",
    `3. In Addmusic_list.txt, under "Locals:", add a line such as:  2B  ${name}.txt`,
    '4. Run AddmusicK. It writes one .spc per song to its SPCs folder;',
    '   (AddmusicK 1.0.5 docs list a -norom flag to build SPCs without a ROM).',
    '5. Play the .spc in any SPC player and compare with "Play original".',
    '',
    ex.warnings.length
      ? 'Conversion notes:\n' + ex.warnings.map(w => '- ' + w).join('\n')
      : 'No conversion notes.',
    '',
  ].join('\n')
  const enc = new TextEncoder()
  const bytes = zip([
    { path: `music/${name}.txt`, bytes: enc.encode(ex.mml) },
    ...ex.samples,
    { path: 'README.txt', bytes: enc.encode(readme) },
  ])
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
  )
  a.download = `${name}.zip`
  a.click()
  URL.revokeObjectURL(a.href)
}
