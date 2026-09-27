# Frame 0, not raw GFX

`src/rom/FrameZero.ts` `frameZeroChars` / `frameZeroFrom`.

The VRAM every surface of this view composites from: this ROM's own
animation FRAME 0, not the raw bytes of the four GFX files.

The two are not the same picture. Measured on vanilla tileset 0, 75 of
the 80 animated characters differ - $040-$07F bar $078, $080-$081,
$090-$091, $0DA-$0DD and $0EA-$0ED - and every one of the 89
tileset/ROM combinations in the corpus that carries animation data
diverges (GPW2: 60 of 64). Those characters are the coins, the `?`
blocks and the water.

So this is not a rendering nicety. A palette section drawn from raw VRAM
beside a tile drawn from frame 0 shows the user a coin, takes the click
and paints something else, and the whole design rests on recognition
coming from the picture. Map16Decode.test.ts already pins that the STILL
SHEET composites from here rather than from raw VRAM, and warns in as
many words that reintroducing the raw source is the original bug; this
function exists so every surface has ONE source and there is no second
chance to make that mistake one surface over.
