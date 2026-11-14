Proposed 2026-11-13 (quebec, #1289)

# A personal ROM list keeps owner-only carts out of the corpus checks

## Question

D200 (owner): a ROM the owner plays for fun stays in the ROM folder and is not added to `CORPUS` or to any per-ROM test. The membership guards fail on any cart on disk that `CORPUS` does not name, so such a cart fails them on that machine. How are personal carts left out without naming one in the repo? Three build calls follow.

## Options considered

Call 1, where the list lives.
- A. `personal.txt` in the ROM folder itself: UTF-8, one file name per line, blank lines and `#` comments ignored, names matched case-insensitively. A missing file is an empty list.
- B. A list in the repo, or an environment variable. Rejected: a repo list names the cart, and a variable is invisible next to the carts and easy to lose per shell.

Call 2, how the left-out count is shown.
- A. One `skipIf` case whose title carries the count (`leaves out N personal ROM(s) listed in personal.txt`), skipped when N is 0.
- B. Generate one case per listed cart. Rejected: the registration gate bans deciding at module scope, from the disk, how many cases exist.

Call 3, a `CORPUS` cart named in `personal.txt`.
- A. Fail loudly: `personalCorpusOverlap()` must be empty, checked by a case outside the disk skip.
- B. Leave it out silently. Rejected: it would drop a corpus cart from every sweep with nothing red.

## Ruling

wording not recorded. 2026-11-13, night shift: A on all three calls, built on D200. `[INF]`

## Why

- The folder already holds the carts and sits outside git, so a list there names nothing in the repo (D200, #1289 acceptance 4). Case folding matches how Windows treats file names; UTF-8 is required because PowerShell 5 `>` writes UTF-16, which reads as an empty list.
- A count in one case title is visible in a run and cannot change how many cases register, which keeps the registration gate's rule intact.
- A listed corpus cart is almost certainly a mistake, and the cost of silence is a sweep that quietly covers one cart fewer.
- Evidence scope: proved on scratch folders of junk bytes in `corpusPersonal.test.ts` and by a planted-file run on one machine; the list is read per run, so results with and without it are not comparable.

## Applies to

`test/suite/support/corpus.cjs` and `corpus.ts` (`personalRoms`, `romsOnDisk`, `personalRomsPresent`, `unlistedCarts`, `personalCorpusOverlap`), `corpusResolver.test.ts`, `corpusPersonal.test.ts`, `docs/testing.md` (A personal ROM list), #1289.
