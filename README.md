# claude-rca

> Turn bug-fix commits into structured Root Cause Analysis Markdown artifacts in under 30 seconds.

A **local-first CLI** that wraps `claude --bare -p` to produce validated, searchable RCA documents from `git diff` output, with optional Obsidian vault sync.

## Quick Start

### Prerequisites

- **Node.js >= 20 LTS**
- **Claude Code CLI**: `npm i -g @anthropic-ai/claude-code` then `claude login`
- **ripgrep**: `brew install ripgrep` (macOS) · `sudo apt install ripgrep` (Linux)
- **git >= 2.20**

### Install

```bash
npm install -g claude-rca
```

Or run from source:

```bash
git clone https://github.com/Muminur/RCA-Ninja.git
cd RCA-Ninja
npm ci
npm link
```

### Initialize in your repo

```bash
cd your-git-repo
claude-rca init
# Creates .claude-rca.json and rca/ directory
```

### Generate an RCA for the last commit

```bash
git commit -m "fix: null-check session before dereferencing user.id"
claude-rca generate
# Outputs: rca/2026/04/RCA-2026-04-26-a3f2c1d-null-check-session.md
```

### Search your RCA corpus

```bash
claude-rca search "null pointer"
claude-rca recent 5
claude-rca show RCA-2026-04-26-a3f2c1d-null-check-session
```

### Verify your environment

```bash
claude-rca doctor
```

## Configuration

`claude-rca init` creates `.claude-rca.json`:

```json
{
  "version": 1,
  "output_dir": "./rca",
  "claude": {
    "binary": "claude",
    "permission_mode": "plan",
    "allowed_tools": "Read",
    "timeout_ms": 60000
  },
  "obsidian": {
    "enabled": false,
    "vault_path": "",
    "rca_folder": "RCA Inbox"
  }
}
```

Read/write values:

```bash
claude-rca config --get output_dir
claude-rca config --set output_dir=./postmortems
claude-rca config --list
```

## Optional: Auto-generate on every bug-fix commit

```bash
bash hooks/install-hook.sh
claude-rca config --set auto_generate=true
```

`install-hook.sh` installs two git hooks into your repo's `.git/hooks/`:

- **`post-commit`** — detects `fix:` commits and runs `claude-rca generate` in the background (no commit delay).
- **`commit-msg`** — rejects commit messages that do not follow [Conventional Commits](https://www.conventionalcommits.org/). Accepted types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Merge, Revert, fixup!, and squash! commits are always passed through.

The installer is idempotent (safe to run multiple times) and will never overwrite a hook it did not create.

## Optional: Obsidian vault sync

```bash
claude-rca config --set obsidian.enabled=true
claude-rca config --set obsidian.vault_path=/path/to/vault
```

Every generated RCA is atomically copied to `<vault>/RCA Inbox/`. The `.obsidian/` directory is never modified.

## Claude Code slash commands

In any Claude Code session:

- `/rca` — dispatcher
- `/rca-generate [ref]` — generate for a commit
- `/rca-search <query>` — search corpus
- `/rca-recent [n]` — list newest
- `/rca-show <id>` — display by ID or path

## Development

```bash
npm test                  # unit tests
npm run test:integration  # integration tests (requires rg)
npm run test:e2e          # e2e tests (uses claude-stub)
npm run coverage          # c8 report (target >=85%)
npm run check             # lint + test + coverage (CI gate)
```

203 tests across unit, integration, and e2e suites. Coverage gate: ≥85% line coverage on `src/`.

CI runs on Node 20, Ubuntu and macOS, on every push and pull request (`.github/workflows/ci.yml`).

## License

MIT
