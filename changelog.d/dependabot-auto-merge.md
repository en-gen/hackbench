### Added

- CI: a workflow arms auto-merge on Dependabot npm patch and minor PRs (one commit, no electron in the diff) so they merge once the required checks pass, and disarms it when a later push no longer qualifies. Majors, github-actions updates and anything touching Electron stay manual. Reads metadata and the diff only, never PR code.
