/**
 * A master volume stage in front of an audio graph we do not own.
 *
 * The emulator core's Emscripten OpenAL layer builds its own AudioContext
 * inside alcCreateContext and wires its mix to `ac.destination`. Swapping the
 * AudioContext constructor while the core starts lets that context hand out a
 * GainNode as its destination, so volume and mute never reach into the
 * core's internals, which differ between core builds.
 */
export interface AudioOutput {
  readonly context: AudioContext
  /** What the captured graph sees as the destination: its unscaled mix. */
  readonly input: GainNode
  /** input -> master -> the real destination. Volume is this node's gain. */
  readonly master: GainNode
}

/** Route every AudioContext `realm` constructs until release() through a master gain. */
export function captureAudioContext(
  realm: object,
  onCreate: (out: AudioOutput) => void,
): () => void {
  const g = realm as { AudioContext?: typeof AudioContext }
  const Found = g.AudioContext
  if (!Found) return () => {}
  const Real: typeof AudioContext = Found

  function Captured(options?: AudioContextOptions): AudioContext {
    const context = new Real(options)
    const input = context.createGain()
    const master = context.createGain()
    input.connect(master)
    master.connect(context.destination)
    // An own property shadows the prototype getter for this instance only.
    Object.defineProperty(context, 'destination', { value: input })
    onCreate({ context, input, master })
    return context
  }
  Captured.prototype = Real.prototype
  const replacement = Captured as unknown as typeof AudioContext
  g.AudioContext = replacement

  return () => {
    // Someone may have wrapped it again since; leave theirs alone.
    if (g.AudioContext === replacement) g.AudioContext = Real
  }
}
