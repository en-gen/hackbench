### Fixed

- Sprite grader: a vertical map's sprite list is now read with the vertical X/Y swap, so
  neighbour-scanning sprites see the right neighbours (#1018).
  Evidence scope: on the vanilla corpus, no graded record changed verdict. On the 7 vertical
  capture maps, the list x/y now equals the capture's listX/listY in all 51 records (50 had x and
  y swapped). The guard is a synthetic sweep of all 32 level modes in levelSpriteList.test.ts.
