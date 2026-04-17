/**
 * SMW Music Player — webview entry point.
 *
 * Displays all BGM tracks from the ROM and provides media playback controls.
 * Audio is handled entirely within this webview using the spc.js WASM engine
 * (loaded before this script), so user gestures (clicks) happen in the same
 * frame — no autoplay policy issues.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const SMWCentral: any

const vscode = acquireVsCodeApi()

// ── Types ────────────────────────────────────────────────────────────────────

interface TrackInfo {
  bgmCommand: number
  bgmHex: string
  levelIndices: number[]
}

interface MusicPayload {
  tracks: TrackInfo[]
  spcFiles: Record<number, number[]>
}

// ── State ────────────────────────────────────────────────────────────────────

let payload: MusicPayload | null = null
let currentTrack = -1  // index into payload.tracks
let isPlaying = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let backend: any = null

// ── DOM ──────────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!
app.innerHTML = `
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, system-ui); color: var(--vscode-foreground, #ccc); }
  .player {
    display: flex; flex-direction: column; height: 100vh;
    background: var(--vscode-editor-background, #1e1e1e);
  }
  .transport {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border, #3a3a3a);
  }
  .transport button {
    background: none; border: 1px solid var(--vscode-button-border, #555);
    color: var(--vscode-foreground, #ccc); cursor: pointer;
    width: 28px; height: 28px; border-radius: 3px; font-size: 14px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .transport button:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
  .transport button:disabled { opacity: 0.3; cursor: default; }
  .transport button:disabled:hover { background: none; }
  .now-playing {
    font-size: 11px; color: var(--vscode-descriptionForeground, #888);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0; flex: 1;
  }
  .time {
    font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground, #888);
    min-width: 36px; text-align: center; flex-shrink: 0;
  }
  .volume {
    display: flex; align-items: center; gap: 4px; flex-shrink: 0;
  }
  .volume-icon { font-size: 12px; cursor: pointer; opacity: 0.7; }
  .volume-icon:hover { opacity: 1; }
  .volume input[type=range] {
    width: 60px; height: 4px; -webkit-appearance: none; appearance: none;
    background: var(--vscode-scrollbarSlider-background, #555); border-radius: 2px;
    outline: none; cursor: pointer;
  }
  .volume input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 10px; height: 10px;
    background: var(--vscode-foreground, #ccc); border-radius: 50%; cursor: pointer;
  }
  .track-list {
    flex: 1; overflow-y: auto; padding: 4px 0;
  }
  .track {
    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    cursor: pointer; font-size: 12px;
  }
  .track:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .track.active { background: var(--vscode-list-activeSelectionBackground, #094771); }
  .track-num { font-family: monospace; color: var(--vscode-descriptionForeground, #888); min-width: 24px; }
  .track-label { flex: 1; }
  .track-bgm { font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
  .track-playing { color: var(--vscode-focusBorder, #007acc); }
  .loading { display: flex; align-items: center; justify-content: center; height: 100%; color: #888; }
</style>

<div class="player">
  <div class="track-list" id="track-list">
    <div class="loading">Loading tracks...</div>
  </div>
  <div class="transport">
    <button id="btn-prev" title="Previous">&#x23EE;</button>
    <button id="btn-stop" title="Stop" disabled>&#x23F9;</button>
    <button id="btn-play" title="Play">&#x25B6;</button>
    <button id="btn-next" title="Next">&#x23ED;</button>
    <span class="time" id="elapsed">0:00</span>
    <span class="now-playing" id="now-playing">No track selected</span>
    <div class="volume">
      <span class="volume-icon" id="vol-icon" title="Mute/Unmute">&#x1F50A;</span>
      <input type="range" id="vol-slider" min="0" max="150" value="100" title="Volume"/>
    </div>
  </div>
</div>
`

const btnPrev = document.getElementById('btn-prev')! as HTMLButtonElement
const btnStop = document.getElementById('btn-stop')! as HTMLButtonElement
const btnPlay = document.getElementById('btn-play')! as HTMLButtonElement
const btnNext = document.getElementById('btn-next')! as HTMLButtonElement
const nowPlayingEl = document.getElementById('now-playing')!
const trackListEl = document.getElementById('track-list')!
const elapsedEl = document.getElementById('elapsed')!
const volSlider = document.getElementById('vol-slider')! as HTMLInputElement
const volIcon = document.getElementById('vol-icon')!

// ── Audio backend ────────────────────────────────────────────────────────────

function initBackend(): void {
  backend = SMWCentral?.SPCPlayer?.Backend ?? null
  // status 0 = needs init, status 1 = already initialized (spc.js auto-inits)
  if (backend && backend.status === 0) {
    backend.initialize()
  }
  console.log('[MUSIC] Backend ready, status:', backend?.status)
}

function playTrack(index: number): void {
  console.log('[MUSIC] playTrack', index, 'backend:', backend?.status, 'payload:', !!payload)
  if (!payload) { console.error('[MUSIC] No payload'); return }
  if (!backend) { console.error('[MUSIC] No backend'); return }
  if (backend.status !== 1) { console.error('[MUSIC] Backend not ready, status:', backend.status); return }
  const track = payload.tracks[index]
  if (!track) { console.error('[MUSIC] No track at index', index); return }
  const spcData = payload.spcFiles[track.bgmCommand]
  if (!spcData) { console.error('[MUSIC] No SPC data for BGM', track.bgmCommand); return }
  console.log('[MUSIC] Playing track', track.bgmCommand, '— SPC size:', spcData.length, 'context state:', backend.context?.state)

  // Unlock AudioContext — must happen in the click call stack
  backend.locked = false
  const ctx = backend.context as AudioContext
  if (ctx) {
    ctx.resume().then(() => {
      console.log('[MUSIC] AudioContext resumed, state:', ctx.state)
      try {
        backend.loadSPC(new Uint8Array(spcData))
        // Ensure gain is at max (spc.js UI init may have left it at 0)
        if (backend.gainNode) backend.gainNode.gain.value = 1.0
        // Ensure sample rate matches SPC output (32kHz)
        console.log('[MUSIC] loadSPC complete, context:', ctx.state,
          'gain:', backend.gainNode?.gain?.value,
          'sampleRate:', ctx.sampleRate)
      } catch (err) {
        console.error('[MUSIC] loadSPC failed:', err)
      }
    })
  }
  currentTrack = index
  isPlaying = true
  updateUI()
}

function stopTrack(): void {
  if (backend && isPlaying) {
    backend.stopSPC(false)
  }
  isPlaying = false
  elapsedEl.textContent = '0:00'
  updateUI()
}

function togglePlayPause(): void {
  if (!isPlaying) {
    // Play current or first track
    playTrack(currentTrack >= 0 ? currentTrack : 0)
  } else if (backend?.context?.state === 'running') {
    backend.context.suspend()
    updateUI()
  } else if (backend?.context?.state === 'suspended') {
    backend.context.resume()
    updateUI()
  }
}

function prevTrack(): void {
  if (!payload) return
  const idx = currentTrack > 0 ? currentTrack - 1 : payload.tracks.length - 1
  playTrack(idx)
}

function nextTrack(): void {
  if (!payload) return
  const idx = currentTrack < payload.tracks.length - 1 ? currentTrack + 1 : 0
  playTrack(idx)
}

// ── UI ───────────────────────────────────────────────────────────────────────

function renderTrackList(): void {
  if (!payload) return
  trackListEl.innerHTML = ''
  payload.tracks.forEach((track, i) => {
    const el = document.createElement('div')
    el.className = 'track' + (i === currentTrack ? ' active' : '')
    el.innerHTML = `
      <span class="track-num ${i === currentTrack && isPlaying ? 'track-playing' : ''}">${i === currentTrack && isPlaying ? '&#x25B6;' : (i + 1)}</span>
      <span class="track-label">Track ${track.bgmCommand}</span>
      <span class="track-bgm">BGM $${track.bgmHex}</span>
    `
    el.addEventListener('click', () => playTrack(i))
    trackListEl.appendChild(el)
  })
}

function updateUI(): void {
  const paused = isPlaying && backend?.context?.state === 'suspended'
  btnPlay.textContent = (isPlaying && !paused) ? '\u23F8' : '\u25B6'
  btnPlay.title = (isPlaying && !paused) ? 'Pause' : 'Play'
  btnStop.disabled = !isPlaying

  if (payload && currentTrack >= 0 && currentTrack < payload.tracks.length) {
    const t = payload.tracks[currentTrack]
    nowPlayingEl.textContent = isPlaying
      ? `Track ${t.bgmCommand} — BGM $${t.bgmHex}`
      : `Track ${t.bgmCommand}`
  } else {
    nowPlayingEl.textContent = 'No track selected'
  }

  // Update active state in track list
  const items = trackListEl.querySelectorAll('.track')
  items.forEach((el, i) => {
    el.classList.toggle('active', i === currentTrack)
    const num = el.querySelector('.track-num')
    if (num) {
      num.classList.toggle('track-playing', i === currentTrack && isPlaying)
      num.innerHTML = (i === currentTrack && isPlaying) ? '&#x25B6;' : String(i + 1)
    }
  })
}

// ── Time display ─────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

setInterval(() => {
  if (isPlaying && backend?.getTime) {
    const t = backend.getTime()
    elapsedEl.textContent = formatTime(t)
  }
}, 500)

// ── Volume ───────────────────────────────────────────────────────────────────

let lastVolume = 1.0

volSlider.addEventListener('input', () => {
  const vol = parseInt(volSlider.value) / 100
  if (backend?.setVolume) backend.setVolume(vol)
  lastVolume = vol
  updateVolIcon(vol)
})

volIcon.addEventListener('click', () => {
  if (!backend) return
  const current = backend.getVolume?.() ?? 1.0
  if (current > 0.01) {
    lastVolume = current
    backend.setVolume(0)
    volSlider.value = '0'
    updateVolIcon(0)
  } else {
    backend.setVolume(lastVolume)
    volSlider.value = String(Math.round(lastVolume * 100))
    updateVolIcon(lastVolume)
  }
})

function updateVolIcon(vol: number): void {
  volIcon.textContent = vol < 0.01 ? '\u{1F507}' : vol < 0.5 ? '\u{1F509}' : '\u{1F50A}'
}

// ── Events ───────────────────────────────────────────────────────────────────

btnPlay.addEventListener('click', togglePlayPause)
btnStop.addEventListener('click', stopTrack)
btnPrev.addEventListener('click', prevTrack)
btnNext.addEventListener('click', nextTrack)

// ── Message handler ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data
  if (msg.type === 'load') {
    payload = msg as MusicPayload
    renderTrackList()
    updateUI()
  } else if (msg.type === 'error') {
    trackListEl.innerHTML = `<div class="loading">${msg.message}</div>`
  }
})

// ── Init ─────────────────────────────────────────────────────────────────────
// Poll for spc.js Backend availability (WASM compilation is async)
let initAttempts = 0
const initInterval = setInterval(() => {
  initAttempts++
  const b = SMWCentral?.SPCPlayer?.Backend
  console.log(`[MUSIC] Init poll #${initAttempts}: Backend=${b ? 'found' : 'null'}, status=${b?.status}`)
  if (b && b.status !== undefined) {
    clearInterval(initInterval)
    initBackend()
    vscode.postMessage({ type: 'ready' })
  } else if (initAttempts > 20) {
    clearInterval(initInterval)
    console.error('[MUSIC] Backend never became available after 10s')
    vscode.postMessage({ type: 'ready' })
  }
}, 500)

export {}
