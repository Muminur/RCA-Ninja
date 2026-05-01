---
description: Generate an RCA for the most recent commit (or a given ref).
allowed-tools: Bash, Read
argument-hint: '[ref]'
---

Run: `claude-rca generate ${ARGUMENTS:+--from $ARGUMENTS}`

Then read the resulting RCA path from stdout, `cat` it, and present:

1. The path
2. A 1-line summary (the title)
3. The confidence level from the frontmatter

Do not modify the RCA. Do not regenerate if it already exists; ask the
user if they want to delete and regenerate.
