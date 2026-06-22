# Codex RCA / RCA-Ninja: Root Cause Analysis CLI for AI Coding Agents

**Codex RCA** is a local-first **root cause analysis (RCA)** tool for software teams and AI coding agents. It turns bug-fix commits into structured, searchable postmortem Markdown files so Codex, Claude, Cursor, and other assistants can find previous incidents before they repeat the same mistake.

Suggested GitHub repository description:

> Root cause analysis (RCA) CLI for AI coding agents. Generate searchable postmortems from git diffs with Codex/Claude workflows, MCP tools, hooks, and Obsidian sync.

## Why This RCA Tool Exists

Most root cause analysis work gets lost in chat history, pull request comments, or incident documents that an AI agent cannot reliably find later. Codex RCA keeps each RCA close to the repository as plain Markdown with YAML frontmatter, a manifest index, full-text search, and optional MCP tools.

Use it when you want:

- A root cause analysis report after every `fix:` commit.
- A searchable RCA knowledge base for recurring bugs.
- A lightweight postmortem workflow for GitHub projects.
- Codex and Claude access to prior RCA documents through CLI or MCP.
- Obsidian sync for engineering notes and incident reviews.

## What Is Root Cause Analysis (RCA)?

Root cause analysis is the process of identifying why a bug, outage, regression, or incident happened, not just what changed. A useful software RCA captures the symptom, impact, root cause, fix, prevention steps, affected files, confidence, and follow-up work. Codex RCA standardizes that structure so humans and AI agents can search it later.

## Features

| Capability         | What It Does                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| RCA generation     | Generates structured root cause analysis Markdown from git commit context                          |
| Codex-friendly CLI | Provides `codex-rca` as the primary command and keeps `claude-rca` as a compatibility alias        |
| MCP server         | Exposes RCA tools such as `rca_search`, `rca_recent`, `rca_show`, `rca_trends`, and `rca_generate` |
| Searchable corpus  | Stores RCA files under `rca/YYYY/MM/` with manifest and `llms.txt` indexes                         |
| Git hooks          | Can automatically generate RCA documents after `fix:` commits                                      |
| Quality checks     | Audits RCA documents for missing or auto-filled fields                                             |
| Obsidian sync      | Optionally copies RCA notes to an Obsidian vault or REST API                                       |

## Install

```bash
npm install -g codex-rca
```

From this repository:

```bash
git clone https://github.com/Muminur/RCA-Ninja.git codex-rca
cd codex-rca
npm install
npm link
```

Both commands work after linking:

```bash
codex-rca --version
claude-rca --version
```

## Quick Start

```bash
codex-rca init
codex-rca config --set auto_generate=true
codex-rca generate --from HEAD
codex-rca search "null pointer"
codex-rca recent 5
codex-rca show <id-or-short-hash>
codex-rca trends
```

The legacy command remains valid:

```bash
claude-rca generate --from HEAD
claude-rca search --files src/api/routes.py
```

## Codex Setup

Codex can use Codex RCA through its CLI and MCP server. Add an MCP server entry to your Codex config.

Windows example:

```toml
[mcp_servers.rca_ninja]
command = "cmd.exe"
args = ["/c", "codex-rca", "--cwd", "D:\\path\\to\\your\\repo", "mcp-server"]
```

macOS/Linux example:

```toml
[mcp_servers.rca_ninja]
command = "codex-rca"
args = ["--cwd", "/path/to/your/repo", "mcp-server"]
```

Useful agent workflow:

```text
Before fixing a bug, search prior RCAs:
1. codex-rca search --files <file-you-are-editing>
2. codex-rca search "<symptom or error>"
3. codex-rca show <matching-id>
4. Apply the fix with the prior root cause in mind.
```

## LLM Provider Setup

RCA generation is **provider-agnostic**: choose Claude Code or OpenAI Codex with the `provider` config (default `claude`). All provider-specific logic lives in `src/providers/`.

```bash
# Claude Code (default)
npm install -g @anthropic-ai/claude-code && claude login

# OpenAI Codex
npm install -g @openai/codex && codex login
codex-rca config --set provider=codex

codex-rca doctor   # verifies the configured provider's binary is installed
```

If both providers are configured, generation automatically **falls back** to the other when the primary fails (e.g. Claude → Codex). Search, recent/show/trends, hooks, and MCP work identically regardless of provider.

## RCA Output

Generated RCA documents are stored as Markdown:

```text
rca/YYYY/MM/RCA-<date>-<short_hash>-<slug>.md
```

Each document includes frontmatter like:

```yaml
title: Session timeout after refresh
date: 2026-06-02
ref: a3f2c1d
branch: main
confidence: high
files:
  - src/session.js
tags:
  - rca
  - regression
generated_by: claude-rca/0.1.0
schema: claude-rca.rca.v1
```

The content includes sections for Summary, Impact, Root Cause, Fix, Prevention, and References.

## Commands

| Command                                | Purpose                                                |
| -------------------------------------- | ------------------------------------------------------ |
| `codex-rca init`                       | Create `.claude-rca.json`, `rca/`, and git hooks       |
| `codex-rca setup`                      | Interactive setup for hooks, Obsidian, and environment |
| `codex-rca generate --from HEAD`       | Generate an RCA for a commit                           |
| `codex-rca generate --since v1.0.0`    | Batch-generate RCAs for `fix:` commits                 |
| `codex-rca search "query"`             | Full-text search the RCA corpus                        |
| `codex-rca search --files src/file.js` | Find RCAs touching a file                              |
| `codex-rca recent 10`                  | List recent RCA files                                  |
| `codex-rca show <id>`                  | Show an RCA by ID, filename, path, or short hash       |
| `codex-rca trends`                     | Show hot files, top tags, and recurring areas          |
| `codex-rca audit`                      | Check RCA quality                                      |
| `codex-rca amend <id> --hint "..."`    | Regenerate an RCA with correction guidance             |
| `codex-rca mcp-server`                 | Start the MCP server                                   |
| `codex-rca doctor`                     | Check Node, git, ripgrep, Claude CLI, and RCA state    |

## Project Layout

```text
bin/
  codex-rca          # Codex-facing CLI entry point
  claude-rca         # Backward-compatible CLI entry point
src/                 # ESM source modules
prompts/             # RCA system prompt and JSON schema
hooks/               # Git hook templates
rca/                 # Generated RCA corpus in user projects
test/                # Unit, integration, and e2e tests
```

## SEO Keywords Covered Naturally

This repository is built around root cause analysis, RCA, RCA tool, root cause analysis software, incident postmortem, bug root cause, regression analysis, GitHub RCA, AI coding agent RCA, Codex RCA, Claude RCA, software incident analysis, and postmortem automation.

## Notes

- GitHub repository search visibility also depends on the repository description and topics. Set the description shown above in GitHub settings and add topics such as `root-cause-analysis`, `rca`, `codex`, `ai-agents`, `postmortem`, `incident-response`, and `developer-tools`.
- The config file remains `.claude-rca.json` for backward compatibility.
- The generated RCA schema still uses `claude-rca.rca.v1` to avoid breaking existing corpora.

## License

MIT
