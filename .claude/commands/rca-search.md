---
description: Search RCA corpus.
allowed-tools: Bash
argument-hint: '<query>'
---

Run: `claude-rca search "$ARGUMENTS"`

Present hits as a numbered list, each with:

- File basename
- Line number and matched line
- Date from the filename

Limit to 20 hits. If more, suggest narrowing the query.
