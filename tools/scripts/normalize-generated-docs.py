"""
Normalise em-dashes to regular dashes inside GitNexus-managed doc regions.

`gitnexus analyze` rewrites the text between the gitnexus:start and
gitnexus:end markers in CLAUDE.md and AGENTS.md, and the text it generates
uses em-dashes. This repo's pre-commit gate blocks em-dashes in added lines,
so every refresh would otherwise leave an uncommittable working tree. This
makes the generator and the gate stop fighting.

Only the managed region is touched. The rest of each file is hand-written, and
a blanket substitution would rewrite prose nobody asked it to.

Written in Python rather than awk or sed because awk's gsub takes a REGEX and
a multi-byte UTF-8 character there silently matches nothing under a C locale.
The first version of this used awk, changed no bytes, and reported success.
"""
import io
import sys

EM_DASH = "—"
START = "<!-- gitnexus:start -->"
END = "<!-- gitnexus:end -->"


def normalize(path: str) -> int:
    """Rewrite `path` in place. Returns the number of dashes replaced."""
    try:
        text = io.open(path, encoding="utf-8").read()
    except FileNotFoundError:
        return 0

    out, inside, replaced = [], False, 0
    for line in text.split("\n"):
        if START in line:
            inside = True
        if inside:
            replaced += line.count(EM_DASH)
            line = line.replace(EM_DASH, "-")
        if END in line:
            inside = False
        out.append(line)

    io.open(path, "w", encoding="utf-8", newline="\n").write("\n".join(out))
    return replaced


if __name__ == "__main__":
    paths = sys.argv[1:] or ["CLAUDE.md", "AGENTS.md"]
    total = sum(normalize(p) for p in paths)
    print(f"normalize-generated-docs: {total} em-dash(es) replaced")
