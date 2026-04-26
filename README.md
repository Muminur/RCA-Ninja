# claude-rca

Local-first CLI that turns bug-fix commits into structured Root Cause Analysis Markdown artifacts.

## Quick Start

```bash
# Prerequisites
node --version   # >= 20
git --version    # >= 2.20
rg --version     # >= 13 (ripgrep)
claude --version # Anthropic CLI

# Install
npm install -g claude-rca

# Initialize in your repo
cd your-project
claude-rca init

# Generate an RCA after a bug-fix commit
git commit -am "fix: null-check session before reading user.id"
claude-rca generate

# Search your RCA corpus
claude-rca search "null pointer"

# List recent RCAs
claude-rca recent 5
```

## What It Does

Engineers fix bugs and lose the _reasoning_ behind the fix. Commit messages capture _what_ changed; RCAs capture _why it broke_ and _what to watch for_.

`claude-rca` removes the friction by:

- Generating the RCA from existing context (diff + commit + logs)
- Enforcing a fixed schema so the corpus stays searchable
- Storing artifacts where `rg` can find them in <2s across 10k files
- Optionally syncing to an Obsidian vault

## Commands

| Command                                 | Description                          |
| --------------------------------------- | ------------------------------------ |
| `claude-rca init`                       | Scaffold `rca/` directory and config |
| `claude-rca generate [--from REF]`      | Generate an RCA for a commit         |
| `claude-rca generate --dry-run`         | Preview without writing              |
| `claude-rca search <query> [--tag T]`   | Search RCA corpus via ripgrep        |
| `claude-rca recent [N] [--json]`        | List N most recent RCAs              |
| `claude-rca show <id>`                  | Display an RCA by ID, hash, or path  |
| `claude-rca config --list`              | Show merged configuration            |
| `claude-rca config --get <key>`         | Get a config value                   |
| `claude-rca config --set <key>=<value>` | Set a config value                   |
| `claude-rca doctor`                     | Check environment health             |

## Git Hook (Optional)

Auto-generate RCAs on `fix:` commits:

```bash
bash hooks/install-hook.sh
claude-rca config --set auto_generate=true
```

The hook runs in the background and never blocks commits.

## Obsidian Integration

```bash
claude-rca config --set obsidian.enabled=true
claude-rca config --set obsidian.vault_path=/path/to/vault
```

RCAs are copied to `<vault>/RCA Inbox/` and optionally linked in your daily note.

## Privacy

Diffs are sent to Claude for analysis. This is the same privacy posture as Claude Code itself. No additional network calls are made. No telemetry. No accounts.

## License

MIT
