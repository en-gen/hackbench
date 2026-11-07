# Runbooks

Methods, each estate-agnostic and written so a fresh agent can follow it without the conversation that produced it. Read the runbook before re-deriving the method.

| Runbook                                                    | Use when                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [morning-brief.md](morning-brief.md)                       | night shift ended and the owner needs the decisions          |
| [owner-launch.md](owner-launch.md)                         | a UI change needs the owner's eyes                           |
| [ci-rerun.md](ci-rerun.md)                                 | a CI run must be repeated                                    |
| [merge-detection.md](merge-detection.md)                   | an agent must know when a PR merged                          |
| [outside-contributors.md](outside-contributors.md)         | a PR, issue or comment comes from outside the project        |
| [state-cutover.md](state-cutover.md)                       | the session state folder moves and every session must switch |
| [board.md](board.md)                                       | moving cards or querying the project board                   |
| [repo-migration.md](repo-migration.md)                     | a number or SHA from before 2026-09-27 turns up              |
| [smwc-api.md](smwc-api.md)                                 | SMW Central content must be looked up                        |
| [../../tools/mesen/README.md](../../tools/mesen/README.md) | a Mesen capture is needed                                    |
