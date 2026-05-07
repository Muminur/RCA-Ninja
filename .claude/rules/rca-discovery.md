---
globs: ['rca/**/*.md', 'src/**/*.py', 'src/**/*.js', 'src/**/*.mjs', 'src/**/*.ts']
---

When investigating bugs or reviewing code changes, check if related RCAs exist:

1. **Quick overview**: Read `rca/llms.txt` for a token-efficient corpus summary (recent RCAs, top tags, usage examples). This is a 2–3 KB file designed for AI consumption.

2. **Find relevant RCAs**:
   - `claude-rca search --files <current-file>` — RCAs affecting a specific file
   - `claude-rca search --tag <keyword>` — filter by topic
   - `claude-rca search "query"` — full-text search
   - `claude-rca recent 5` — most recent fixes

3. **Read full RCA** only after confirming relevance from `llms.txt` or search results.

4. **Large corpus?** If `rca/llms.txt` is absent, read `rca/_manifest.jsonl` (one JSON per line, skip `#` comment lines).
