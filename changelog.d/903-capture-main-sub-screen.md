### Fixed

- Capture viewer (#903): layers now follow TM ($212C) and TS ($212D), so a layer only on the sub screen draws behind the main screen. On a capture with $2105=$01, TM $15, TS $02, Layer 3 now draws over Layer 2. No colour-math blending of the sub screen. Evidence: synthetic tests only (`CaptureOracle.synthetic.test.ts`), no capture rendered.
