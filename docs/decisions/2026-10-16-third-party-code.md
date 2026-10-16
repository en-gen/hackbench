Ruled 2026-10-16 (Brian)

# Reusing other authors' code: the middle ground

## Question

May HackBench reuse other people's open-source code, and how is the author dealt with? (Decisions, D71 call 2, #952; filed as #934.)

## Options considered

1. Never reuse other authors' code. The owner's first ruling. `[INF]`
2. Reuse open-source code whose licence fits, with credit. Chosen: "middle ground".

## Ruling

History, 2026-10-16, verbatim from Brian via Decisions. First, strictly (D71 call 2, #952): "yes always. even if established plugins are open source, I think it'd be presumptuous". Then he asked Decisions to "definitely evaluate if my stance on this is unwarranted and open source software is free to resuse", and ruled "middle ground". Then: "you never reachout to a project's maintainer on my behalf".

1. Reuse open-source code whose licence fits HackBench's MIT licence (permissive or LGPL), on its terms, with visible credit in the app (#953) and in `THIRD_PARTY_LICENSES.md`. The heads-up to the maintainer is the owner's own to send.
2. Never reuse unlicensed or "do not redistribute" tools. Write our own, or the owner may invite the author to package a HackBench extension (#943).
3. No strong-GPL code.
4. Any upstream PR (for example Asar's WebAssembly build, #938) is opened by the owner, not an agent; teams prepare only the branch and the description.

**No agent contacts an outside project or its maintainer through any channel** (issues, PRs, comments, email, chat, forums). Teams prepare the material and hand it to the owner.

Compatible licences: permissive (MIT, BSD, Apache-2.0, zlib); LGPL with dynamic or separate use (a separately loaded library or module the user could replace). Strong GPL, unlicensed and no-redistribute are not.

## Why

The owner's words above are the only recorded reason.

## Applies to

- In-app credit lives in the About and credits view, filed as #953; none exists yet. `THIRD_PARTY_LICENSES.md` is the other place.
- HackBench already ships `@smwcentral/spc-player` (LGPL-2.1, Telinc1).
- Asar (D61 call 1; #937, #938) is allowed under rule 1 if its licence fits; #938 reads the licence before anything ships.
- Reading data another tool wrote into a ROM (an AddmusicK driver, a Lunar Magic hook) is interpretation, not reuse: see `2026-10-15-interpret-else-warn.md`.
- Affected open items (noted on the issues by Planning, 2026-10-16): #54, #59, #60, #61, #62, #201, #881, #940, #937, #938.
- Related: #943.
