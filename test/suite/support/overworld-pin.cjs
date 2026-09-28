/**
 * SHA-256 of the Overworld view's vanilla canvas, L2 under L1 (en-gen/hackbench#363), shared by the Vitest
 * decode test and the Playwright spec. A hash, not ROM bytes. It changes only
 * when the drawing is meant to change; re-pin after the owner looks.
 */
module.exports = {
  VANILLA_OVERWORLD_CANVAS_SHA256:
    'ce677afd2d22b5911e1b46f4b27eb7380c6dfdd514647c0ffcd9abc7aa41226f',
}
