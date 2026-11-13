Proposed 2026-11-13 (Bravo)

# Object definitions are one file each, in meta/objects/

## Question

Where do saved Object definitions live: one list file beside groups.json, or one file per definition? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. One `meta/objects.json` holding a list, like `groups.json`.
B. One file per definition, `meta/objects/<id>.json`.

## Ruling

wording not recorded. 2026-11-13: option B, approved by Overwatch at the plan gate (not the owner), built in #1236. [PROP] It is not an owner ruling. [INF]

## Why

- A damaged `groups.json` is one error for the whole file, and the project server then refuses to overwrite it (`src/project/MapGroups.ts:112-120`, `theia/extension/src/node/project-server.ts:301-312`). With a list of Objects one bad entry would hide every Object, and a save would have to read, merge and rewrite a file it could not parse. [EST] Read in the #1236 survey, one commit.
- With one file each a damaged file takes only itself out, and a save never rewrites a file it could not read. [INF]
- The cost is a folder to list and many small files; the reader skips non-`.json` entries and leftover temp files from `writeFileAtomic`. [INF]
- If overruled for A: `docs/architecture/object-definitions.md` and `src/project/ObjectDefinitions.ts` change shape, and #1237 reads one file.

## Applies to

Object definitions only (#1236, read by #1237). Not groups, aliases or data-banks.
Promotion to Ruled is the owner's.
