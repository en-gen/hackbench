/**
 * SHA-256s of the Overworld view's vanilla canvas (en-gen/hackbench#363),
 * shared by the Vitest decode test and the Playwright spec: both layers, L1
 * (foreground) alone (also what a refused L2 leaves), and L2 (background)
 * alone. Hashes, not ROM bytes. They change only when the drawing is meant to
 * change; re-pin after the owner looks.
 *
 * The three single hashes are of the halves joined row by row into one
 * 1024x512 image, as the view drew it before the halves became two canvases
 * (#431); the decode test proves the joined halves still match them. The
 * per-half pins, [hub, half 1], are what each canvas is checked against.
 */
module.exports = {
  VANILLA_OVERWORLD_CANVAS_SHA256:
    'ce677afd2d22b5911e1b46f4b27eb7380c6dfdd514647c0ffcd9abc7aa41226f',
  VANILLA_OVERWORLD_L1_SHA256: '14009dcdbed8728de5f9601561e6b05b28fd590c76dcc0373732e7567c6ce116',
  VANILLA_OVERWORLD_L2_SHA256: '639dbc5ec91e7778eccc40f368509fd6e8f8ca000dbbb4f12ddb1d935c35439b',
  VANILLA_OVERWORLD_HALF_SHA256: {
    BOTH: [
      'c12aff6573d3180ba664d8fc9e6bcfd8b7e2460f154ff1dce2b50e595be6a480',
      '3796ed7308b91dfe3b9b33e57de191414f64bd5d8e6a9fc23a3a1ac932ee9e23',
    ],
    L1: [
      '664576ed357ffba66373b4c2e2bc947cc5b9df6c89c6d58715820f316a811625',
      '9a1e51a3ca2651c6cfa15612674103970c74e0ad1f71639d510fc40fcae4b416',
    ],
    L2: [
      '6a1171cf22e3d88b36bb86853756a1811783591a65ca3a2f1bbe5f3d75b0fd26',
      '06fdc75d48f12ded3b332677855c91b45ccc53842b88bf4affa0472bf456cb08',
    ],
  },
}
