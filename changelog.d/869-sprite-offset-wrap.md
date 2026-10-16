### Changed

- Sprite grader: re-based piece offsets now wrap as the hardware does (OAM X is 9 bits, SMWDisX bank_01.asm:7634-7642 and CODE_01B844 7668-7675; Y is folded into -128..127 by the capture, a capture behaviour, not a ROM citation), so a piece the capture records at X -240 is no longer graded +272 and Magikoopa $1F on map $11C slot 8 grades exact; evidence: vanilla ROM, layers_v5 captures, one machine (#869).
