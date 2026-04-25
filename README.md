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

Engineers fix bugs and lose the *reasoning* behind the fix. Commit messages capture *what* changed; RCAs capture *why it broke* and *what to watch for*.

`claude-rca` removes the friction by:

- Generating the RCA from existing context (diff + commit + logs)
- Enforcing a fixed schema so the corpus stays searchable
- Storing artifacts where `rg` can find them in <2s across 10k files

## Commands

| Command | Description |
|---------|-------------|
| `claude-rca init` | Scaffold `rca/` directory and config |
| `claude-rca generate` | Generate an RCA for a commit |
| `claude-rca search <query>` | Search RCA corpus via ripgrep |
| `claude-rca recent [N]` | List N most recent RCAs |
| `claude-rca show <id>` | Display an RCA |
| `claude-rca config` | Read/write configuration |
| `claude-rca doctor` | Check environment health |

## Privacy

Diffs are sent to Claude for analysis. This is the same privacy posture as Claude Code itself. No additional network calls are made. No telemetry. No accounts.

## License

MIT
