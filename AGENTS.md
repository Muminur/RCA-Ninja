# AGENTS.md - AI Discovery Guide for Codex RCA

This file helps AI assistants such as Codex, Claude, Cursor, and other coding agents navigate the RCA corpus and project tooling efficiently.

## Project Overview

`codex-rca` is a local-first root cause analysis (RCA) CLI. It turns the commits that its `triggers` config matches — bug fixes by default, plus any commit whose body closes an issue — into structured, searchable Markdown postmortems, and exposes RCA lookup tools through CLI commands and MCP.

`claude-rca` remains a backward-compatible command alias. The config file remains `.claude-rca.json` so existing installations and RCA corpora keep working.

## RCA Corpus Location

Generated RCA files are stored under:

```text
rca/YYYY/MM/RCA-<date>-<short_hash>-<slug>.md
```

Example:

```text
rca/2026/04/RCA-2026-04-25-a3f2c1d-session-null-pointer.md
```

Each file has YAML frontmatter with stable fields such as `title`, `date`, `ref`, `branch`, `confidence`, `files`, `tags`, `schema`, and `generated_by`.

`ref` is always a **quoted** string (`ref: "a3f2c1d"`). Parse it as text, never as
a number: unquoted, YAML reads `0012345` as octal `5349` and `123e456` as
`Infinity`. `bug_introduced_by`, when present, names the commit that wrote the
lines the fix deleted, decided by a blame vote over those lines.

## Manifest And AI Index

Machine-readable indexes are maintained at:

```text
rca/_manifest.jsonl
rca/llms.txt
```

Read these first before loading individual RCA files. They provide recent RCA entries, metadata, file paths, tags, and snippets.

To rebuild indexes after editing RCA files:

```bash
codex-rca rebuild
```

## Searching The RCA Corpus

Use the dedicated CLI commands for manifest-first retrieval:

```bash
codex-rca search --files src/middleware/auth.js
codex-rca search --tag auth
codex-rca search "session timeout"
codex-rca recent 10
codex-rca show a3f2c1d
codex-rca trends
```

The legacy command also works:

```bash
claude-rca search --files src/middleware/auth.js
```

Use `rg` for ad-hoc filtering when the CLI is insufficient:

```bash
rg "null pointer" rca/
rg -l "confidence: high" rca/
rg "timeout" rca/2026/04/
```

## Codex MCP Setup

For Codex, configure the MCP server with the `codex-rca` command.

Windows:

```toml
[mcp_servers.rca_ninja]
command = "cmd.exe"
args = ["/c", "codex-rca", "--cwd", "D:\\path\\to\\repo", "mcp-server"]
```

macOS/Linux:

```toml
[mcp_servers.rca_ninja]
command = "codex-rca"
args = ["--cwd", "/path/to/repo", "mcp-server"]
```

## CLI Commands Reference

```bash
codex-rca init
codex-rca setup
codex-rca generate --from HEAD
codex-rca generate --from HEAD --if-triggered   # no-op unless the trigger config matches
codex-rca generate --since <ref> [--max <n>]    # batch; skips commits that already have an RCA
codex-rca generate --dry-run
codex-rca amend <id> --hint "..."
codex-rca rebuild [--fix] [--json]
codex-rca config --get <key> | --set <key=value> | --path
codex-rca search <query> [--tag <tag>] [--since <date>] [--json]
codex-rca recent [N]
codex-rca show <id|path>
codex-rca audit [--json]
codex-rca trends [--json]
codex-rca doctor
codex-rca mcp-server
```

## Project Layout

```text
bin/                    # codex-rca and claude-rca entry points
src/                    # CLI source modules
prompts/                # RCA system prompt and schema
hooks/                  # Git hooks
rca/                    # Generated RCA corpus in user projects
.claudeignore           # Excludes rca/ from incidental Claude Code scans
test/                   # Unit, integration, and e2e tests
examples/               # Sample RCA corpus
scripts/                # install.sh / install.ps1
```

## Agent Rules

1. Read `rca/llms.txt` or `rca/_manifest.jsonl` first to identify relevant RCA documents.
2. Use `codex-rca search --files <path>` before debugging a file that may have prior incidents.
3. Use `codex-rca show <id>` only after narrowing down the relevant RCA.
4. Do not rewrite the RCA schema unless the user explicitly asks for a schema migration.
5. Do not modify `.obsidian/` files directly. Use the CLI sync commands.
6. Treat generated RCA files as engineering records. Preserve dates, refs, confidence, and file lists unless correcting a known mistake. When hand-editing frontmatter, keep `ref` quoted — unquoting it lets YAML coerce a hash into a number.
7. RCAs also arrive through the `post-merge` hook, over `ORIG_HEAD..HEAD`. A squash-merged PR therefore has an RCA against the squash commit on the default branch, not against the branch commits it replaced — those no longer exist.
8. Generation runs the configured provider inside a throwaway workspace and falls back to the other one when it is missing, logged out, or rate limited. If none can run the command fails with `PROVIDER_UNAVAILABLE` naming each provider and why — log in and re-run rather than editing the RCA by hand.
9. What counts as RCA-worthy is `triggers.commit_types` (default `["fix"]`) plus `triggers.closes_issue` (default true, matching `Closes #12` anywhere in the message). Do not re-implement that rule; call `generate --if-triggered` and let the CLI decide.
