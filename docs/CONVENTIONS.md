# Documentation conventions

The contract for everything under `docs/`. `CLAUDE.md` holds the short form; if they disagree, this file wins and `CLAUDE.md` is wrong.

## Epistemic tags

Every claim that is not self-evident carries a tag at its end, inline, never as a prefix and never in front matter:

- `[EST]` read or measured: from the ROM, the disassembly, a test run, the owner's words.
- `[INF]` inferred from `[EST]` material. Say from what.
- `[OPEN]` unresolved. Say what would resolve it.
- `[PROP]` proposed and not ratified. Only the owner promotes it, and the file records the promotion.

Never promote a draft or a recommendation into a decision. A night-shift call is `[PROP]` until ruled.

## Citation

- ROM behaviour cites `SMWDisX file:line`. Trace it; never copy assembly into this repository.
- State the evidence scope with every claim: not "deterministic" but "byte-identical across 6 cold runs, one machine, Mesen 2.x".
- Pin commits by SHA, never "develop" or "main".
- Record what you could not read or verify. A recorded gap beats a confident guess.

## Corrections

When a primary source contradicts a doc, correct the doc in place and leave the trail: "Corrected YYYY-MM-DD: was X, because Y". Never silently rewrite.

## File shape

An analysis or findings file opens with a Bottom line blockquote of three to six bullets, each tagged, then a Provenance table with Source, Identifier, As of and Retrieved columns. Feature and architecture docs at the root and under `architecture/` keep their current shape.

## Decisions

A ruling is a file in `decisions/`, named `YYYY-MM-DD-<slug>.md`. Its first line is one of:

- `Proposed YYYY-MM-DD (<team>)`
- `Ruled YYYY-MM-DD (Brian)`

Then the headings Question, Options considered, Ruling (the owner's words verbatim), Why, Applies to. Promotion edits the first line in place. `decisions/README.md` lists one line per file. Rulings no longer go to issues, the notes repository or session memory; those get a pointer.

## Protocols

A protocol is a file in `protocols/` with exactly these H2 headings in this order: Purpose, Group, Activation, Changes, Unchanged, Exit. The H1 is the file stem. Changes is a numbered list of at most fifteen lines; it is injected into every session's context on every turn while the protocol is active. Group is `none`, a group name, or a group name followed by `(default)`.

## What never goes in docs

Machine-local paths, credentials, ROM bytes, rendered ROM graphics, disassembly listings. The content gate refuses the last three; the first two are a rule. Keep them in session memory with a one-line pointer into `docs/`.

## Writing

Plain words. No em-dashes. Describe things by content, with any number in parentheses after. One line per paragraph or list item in new files; existing hard-wrapped files stay as they are.
