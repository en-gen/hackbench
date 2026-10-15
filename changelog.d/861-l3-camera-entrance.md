### Fixed

- Maps (#861): the drawn layer 2 height and the layer 3 camera now pick the entrance with one shared chooser (`chooseEntrance`). They differed only on a map entered solely through secondary entrances whose list was not ascending (L2 drew the first listed, L3 used the lowest). Evidence: synthetic tests only (`EntranceChooser.synthetic.test.ts`, 64 via shapes); no vanilla map has this shape.
