---
description: Root Cause Analysis tools. Subcommands: generate, search, recent, show, audit, amend, trends, doctor.
allowed-tools: Bash, Read
---

You are dispatching an RCA subcommand. Parse $ARGUMENTS:

- "generate" or empty → run `claude-rca generate` and report the path.
- "search <query>" → run `claude-rca search <query>` and summarize hits.
- "recent" or "recent <n>" → run `claude-rca recent <n>`.
- "show <id-or-path>" → run `claude-rca show <id-or-path>`.
- "audit" → run `claude-rca audit --json`; list degraded RCAs and clean count.
- "amend <id>" or "amend <id> <hint>" → run `claude-rca amend <id>` with optional `--hint`; report updated path.
- "trends" → run `claude-rca trends`; summarize top tags, hotspot files, recurrent patterns.
- "doctor" → run `claude-rca doctor`; map failures to fix commands; auto-fix stale lockfile if present.

Use the Bash tool. Do not generate the RCA yourself — always shell out to
`claude-rca`. The CLI handles prompt construction and schema enforcement.

If `claude-rca` is not on PATH, instruct the user to run `npm i -g
claude-rca` and stop.
