/**
 * Volume and mute as one value, shared by every view that plays sound so the
 * control behaves the same everywhere. Kept apart from any widget so the
 * rules below are unit tested without a shell.
 */
export interface VolumeState {
  /** 0..MAX_VOLUME, kept while muted so unmute returns to it. */
  volume: number
  muted: boolean
}

export const DEFAULT_VOLUME = 1
/** Same headroom as the VS Code extension's music slider (0-150%). */
export const MAX_VOLUME = 1.5

const clamp = (v: number): number => Math.min(MAX_VOLUME, Math.max(0, v))

export function effectiveGain(s: VolumeState): number {
  return s.muted ? 0 : s.volume
}

export function toggleMute(s: VolumeState): VolumeState {
  if (!s.muted) return { ...s, muted: true }
  // Unmuting at zero would be a click that changes nothing audible.
  return { volume: s.volume > 0 ? s.volume : DEFAULT_VOLUME, muted: false }
}

export function setVolume(volume: number): VolumeState {
  return { volume: clamp(volume), muted: false }
}

/** Persisted state comes back from storage untyped; never trust its shape. */
export function parseVolumeState(raw: unknown): VolumeState {
  const r = raw as Partial<VolumeState> | null | undefined
  if (!r || typeof r.volume !== 'number' || !Number.isFinite(r.volume)) {
    return { volume: DEFAULT_VOLUME, muted: false }
  }
  return { volume: clamp(r.volume), muted: r.muted === true }
}
