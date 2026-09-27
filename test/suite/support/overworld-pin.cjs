/**
 * SHA-256 of the Overworld view's vanilla canvas (#676), shared by the Vitest
 * decode test and the Playwright spec. A hash, not ROM bytes. It changes only
 * when the drawing is meant to change; re-pin after the owner looks.
 */
module.exports = {
  VANILLA_OVERWORLD_CANVAS_SHA256:
    '6b62cf3efad663bf4e8c7f126d25375bb7bef501f8d5aac4e1f0378a709f5b11',
}
