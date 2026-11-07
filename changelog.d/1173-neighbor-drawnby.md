### Fixed

- Maps view (#1173): a sprite whose list entry has the extra bit is no longer seeded as a stock neighbor of a scanning sprite, and a sprite drawn by its parent is hit only through that parent, never alone where the parent has no pixel; the paint off the map skips such a sprite too.
- Maps view (#1173): a scanning sprite beside an extra-bit entry is marked unverified, even when no stock neighbor is left.
