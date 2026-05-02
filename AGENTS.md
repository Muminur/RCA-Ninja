# AGENTS.md — AI Discovery Guide for claude-rca

This file helps AI assistants (Claude, Codex, Cursor, etc.) navigate the RCA corpus and project tooling efficiently.

---

## Project Overview

`claude-rca` is a local-first CLI that turns bug-fix commits into structured Root Cause Analysis Markdown artifacts. It orchestrates Claude Code in headless bare mode with a pinned JSON schema to produce validated, searchable RCA documents.

---

## RCA Corpus Location

All generated RCA files are stored under:

```
rca/YYYY/MM/RCA-<date>-<short_hash>-<slug>.md
```

Example: `rca/2026/04/RCA-2026-04-25-a3f2c1d-session-null-pointer.md`

Each file has YAML frontmatter with fields: `title`, `date`, `ref`, `branch`, `confidence`, `files`, `tags`, `schema`, `generated_by`.

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

Use `rg` (ripgrep) for efficient full-text search across the corpus:

```bash
# Full-text search across all RCAs
rg "null pointer" rca/

# Filter by tag in frontmatter
rg -l "tags:.*\bauth\b" rca/ | xargs rg "session"

# Filter by specific component
rg -l "components:.*\bauth-service\b" rca/

# Search within a date range (by directory)
rg "timeout" rca/2026/04/

# Find RCAs referencing a specific file
rg -l "src/middleware/auth.js" rca/

# Find all high-confidence RCAs
rg -l "confidence: high" rca/
```

Use the CLI for structured retrieval:

```bash
# Search with tag filtering
./bin/claude-rca search "session timeout" --tag auth

# List recent RCAs
./bin/claude-rca recent 10

# Show a specific RCA by ID or short hash
./bin/claude-rca show a3f2c1d
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
rca/                    # RCA output corpus (YYYY/MM/ subdirs)
rca/_manifest.yaml      # Machine-readable index of all RCAs
src/                    # CLI source modules (.mjs, ESM only)
prompts/                # rca-system.md (system prompt), rca-schema.json (schema)
.claude/                # Claude Code commands, agents, settings, rules
test/                   # Unit, integration, and e2e tests
docs/                   # PRD, architecture, troubleshooting
```

---

## Key Conventions for AI Assistants

1. **Read `rca/_manifest.yaml` first** to get an overview before loading individual RCA files.
2. **Use `rg` for filtering** — it is always available and handles large corpora efficiently.
3. **Only read full RCA files when the manifest indicates they are relevant** to the query.
4. **Do not modify `.obsidian/`** files or any RCA files directly — the CLI handles all writes.
5. **Schema is enforced** — all RCA files conform to `prompts/rca-schema.json`. Frontmatter fields are stable and machine-readable.
6. **Tags and components** in frontmatter are the primary axes for filtering. Prefer `rg -l "tags:.*\bfoo\b" rca/` over loading all files.
