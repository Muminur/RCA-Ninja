---
globs: ['rca/**/*.md']
---

When working with RCA documents:

1. Read rca/\_manifest.yaml for corpus overview before scanning individual files
2. Use rg (ripgrep) to filter by frontmatter fields (tags, files, components, confidence)
3. Read full RCA documents only after confirming relevance from manifest or grep results
4. RCA frontmatter includes: title, date, ref, branch, confidence, files, tags, components, description
