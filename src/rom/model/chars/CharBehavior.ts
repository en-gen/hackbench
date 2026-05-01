export interface CharBehavior {
  getPixels(): Uint8Array

  /**
   * Advance internal animation state by one map-animation tick. Called by
   * the editor's map-animation timer (~7.5 Hz) for every char with a
   * registered behavior. Static behaviors omit this; animated/composite
   * behaviors implement it (and forward to nested behaviors).
   */
  tickAnimation?(): void
}
