<!--
Thanks for contributing to HackBench!

Before submitting, please confirm:
- Your branch targets `develop` (not `main`)
- You have read CONTRIBUTING.md
-->

## Summary

<!-- One or two sentences on what this PR does and why. Focus on the
motivation - the diff shows the mechanics. -->

## Related issue

<!-- Closes #N / Refs #N. Delete this section if no issue. -->

## Changes

<!-- Bulleted list of notable changes. Skip for tiny PRs. -->

-

## Testing

<!-- How did you verify this works? Unit tests, Playwright specs (which
ones)? Which ROM? -->

-

## Checklist

- [ ] PR targets `develop`
- [ ] `npm run lint` passes locally
- [ ] `npm run test:unit` passes locally
- [ ] New behavior is covered by a unit test (or the PR explains why not)
- [ ] Core logic stays in `src/rom/` / `src/project/` with no shell imports (no Theia, no VS Code)
- [ ] No ROM-derived content (ROMs, patches, dumps, ripped graphics, disassembly); the content gate enforces this
- [ ] User-facing changes noted in a new `changelog.d/<issue>-<slug>.md` file (not in `CHANGELOG.md`)
- [ ] Significant UI change or feature addition: `needs-owner` label added, auto-merge left off
- [ ] Change to what the app shows: before/after images embedded
