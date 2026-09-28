/**
 * SHA-256s of the Overworld view's vanilla canvas (en-gen/hackbench#363),
 * shared by the Vitest decode test and the Playwright spec: both layers, L1
 * (foreground) alone (also what a refused L2 leaves), and L2 (background)
 * alone. Hashes, not ROM bytes. They change only when the drawing is meant to
 * change; re-pin after the owner looks.
 */
module.exports = {
  VANILLA_OVERWORLD_CANVAS_SHA256:
    'ce677afd2d22b5911e1b46f4b27eb7380c6dfdd514647c0ffcd9abc7aa41226f',
  VANILLA_OVERWORLD_L1_SHA256: '14009dcdbed8728de5f9601561e6b05b28fd590c76dcc0373732e7567c6ce116',
  VANILLA_OVERWORLD_L2_SHA256: '639dbc5ec91e7778eccc40f368509fd6e8f8ca000dbbb4f12ddb1d935c35439b',
}
