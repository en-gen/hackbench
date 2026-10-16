Ruled 2026-10-15 (Brian)

# Interpret what you can read; warn or error on what you cannot

## Question

When ROM data is non-stock but its shape can be read, does the app follow it or refuse it? (Decisions, D57 calls 8 and 9; first application #933, the layer 2 skip chain).

## Options considered

1. Fail closed: refuse non-stock data even when its shape is readable. Not chosen: this ruling replaces it. `[INF]`
2. Interpret readable data, warn or error on the rest. Chosen by the owner's ruling.

## Ruling

2026-10-15, verbatim from Brian via Decisions, D57 calls 8 and 9:

> "If you can interpret, interpret. If you can't, show a warning or error."

## Why

The owner's words above are the only recorded reason.

## Applies to

Any ROM data the app reads. When the data's shape can be read, the app follows what it says, including changed or extended hack data. Only data it cannot read gets a warning or error. This replaces fail-closed refusals of data that is non-stock but readable. First application: #933 (the layer 2 skip chain). Today's reader still refuses a non-stock skip chain as `unrecognized` (`src/rom/L2Loader.ts`, `src/rom/model/L2Model.ts`); #933 changes this to interpreting a readable chain.

Reading data that another tool wrote into a ROM (an AddmusicK driver, a Lunar Magic hook) is interpretation under this record, not reuse of that tool's code (see `2026-10-16-third-party-code.md`).
