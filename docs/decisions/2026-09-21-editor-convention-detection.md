Ruled 2026-09-21 (Brian)

## Question

How does HackBench handle the layouts a hack ROM can be in?

## Options considered

Support every layout generically; detect one of three conventions (vanilla, magic, ours) and port to ours; adopt the magic convention as ours.

## Ruling

Owner framing 2026-09-21, wording not recorded. Lunar Magic is the only other SMW ROM editor, so a ROM is in one of three conventions: vanilla (stock tables at stock addresses), magic (Lunar Magic: per-level palette override blocks at `$0EF600`, ExAnimation, expanded Map16 pages, relocated GFX), or ours. Detect which, then port to ours. `[EST]`

## Why

- Two editors, three conventions, so detection is tractable rather than open-ended. `[EST]`
- Leading option, not decided: reuse the magic convention wholesale (collapses three to two, makes output loadable by LM, needs no porting of existing hacks); cost is matching LM's formats by reading ROMs, as there is no spec. `[PROP]`
- Lunar Magic is a convention we detect, never a source of truth we cite. `[EST]`
- Undecided: whether to adopt magic wholesale; whether porting happens on import or lazily. `[OPEN]`

## Applies to

ROM detection and import.
