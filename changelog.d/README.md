# Changelog fragments

Each PR adds one file here instead of editing `CHANGELOG.md`, so concurrent
PRs never conflict on the same lines. Name it `<issue>-<slug>.md`
(for example `824-webgl2-spike.md`); the PR number is not known yet.

```
### Added

- One entry per bullet; continuation lines indent two spaces.
```

Allowed headings: Added, Changed, Deprecated, Removed, Fixed, Security. A file
with text before the first heading, an unknown heading, a repeated heading, a
heading with no entries, any `#` line other than `### <Section>`, or a line
that is neither `- ` nor a two-space continuation (tabs are refused) is
refused. The first line under a heading must be a `- ` bullet.

At release, `npm run changelog:release -- <version> [--date YYYY-MM-DD]` folds
every fragment (this README excluded) and any lines already under
`[Unreleased]` into a new `## [<version>]` section, then deletes the fragments.
Without `--date` it stamps today's local date. `--date=YYYY-MM-DD` is not
supported; write `--date YYYY-MM-DD`.

Blank lines inside an entry are not kept. The release step does not touch the
compare links at the foot of `CHANGELOG.md`; update them by hand.
