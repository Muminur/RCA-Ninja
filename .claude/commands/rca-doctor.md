---
description: Check the claude-rca environment and suggest fixes for any failing checks.
allowed-tools: Bash
---

Run: `claude-rca doctor`

If exit 0: print "All checks passed."

If exit 70 (one or more checks failed):

- Parse the two-column output (check name | status | details).
- For each failing check, map to a suggested fix:
  - Node <20 → "Install Node 20 via nvm: `nvm install 20 && nvm use 20`"
  - claude missing → "Install Claude Code: `npm i -g @anthropic-ai/claude-code`"
  - rg missing → macOS: `brew install ripgrep` / Linux: `sudo apt-get install -y ripgrep` / Windows: see https://github.com/BurntSushi/ripgrep#installation
  - git <2.20 → "Upgrade git from your system package manager"
  - stale lockfile → offer to run `rm <lockfile-path>` automatically

For **install-required fixes** (Node, claude, rg, git): print the command only. Do NOT execute it.

For **non-privileged fixes** (stale lockfile at a printed path): use the Bash tool to remove it after confirming with the user, then re-run `claude-rca doctor`.
