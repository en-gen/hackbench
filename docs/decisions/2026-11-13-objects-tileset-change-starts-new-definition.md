Proposed 2026-11-13 (Bravo)

# Changing the tileset of a saved Object starts a new Object

## Question

The user opens a saved Object and picks another tileset. Does Save overwrite the saved Object, or start a new one? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. Keep the saved Object open, clear its tags, and let Save overwrite it.
B. The editor becomes a new, unsaved Object (tags cleared, name kept); the saved Object is untouched.

## Ruling

wording not recorded. 2026-11-13: option B, built in #1236 after the adversarial review, as [PROP]. It is not an owner ruling. [INF]

## Why

- The same tile number is a different tile on another tileset, so the tags cannot carry over and clearing them is already needed. [EST] Stated in the Object design (#1234, an Object belongs to one tileset).
- With A one stray tileset click followed by Save would silently empty a saved Object. [INF]
- The name is kept so making a copy for another tileset is one step. [INF]
- If overruled for A: Save after a tileset change would overwrite the saved file, with the tags cleared.

## Applies to

The Objects activity editor (#1236). A saved file is never rewritten by a tileset pick alone.
Promotion to Ruled is the owner's.
