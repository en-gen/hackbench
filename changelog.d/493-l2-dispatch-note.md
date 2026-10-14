### Changed

- Maps (#493): a Layer 2 object background now reports a hooked object dispatch and any refused object handler (#452 opcode gate) in the map note, each line prefixed "Layer 2: " and dropped when Layer 1 already says the same. The notes only; Layer 2 still draws from the ports. Evidence: synthetic tests only (`L2DispatchNote.synthetic.test.ts`, `MapScreenL2.test.ts`); per the PR, no Layer 2 note was observed on a corpus hack, because those map builds are refused before Layer 2 runs.
