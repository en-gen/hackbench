### Changed

- Tests (#1233): the off-map canvas spec's bottom-band cases no longer rest on map $102, whose 24 px of sprites below the map came from floating platforms and spike balls sinking after an INIT retry, because the loader had skipped the Layer 3 handler (#842); that ended for good with #842 and #1119. The 24-rounds-up-to-32, Fit and grid cases now use a synthetic box 24 px below map $1B, and one case checks the real 16 px of its Wooden Spikes. Spec only; vanilla ROM, one machine.
