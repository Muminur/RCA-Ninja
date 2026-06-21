# AGENTS.md — AI Discovery Guide for claude-rca

This file helps AI assistants (Claude, Codex, Cursor, etc.) navigate the RCA corpus and project tooling efficiently.

---

## Project Overview

`claude-rca` is a local-first, LLM-agnostic CLI that turns bug-fix commits into structured Root Cause Analysis Markdown artifacts. It drives a headless coding-agent CLI — Claude Code (`claude -p`) or OpenAI Codex (`codex exec`), selectable via `provider` in `.claude-rca.json` — with a pinned JSON schema to produce validated, searchable RCA documents. All LLM-specific logic is isolated in `src/providers/`.

---

## RCA Corpus Location

All generated RCA files are stored under:

```
rca/YYYY/MM/RCA-<date>-<short_hash>-<slug>.md
```

Example: `rca/2026/04/RCA-2026-04-25-a3f2c1d-session-null-pointer.md`

Each file has YAML frontmatter with fields: `title`, `date`, `ref`, `branch`, `confidence`, `files`, `tags`, `schema`, `generated_by`.

> **Note:** `rca/` is listed in `.claudeignore`, so Claude Code will not scan RCA files during normal coding tasks. Use the dedicated search commands below to find related RCAs.

---

## Manifest Index

A machine-readable index of all RCA files is maintained at:

```
rca/_manifest.yaml
```

**Always read `rca/_manifest.yaml` first** before searching individual files. It contains a sorted (newest-first) list of all RCAs with their key metadata fields (`id`, `title`, `date`, `ref`, `confidence`, `tags`, `components`, `files`, `description`, `path`). Use it to identify which files are worth reading in full.

To rebuild the manifest after adding or modifying RCA files, run:

```bash
./bin/claude-rca rebuild-manifest
```

---

## Searching the RCA Corpus

Because `rca/` is in `.claudeignore`, it will not appear in incidental Claude Code searches. Use the dedicated CLI commands for manifest-first retrieval:

```bash
# Find RCAs related to a specific source file (manifest-first)
./bin/claude-rca search --files src/middleware/auth.js

# Search by tag
./bin/claude-rca search --tag auth

# Full-text search
./bin/claude-rca search "session timeout"

# List recent RCAs
./bin/claude-rca recent 10

# Show a specific RCA by ID or short hash
./bin/claude-rca show a3f2c1d
```

Use `rg` (ripgrep) for ad-hoc full-text queries when the CLI is insufficient:

```bash
# Full-text search across all RCAs
rg "null pointer" rca/

# Filter by tag in frontmatter
rg -l "tags:.*\bauth\b" rca/ | xargs rg "session"

# Filter by specific component
rg -l "components:.*\bauth-service\b" rca/

# Search within a date range (by directory)
rg "timeout" rca/2026/04/

# Find all high-confidence RCAs
rg -l "confidence: high" rca/
```

---

## CLI Commands Reference

```bash
# Generate an RCA for the current commit
./bin/claude-rca generate

# Generate for a specific commit
./bin/claude-rca generate --ref HEAD~1

# Dry run (show path without writing)
./bin/claude-rca generate --dry-run

# Search the corpus
./bin/claude-rca search <query> [--tag <tag>] [--since <date>] [--json]

# List recent RCAs
./bin/claude-rca recent [N]

# Show a specific RCA
./bin/claude-rca show <id|path>

# Audit for degraded RCAs (auto-filled fields)
./bin/claude-rca audit [--json]

# Environment health check
./bin/claude-rca doctor
```

---

## Project Layout

```
rca/                    # RCA output corpus (YYYY/MM/ subdirs) — claudeignored
rca/_manifest.yaml      # Machine-readable index of all RCAs
src/                    # CLI source modules (.mjs, ESM only)
prompts/                # rca-system.md (system prompt), rca-schema.json (schema)
.claude/                # Claude Code commands, agents, settings, rules
.claudeignore           # Excludes rca/ from incidental Claude Code scans
test/                   # Unit, integration, and e2e tests
docs/                   # PRD, architecture, troubleshooting
```

---

## Key Conventions for AI Assistants

1. **Read `rca/_manifest.yaml` first** to get an overview before loading individual RCA files.
2. **Use `claude-rca search --files <path>`** to find RCAs affecting the file you are debugging — this is the primary manifest-first search workflow.
3. **Use `rg` for ad-hoc filtering** — it is always available and handles large corpora efficiently.
4. **Only read full RCA files when the manifest indicates they are relevant** to the query.
5. **Do not modify `.obsidian/`** files or any RCA files directly — the CLI handles all writes.
6. **Schema is enforced** — all RCA files conform to `prompts/rca-schema.json`. Frontmatter fields are stable and machine-readable.
7. **Tags and components** in frontmatter are the primary axes for filtering. Prefer `rg -l "tags:.*\bfoo\b" rca/` over loading all files.
