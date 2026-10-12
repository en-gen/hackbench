### Added

- Spike (#848): `docs/spikes/2026-10-10-parallax-map-view.md` answers whether the map view can show Layer 2 and Layer 3 parallax. Findings only, no behaviour change: the Layer 2 rates are readable from the ROM (SMWDisX bank_00.asm:13727-13749; Layer 3 has no single rule), a per-scroll redraw misses the 5 ms budget (12 to 16 ms per screen, Node, one machine), and the preview-camera proposal is superseded by D48, which selects scroll-anchored option C (#503); #521 stays a separate issue.
