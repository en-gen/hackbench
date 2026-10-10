# Changelog fragments

Each PR adds one file here instead of editing `CHANGELOG.md`, so concurrent
PRs never conflict on the same lines. Name it `<issue>-<slug>.md`
(for example `824-webgl2-spike.md`); the PR number is not known yet.

```
### Added

- One entry per bullet; continuation lines indent two spaces.
```

Allowed headings: Added, Changed, Deprecated, Removed, Fixed, Security. A file
with text before the first heading, an unknown heading, or a heading with no
entries is refused.

At release, `npm run changelog:release -- <version> [--date YYYY-MM-DD]` folds
every fragment (this README excluded) and any lines already under
`[Unreleased]` into a new `## [<version>]` section, then deletes the fragments.
