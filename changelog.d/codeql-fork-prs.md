### Fixed

- CI: CodeQL now runs as a workflow on GitHub's hosted runners, so a PR from a fork can report the required CodeQL check. GitHub's default setup never ran on a fork's PR (#1256 and the latest 100 runs). Takes effect once default setup is turned off; evidence is on the PR.
