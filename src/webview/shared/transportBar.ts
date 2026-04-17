/**
 * Shared SPC transport bar — reusable media controls for any webview.
 *
 * Creates a horizontal bar with: prev, stop, play/pause, next, elapsed time,
 * track label, volume slider + mute toggle.
 *
 * Usage:
 *   const transport = createTransportBar({ onPlay, onStop, ... })
 *   container.appendChild(transport.element)
 *   transport.setPlaying(true)
 *   transport.setTrackLabel('Track 2')
 *   transport.updateTime(backend)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const SMWCentral: any

export interface TransportCallbacks {
  onPlay: () => void
  onStop: () => void
  onPrev: () => void
  onNext: () => void
  /** Called when playback state changes — use to notify extension for tab icon updates. */
  onStateChange?: (playing: boolean) => void
  /** Hide the prev/next track buttons (e.g. single-track contexts). */
  hidePrevNext?: boolean
}

export interface TransportBar {
  element: HTMLElement
  setPlaying(playing: boolean): void
  setPaused(paused: boolean): void
  setTrackLabel(label: string): void
  updateTime(seconds: number): void
  setStopEnabled(enabled: boolean): void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function createTransportBar(cb: TransportCallbacks): TransportBar {
  const el = document.createElement('div')
  el.className = 'smw-transport'
  el.innerHTML = `
    <button class="smw-tb" data-action="prev" title="Previous">&#x23EE;</button>
    <button class="smw-tb" data-action="stop" title="Stop" disabled>&#x23F9;</button>
    <button class="smw-tb" data-action="play" title="Play">&#x25B6;</button>
    <button class="smw-tb" data-action="next" title="Next">&#x23ED;</button>
    <span class="smw-t-time">0:00</span>
    <span class="smw-t-label">No track</span>
    <div class="smw-t-vol">
      <span class="smw-t-vol-icon" title="Mute/Unmute">&#x1F50A;</span>
      <input type="range" class="smw-t-vol-slider" min="0" max="150" value="100" title="Volume"/>
    </div>
  `

  const btnPlay = el.querySelector('[data-action="play"]') as HTMLButtonElement
  const btnStop = el.querySelector('[data-action="stop"]') as HTMLButtonElement
  const timeEl = el.querySelector('.smw-t-time')!
  const labelEl = el.querySelector('.smw-t-label')!
  const volSlider = el.querySelector('.smw-t-vol-slider') as HTMLInputElement
  const volIcon = el.querySelector('.smw-t-vol-icon')!

  let isPlaying = false
  let isPaused = false
  let lastVolume = 1.0

  // Hide prev/next if not applicable
  if (cb.hidePrevNext) {
    ;(el.querySelector('[data-action="prev"]') as HTMLElement).style.display = 'none'
    ;(el.querySelector('[data-action="next"]') as HTMLElement).style.display = 'none'
  }

  // Button clicks
  el.querySelector('[data-action="prev"]')!.addEventListener('click', cb.onPrev)
  el.querySelector('[data-action="next"]')!.addEventListener('click', cb.onNext)
  btnStop.addEventListener('click', cb.onStop)
  btnPlay.addEventListener('click', cb.onPlay)

  // Volume
  volSlider.addEventListener('input', () => {
    const vol = parseInt(volSlider.value) / 100
    const backend = SMWCentral?.SPCPlayer?.Backend
    if (backend?.setVolume) backend.setVolume(vol)
    lastVolume = vol
    updateVolIcon(vol)
  })

  volIcon.addEventListener('click', () => {
    const backend = SMWCentral?.SPCPlayer?.Backend
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

  function updateButtons(): void {
    btnPlay.textContent = (isPlaying && !isPaused) ? '\u23F8' : '\u25B6'
    btnPlay.title = (isPlaying && !isPaused) ? 'Pause' : 'Play'
    btnStop.disabled = !isPlaying
  }

  return {
    element: el,
    setPlaying(playing: boolean) { isPlaying = playing; isPaused = false; updateButtons(); cb.onStateChange?.(playing) },
    setPaused(paused: boolean) { isPaused = paused; updateButtons() },
    setTrackLabel(label: string) { labelEl.textContent = label },
    updateTime(seconds: number) { timeEl.textContent = formatTime(seconds) },
    setStopEnabled(enabled: boolean) { btnStop.disabled = !enabled },
  }
}

/** CSS for the transport bar — inject once into the document. */
export const TRANSPORT_CSS = `
.smw-transport {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; flex-shrink: 0;
  border-top: 1px solid var(--vscode-panel-border, #3a3a3a);
  background: var(--vscode-editor-background, #1e1e1e);
}
.smw-tb {
  background: none; border: 1px solid var(--vscode-button-border, #555);
  color: var(--vscode-foreground, #ccc); cursor: pointer;
  width: 28px; height: 28px; border-radius: 3px; font-size: 14px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.smw-tb:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
.smw-tb:disabled { opacity: 0.3; cursor: default; }
.smw-tb:disabled:hover { background: none; }
.smw-t-time {
  font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground, #888);
  min-width: 36px; text-align: center; flex-shrink: 0;
}
.smw-t-label {
  font-size: 11px; color: var(--vscode-descriptionForeground, #888);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0; flex: 1;
}
.smw-t-vol {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0;
}
.smw-t-vol-icon { font-size: 12px; cursor: pointer; opacity: 0.7; }
.smw-t-vol-icon:hover { opacity: 1; }
.smw-t-vol-slider {
  width: 60px; height: 4px; -webkit-appearance: none; appearance: none;
  background: var(--vscode-scrollbarSlider-background, #555); border-radius: 2px;
  outline: none; cursor: pointer;
}
.smw-t-vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 10px; height: 10px;
  background: var(--vscode-foreground, #ccc); border-radius: 50%; cursor: pointer;
}
`
