---
globs: ['rca/**/*.md', 'src/**/*.py', 'src/**/*.js', 'src/**/*.mjs', 'src/**/*.ts']
---

When investigating bugs or reviewing code changes, check if related RCAs exist:

1. Read rca/\_manifest.yaml for corpus overview (one entry per RCA with key metadata)
2. Use `claude-rca search --files <current-file>` to find RCAs affecting the file you're working on
3. Use `claude-rca search --tag <keyword>` for topic-based search
4. Read full RCA documents only after confirming relevance from manifest or search results
