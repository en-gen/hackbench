# Decision briefs

The format the owner asked to reuse across every team (2026-10-07). Used by the BA for the morning brief and by any tech lead escalating a decision under day shift.

- **One decision per message** when the owner walks through them, numbered "Decision 1 of 4: <title>". When the owner asks for them batched, number the items so one line answers all ("1A, 2C").
- **Brief:** one lead sentence, then two or three context bullets: what is open, and what the docs do until the owner rules.
- **Options:** each a bold bullet, "**A. <name> (recommended).** <one line>", with nested "Pros:" and "Cons:" bullets. Exactly one option is recommended.
- **Recommendation: <letter>.** One sentence giving the reason. A recommendation, not a survey.
- **Close** with how to answer (for example "1A") and what the next decision is.
- **Never tables** in a decision brief.
- **Describe by content, not number.** "The patch-format decision", with the number in parentheses after, never instead.
- **Plain words.** "Network address", not "endpoint".
- **Hedged rulings are firm.** Record "probably X" as X, verbatim, with no re-confirmation. Ask only when the substance is ambiguous.
- **Record each ruling verbatim** in `docs/decisions/` as "Ruled YYYY-MM-DD (Brian)". A ruling settles only the items it names.
- **Defer, don't guess.** "I can't rule on this yet" parks it as a Proposed decision.
