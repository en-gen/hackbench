### Fixed

- Maps view (#973): scrolling a long horizontal map no longer stutters. Every scroll event rebuilt the picture of each screen that has no block indicators (about 44 ms per event on slot `$105`); a screen found to have none now keeps that result until its key changes. Evidence: slot `$105`, `build:browser`, headless Chromium, one machine; scripted 100 Hz scroll frame p95 33.5 ms (fit) before, 16.8 ms after, zero rebuilds.
