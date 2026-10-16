### Changed

- Sprite report (#863, dev tool): the hardware panel of a card whose sprite uploads changing graphics ($33, $35) or whose tiles differ between the capture's VRAM samples now draws from the sample taken on the card's drawnFrame (anchorFrame + offset); with no such sample it keeps level-start graphics and says "graphics at level start, may differ". Evidence: synthetic unit tests, plus a read of the `layers_v5` captures on one machine.
