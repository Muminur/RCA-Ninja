---
description: Audit RCA corpus for degraded (auto-filled) documents.
allowed-tools: Bash
---

Run: `claude-rca audit --json`

Parse the JSON output. If `degraded` array is non-empty:

- List each degraded RCA's filename and which fields were auto-filled.
- Summarise: "N RCAs need attention."

If clean: print "All RCAs pass quality audit (N clean)."
