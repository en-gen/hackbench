### Added

- Agent definitions for the four coordinating main sessions, Planning, Decisions, Overwatch and
  Testing, in `.claude/agents/`, so each starts with `claude --agent <name>` and carries its role
  rules in the repo instead of only in one machine's memory notes.
- Agent workflow rules in `CLAUDE.md`: start from files, a done contract graded per criterion, no
  deleting or weakening a failing test to get green, Mermaid diagrams in docs, and pruning harness
  parts that stop catching anything. Tech-lead state files gain a "Tried and failed" line.
