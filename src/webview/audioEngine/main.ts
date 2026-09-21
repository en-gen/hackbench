/**
 * Audio engine webview - SPC playback via @smwcentral/spc-player Backend.
 *
 * The spc.js (Emscripten-compiled snes_spc) is loaded before this script.
 * It provides window.SMWCentral.SPCPlayer.Backend with the low-level API:
 *   Backend.initialize()  - create AudioContext
 *   Backend.loadSPC(spc)  - load Uint8Array SPC, start playback
 *   Backend.stopSPC()     - stop
 *
 * Messages FROM extension:
 *   { type: 'play',   spcData: number[] }
 *   { type: 'pause'  }
 *   { type: 'resume' }
 *   { type: 'stop'   }
 *
 * Messages TO extension:
 *   { type: 'ready'  }
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const SMWCentral: any

const vscode = acquireVsCodeApi()

let isPlaying = false
let backend: ReturnType<typeof getBackend> | null = null
let audioUnlocked = false
let pendingPlay: Uint8Array | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getBackend(): any {
  return SMWCentral?.SPCPlayer?.Backend ?? null
}

function init(): void {
  backend = getBackend()
  if (!backend) {
    console.error('[AUDIO] Backend not available')
    return
  }
  if (backend.status === 0) {
    backend.initialize()
    console.log('[AUDIO] Backend initialized, status:', backend.status)
  } else {
    console.warn('[AUDIO] Backend status:', backend.status)
  }
}

function unlockAndPlay(spcData: Uint8Array): void {
  if (!backend || backend.status !== 1) {
    console.error('[AUDIO] Backend not ready, status:', backend?.status)
    return
  }
  backend.locked = false
  const ctx = backend.context as AudioContext | null
  if (ctx && ctx.state === 'suspended') {
    // Resume returns a promise; load SPC after context is running
    ctx.resume().then(() => {
      console.log('[AUDIO] AudioContext unlocked, state:', ctx.state)
      backend.loadSPC(spcData)
      isPlaying = true
      console.log('[AUDIO] Playing SPC,', spcData.length, 'bytes')
    })
  } else {
    backend.loadSPC(spcData)
    isPlaying = true
    console.log('[AUDIO] Playing SPC,', spcData.length, 'bytes')
  }
}

function playSpc(spcData: Uint8Array): void {
  if (audioUnlocked) {
    unlockAndPlay(spcData)
  } else {
    // AudioContext can only be resumed from a user gesture inside this frame.
    // Queue the SPC data and show a prompt - the next click unlocks audio.
    pendingPlay = spcData
    document.body.style.display = ''
    document.body.innerHTML =
      `<div style="
      display:flex;align-items:center;justify-content:center;height:100%;
      cursor:pointer;font:12px var(--vscode-font-family,system-ui);
      color:var(--vscode-foreground,#ccc);user-select:none;
    ">Click to enable audio</div>` + document.body.innerHTML
    console.log('[AUDIO] Waiting for user gesture to unlock audio...')
  }
}

function stopPlayback(): void {
  if (backend && isPlaying) {
    backend.stopSPC(false)
    isPlaying = false
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

window.addEventListener('message', event => {
  const msg = event.data
  switch (msg.type) {
    case 'play':
      playSpc(new Uint8Array(msg.spcData))
      break
    case 'pause':
      backend?.context?.suspend()
      break
    case 'resume':
      backend?.context?.resume()
      break
    case 'stop':
      stopPlayback()
      break
  }
})

// ── Unlock audio on first user gesture inside the webview ────────────────────
document.addEventListener(
  'click',
  function onFirstClick() {
    document.removeEventListener('click', onFirstClick)
    audioUnlocked = true
    const prompt = document.body.querySelector('div')
    if (prompt) prompt.remove()
    console.log('[AUDIO] User gesture received, audio unlocked')
    if (pendingPlay) {
      const data = pendingPlay
      pendingPlay = null
      unlockAndPlay(data)
    }
  },
  { once: true },
)

// ── Init ─────────────────────────────────────────────────────────────────────
// Wait a tick for spc.js WASM to finish initializing
setTimeout(() => {
  init()
  console.log('[AUDIO] Ready')
  vscode.postMessage({ type: 'ready' })
}, 500)

export {}
