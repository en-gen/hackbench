Proposed 2026-11-13 (Bravo)

# An unreadable Object file gets a "Remove file" button

## Question

A file in meta/objects/ that cannot be read is skipped with a note. Can the user get rid of it from the app? ([#1236](https://github.com/en-gen/hackbench/issues/1236))

## Options considered

A. No: the note tells the user to delete the file by hand.
B. A "Remove file" button on the note, behind the same two-click confirm as Delete.

## Ruling

wording not recorded. 2026-11-13: option B, added in #1236 after the adversarial review, as [PROP]. It is not an owner ruling. [INF]

## Why

- A refused save names the unreadable file and says to remove it; without the button the app asks for something it cannot do. [EST] The review found the wording ("Delete it") with no way to do it.
- The button only appears when the file name is a usable id, because the delete is by id and a name like `ABC12345.json` is left to the user. [INF]
- It deletes that one file and reads nothing, so it needs no ROM. [INF]
- If overruled for A: drop the button and keep the note text pointing at the folder.

## Applies to

Skipped-file notes in the Objects activity (#1236).
Promotion to Ruled is the owner's.
