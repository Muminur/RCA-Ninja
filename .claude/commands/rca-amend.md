---
description: Re-generate an existing RCA with an optional correction hint.
allowed-tools: Bash
argument-hint: '<id> [hint text]'
---

Parse $ARGUMENTS: first token is the RCA id (short hash, basename, or full path).
Remaining tokens (if any) are the correction hint.

Run: `claude-rca amend <id> ${hint:+--hint "$hint"}`

Then read the returned path, cat it, and present:

1. The updated path
2. A 1-line summary (the title)
3. The confidence level from the frontmatter

Do not modify the RCA manually.
