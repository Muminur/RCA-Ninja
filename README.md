# Codex RCA / RCA-Ninja: Root Cause Analysis CLI for AI Coding Agents

**Codex RCA** is a local-first **root cause analysis (RCA)** tool for software teams and AI coding agents. It turns bug-fix commits — and any commit that resolves a reported issue, including a squash merge landing on your default branch — into structured, searchable postmortem Markdown files, so Codex, Claude, Cursor, and other assistants can find previous incidents before they repeat the same mistake.

Suggested GitHub repository description:

> Root cause analysis (RCA) CLI for AI coding agents. Generate searchable postmortems from git diffs with Codex/Claude workflows, MCP tools, hooks, and Obsidian sync.

## Why This RCA Tool Exists

Most root cause analysis work gets lost in chat history, pull request comments, or incident documents that an AI agent cannot reliably find later. Codex RCA keeps each RCA close to the repository as plain Markdown with YAML frontmatter, a manifest index, full-text search, and optional MCP tools.

Use it when you want:

- A root cause analysis report after every commit the `triggers` config matches — `fix:` commits by default, plus any commit whose body closes an issue (`Closes #12`).
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
| Git hooks          | Generates RCAs after triggering commits (`post-commit`) and after a merge or pull (`post-merge`)   |
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
codex-rca config --set triggers.commit_types=fix,feat   # optional; default is fix
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

If both providers are installed, generation **falls back** to the other when the
configured one cannot run — not installed, logged out, or rate limited. Those
three are distinguished from "the model answered badly", which is retried on the
same provider instead, and only after extraction has already failed, so an RCA
that legitimately discusses a rate limit is never mistaken for a quota error.

When no provider can run, generation fails with `PROVIDER_UNAVAILABLE`, naming
each one and why:

```text
No usable LLM provider: claude (not logged in), codex (usage limited).
Log in (claude /login, codex login) and retry.
```

Search, recent/show/trends, hooks, and MCP work identically regardless of provider.

## Security & Configuration

- **Secrets live in `.env`, not config.** Put `OBSIDIAN_API_KEY` in a gitignored `.env` beside your `.claude-rca.json`; it is loaded automatically. `config --set obsidian.api_key` is refused, and a plain `config` dump redacts the key.
- **Read-only generation.** The provider is invoked with `allowed_tools: "Read"` (the RCA prompt needs nothing more) and `permission_mode: plan`.
- **Providers run in a throwaway workspace.** Every invocation gets a fresh temporary directory as its cwd and as `TEMP`/`TMP`/`TMPDIR`/`APPDATA`/`LOCALAPPDATA`, and that directory is deleted afterwards. No API key, token, or repository variable is passed through, and nothing but the scanned payload reaches the process. The one documented exception is `HOME`/`USERPROFILE`: both CLIs keep their login there, so redirecting it does not sandbox the provider, it logs it out. See `CREDENTIAL_ENV_KEYS` in `src/providers/shared.mjs`. `codex-rca doctor` verifies this rather than asserting it.
- **Search is injection-safe.** The search query is bound as a ripgrep pattern with `-e … --`, so a query starting with `-` can never be interpreted as a ripgrep option (notably `--pre`, which would execute a program).
- **MCP paths are contained.** `rca_show` and `rca_sync_to_vault` confine caller-supplied paths to `output_dir`, since MCP arguments come from a model. The equivalent CLI commands stay unrestricted.
- **Config is discovered upward.** Running from a subdirectory finds the project's `.claude-rca.json` by walking up to the git repo root — and, from a linked worktree, falls back to the main checkout. `output_dir` resolves against the directory that owns the config. Invalid config fails fast rather than being silently used.
- **Git short hashes stay strings.** `ref` is emitted quoted (`ref: "a3f2c1d"`), because YAML would otherwise read `0012345` as octal and `123e456` as `Infinity`. Keep it quoted when hand-editing frontmatter.

### Secret scanning and fail-closed behavior

`codex-rca generate` and every auto-generated hook path require a successful
secret scan before producing an RCA. If the scanner cannot be invoked safely,
returns malformed output, or reports findings, generation fails closed with:

- `SECRET_SCAN_FAILED`
- `SECRETS_DETECTED`
- `SECRET_SCANNER_UNAVAILABLE`

This is intentional and defensive: generation does not continue when scanning
cannot be trusted. In `--since` batch mode a scanner failure stops that commit,
and the run reports it rather than writing a partial RCA.

When `auto_generate` is `true`, a failed scanner blocks generation so the hook
emits a warning and produces no RCA. Set `auto_generate=false` to opt out of
automatic generation for that repository.

For the Claude provider, generation strips top-level schema metadata (currently
`$schema`) before passing schema JSON to `--json-schema`, to avoid known
compatibility issues in some Claude CLI versions.

## RCA Output

Generated RCA documents are stored as Markdown:

```text
rca/YYYY/MM/RCA-<date>-<short_hash>-<slug>.md
```

Each document includes frontmatter like:

<!-- prettier-ignore -->
```yaml
title: Session timeout after refresh
date: 2026-06-02
ref: "a3f2c1d"
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

`ref` is always emitted as a **quoted** string. A git short hash is opaque, but
YAML reads an unquoted one as a number whenever it looks like one — `0012345`
becomes `5349` (octal), `123e456` becomes `Infinity`, `0x12345` becomes `74565`.
Keep it quoted when hand-editing frontmatter; the reader recovers the verbatim
text for documents written before this was fixed.

`bug_introduced_by`, when present, names the commit that wrote the lines this fix
deleted. It is derived by blaming those exact lines across every changed file and
pooling one vote per line, so an unrelated `README.md` edit in the same commit
cannot outvote the real site of the defect.

## Commands

| Command                                | Purpose                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `codex-rca init`                       | Create `.claude-rca.json`, `rca/`, and the `post-commit`, `post-merge`, and `commit-msg` hooks |
| `codex-rca setup`                      | Interactive setup for hooks, Obsidian, and environment                                         |
| `codex-rca generate --from HEAD`       | Generate an RCA for a commit                                                                   |
| `generate --from HEAD --if-triggered`  | Generate only if the commit matches the trigger config                                         |
| `codex-rca generate --since v1.0.0`    | Batch-generate for every triggering commit since a ref                                         |
| `generate --since <ref> --max <n>`     | Cap one batch run (default 10); re-run for the rest                                            |
| `codex-rca search "query"`             | Full-text search the RCA corpus                                                                |
| `codex-rca search --files src/file.js` | Find RCAs touching a file                                                                      |
| `codex-rca recent 10`                  | List recent RCA files                                                                          |
| `codex-rca show <id>`                  | Show an RCA by ID, filename, path, or short hash                                               |
| `codex-rca trends`                     | Show hot files, top tags, and recurring areas                                                  |
| `codex-rca audit`                      | Check RCA quality                                                                              |
| `codex-rca amend <id> --hint "..."`    | Regenerate an RCA with correction guidance                                                     |
| `codex-rca mcp-server`                 | Start the MCP server                                                                           |
| `codex-rca doctor`                     | Check Node, git, ripgrep, Claude CLI, and RCA state                                            |

## Exit Codes

Every failure exits with a stable code, so a hook or CI step can branch on it
instead of parsing text. The message always names the code.

| Exit  | Meaning                                                                             |
| ----- | ----------------------------------------------------------------------------------- |
| `0`   | Success.                                                                            |
| `10`  | `ALREADY_INIT` — the repository is already initialized.                             |
| `20`  | `NO_DIFF` — the ref has no diff to analyze.                                         |
| `21`  | `CLAUDE_FAILURE` — the provider ran and exited non-zero.                            |
| `22`  | `SCHEMA_VALIDATION` — the provider answered, but not against the schema.            |
| `23`  | `WRITE_CONFLICT` — an RCA already exists for that commit.                           |
| `24`  | `DISK_ERROR` — a filesystem operation failed.                                       |
| `25`  | `TOKEN_BUDGET_EXCEEDED` — the payload exceeds `token_budget.hard_limit`.            |
| `26`  | `SECRETS_DETECTED` — the diff looks like it carries a secret.                       |
| `30`  | `RIPGREP_MISSING` — `rg` is not on `PATH`.                                          |
| `31`  | `SECRET_SCANNER_UNAVAILABLE` — no approved scanner; the provider was not called.    |
| `32`  | `SECRET_SCAN_FAILED` — the scanner itself blocked the run.                          |
| `33`  | `PROVIDER_ISOLATION_UNAVAILABLE` — the workspace boundary could not be established. |
| `34`  | `SEARCH_FAILED` — ripgrep or the manifest read failed.                              |
| `35`  | `PROVIDER_UNAVAILABLE` — every provider is missing, logged out, or rate limited.    |
| `40`  | `NOT_FOUND` — no RCA matches that ID.                                               |
| `41`  | `FORBIDDEN_PATH` — the path escapes `output_dir`.                                   |
| `50`  | `INVALID_CONFIG` / `INVALID_CONFIG_KEY` / `INVALID_CONFIG_VALUE`.                   |
| `60`  | `NO_VAULT` — Obsidian is enabled with no vault configured.                          |
| `61`  | `INVALID_VAULT` — the path is not an Obsidian vault.                                |
| `70`  | `DOCTOR_UNHEALTHY` — at least one `doctor` check failed.                            |
| `100` | `INTERNAL` — a bug; please file it.                                                 |

Codes in the 30s are environment faults: the command refused to reach the
provider rather than proceeding unsafely. `35` in particular is the one a
logged-out machine sees, and it resolves by logging in, not by changing config.

## Git Hooks

```bash
codex-rca init                       # per repo (also repairs a stale hook)
node hooks/install-hook.mjs <repo>   # same installer, explicit target
```

Three hooks are installed, all repository-local. Machine-wide installation via
`core.hooksPath` is deliberately **not** supported: the installer refuses a
hooks directory it does not own, and refuses to run with an inherited
`GIT_CONFIG*`, `GIT_DIR`, or `GIT_WORK_TREE` in the environment.

| Hook          | Fires on                 | Does                                                       |
| ------------- | ------------------------ | ---------------------------------------------------------- |
| `post-commit` | a local commit           | `generate --from HEAD --if-triggered`, in the background   |
| `post-merge`  | `git merge` / `git pull` | `generate --since <ORIG_HEAD> --max 10`, in the background |
| `commit-msg`  | any commit               | enforces Conventional Commits                              |

**Why `post-merge` exists.** `post-commit` only ever sees commits created
locally. When a project merges through GitHub, the merge is a squash performed
on the server, so the commit that lands on the default branch never passes
through a local hook — and the branch commits it replaced are deleted, taking
the refs any earlier RCAs pointed at with them. `post-merge` runs when that
squash commit arrives locally and generates against it. It resolves `ORIG_HEAD`
to a SHA before backgrounding, so a later git operation cannot move the range,
and `--since` skips commits that already have an RCA, so a replayed range costs
nothing. `RCA_POST_MERGE_MAX` overrides the per-run cap.

### What counts as an RCA-worthy commit

The rule lives in one place — the CLI — and the hooks delegate to it with
`generate --from HEAD --if-triggered`:

```bash
codex-rca config --set triggers.commit_types=fix,feat   # default: ["fix"]
codex-rca config --set triggers.closes_issue=false      # default: true
```

- `triggers.commit_types` — Conventional Commit types that trigger an RCA. Any
  scope and a `!` breaking marker are accepted (`fix(auth)!: …`).
- `triggers.closes_issue` — when true, a commit **also** triggers if its message
  contains a GitHub closing keyword (`Closes #12`, `Fixes #7`, `Resolves #142`).
  This is what catches a `feat:` commit that answered a reported bug: GitHub's
  squash-merge default puts the PR description in the commit **body**, so the
  whole message is matched, not just the subject.

`post-commit` still applies a cheap shell pre-filter first, so an ordinary
commit costs no node process. That pre-filter is a deliberate superset — any
`<type>:` subject or a closing keyword — never a second copy of the rule.

**A triggering commit that produces no RCA is always loud.** The hook writes an
`ERROR` line to `~/.claude-rca/hook.log` _and_ a warning on stderr, visible in
your `git commit` output. The one exception is a deliberate
`auto_generate: false`, which stays quiet. The two cases are distinguished with
`codex-rca config --path`, which prints the config file actually in use and
exits 1 when none resolves.

### Worktrees and subdirectories

Git runs hooks with the working directory set to the **root of the working
tree** — for a linked worktree, that is the worktree, not the main checkout.
Since `.claude-rca.json` is typically gitignored, it does not exist there.
Config resolution therefore falls back through:

1. `--config <path>`, if given
2. an upward walk from the cwd, **bounded at the repo top-level**
3. the main checkout, via `git rev-parse --git-common-dir`

A relative `output_dir` resolves against the directory of the config that
declared it, so RCAs generated from a worktree land in the main corpus rather
than inside the worktree, where they would be lost when it is removed.

### Making the hook unmissable

`.git/hooks/` is not version-controlled, so a fresh clone has no hook and fails
_silently_. Re-run `codex-rca init` after cloning, and again after upgrading —
the installer is idempotent and refreshes a hook it wrote earlier (it recognises
its own `# codex-rca-managed-hook:` marker), while refusing to clobber one it
did not write.

**If `core.hooksPath` is set anywhere but this repository's own config, these
hooks never run.** Git consults that directory instead of `.git/hooks/`, and the
installer refuses to write into a directory it does not own. Check it with:

```bash
git config --show-origin --get core.hooksPath
```

An earlier version of this project installed a global `post-commit` under
`~/.git-hooks`. That copy predates `post-merge` and `--if-triggered` entirely, so
a machine still carrying it silently gets the old `fix:`-only behaviour and no
squash-merge coverage. Remove it, or unset `core.hooksPath`, and re-run
`codex-rca init` per repository.

To audit any repo in one command, `codex-rca doctor` reports the pipeline itself
alongside the external tools — which config resolved, whether a `post-commit`
hook exists at the **effective** hooks directory (honouring `core.hooksPath`),
and whether `auto_generate` is on:

```text
config              ok    /path/to/repo/.claude-rca.json
hook                ok    /path/to/repo/.git/hooks/post-commit
secret-scanner      ok    gitleaks 8.30.1
provider-isolation  ok    workspace-isolated (12 env vars, scratch dirs redirected, no API keys)
auto-gen            ok    true — triggering commits generate RCAs automatically
```

`auto-gen` only reports `ok` when the scanner, the local hook, and provider
isolation all hold; otherwise it names the ones that do not, so a dead pipeline
cannot report a clean bill of health.

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
