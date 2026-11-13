### Changed

- Map view: the castle flames and the rotating ring check their call path by running the ROM's own code,
  not by matching copied bytes. A hacked path (a hook or wrapper in the cluster loop, a route that reads
  a cell the test seeds differ on, a dispatch word moved, a branch to foreign code, a stray write) is flagged with the
  address of the foreign code.
