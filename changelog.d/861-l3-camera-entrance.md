### Changed

- Maps (#861): the drawn layer 2 height and the layer 3 camera now share one entrance chooser (`chooseEntrance`). No drawn result changes on any ROM, because the exit graph sorts a map's secondary entrances (`SmwRom.ts:565`); the two only differed when the first listed secondary entrance was not the lowest. Evidence: synthetic tests only (`EntranceChooser.synthetic.test.ts`, 64 via shapes; `MapScreenL2.test.ts`).
