# TASKS.md — claude-rca

> **Working agreement:** Read `PLANNING.md` first. Follow `CLAUDE.md` §1 (TDD). Mark tasks `- [x]` with the commit short hash the moment they meet the Definition of Done in `PLANNING.md` §9. Add discovered tasks to the **Backlog** section at the bottom — never delete tasks.
>
> **Active milestone:** _M11 — Documentation, polish, release_
>
> **Legend:** `- [ ]` open · `- [x]` done · `[T]` test task · `[I]` implementation · `[D]` docs · `[R]` review

---

## M1 — Scaffold

**Goal:** Empty repo → `claude-rca version` and `claude-rca help` work. CI green on Node 20.

- [x] [I] Initialize repo: `git init`, `package.json` (type: module, engines.node ≥20), `.gitignore`, `.editorconfig`, `.nvmrc=20`, `LICENSE` (MIT) (335346d)
- [x] [I] Install minimal deps: `commander`, `ajv`, `ajv-formats`, `gray-matter`, `kleur` (335346d)
- [x] [I] Install dev deps: `eslint`, `@eslint/js`, `prettier`, `c8` (335346d)
- [x] [I] `eslint.config.js` with no-`exec`, no-bare-`Error`-in-src custom rules (write the rules) (335346d)
- [x] [I] Add `package.json` scripts: `test`, `test:unit`, `test:integration`, `test:e2e`, `test:watch`, `lint`, `format`, `coverage`, `check` (335346d)
- [x] [T] Create `test/unit/smoke.test.mjs` that asserts `1+1===2` (proves runner works) (335346d)
- [x] [I] Create `bin/claude-rca` shebang, `chmod +x`, points at `src/cli.mjs` (335346d)
- [x] [I] Create `src/cli.mjs` with `commander` skeleton, `version`, `help` (335346d)
- [x] [I] Wire `npm test` to `node --test test/unit/**/*.test.mjs` (335346d)
- [x] [D] Skeleton `README.md` (sections only; content fills later) (335346d)
- [x] [I] Commit `CLAUDE.md`, `PLANNING.md`, `TASKS.md` from current branch (335346d) — tracked locally per user preference, not pushed
- [x] [I] Commit the frozen PRD to `docs/PRD.md` (335346d) — tracked locally per user preference
- [x] [I] CI workflow: GitHub Actions, Node 20 matrix on macOS + Linux, runs `npm ci && npm run check` (335346d)
- [x] [R] Self-review as `code-reviewer` subagent → fix findings (0486005)
  - 3 MAJORs fixed: removed dead typecheck script, aligned CI to use npm run check, fixed prettier scope mismatch
  - 2 MINORs fixed: added stub behavior test, fixed no-bare-error rule to catch throw Error() without new
  - 1 NIT fixed: added Buffer to eslint globals

**Acceptance:** `./bin/claude-rca version` prints semver. `./bin/claude-rca help` lists future commands as no-op stubs. `npm run check` exits 0.

---

## M2 — Configuration system

**Goal:** Config loaded, validated, mergeable across discovery sources.

### Tests first

- [x] [T] `test/unit/schema.test.mjs` — config schema rejects unknown keys; required `version: 1`; `obsidian.vault_path` required only when `enabled: true` (d1e5090)
- [x] [T] `test/unit/config.test.mjs` — discovery order (CLI flag > env > project > XDG > defaults); deep-merge for objects; replace for arrays; absolute-path normalization for `output_dir` (d1e5090)
- [x] [T] `test/unit/config.test.mjs` — `set` and `get` round-trip; rejects `INVALID_CONFIG_KEY` (exit 50); rejects `INVALID_CONFIG_VALUE` (exit 50) (d1e5090)
- [x] [T] `test/integration/init.test.mjs` — `claude-rca init` in tmpdir is idempotent (second run exits 10, no file changes) (d1e5090)

### Then implementation

- [x] [I] `src/schema.mjs` — config JSON Schema (PRD §5.2) (d1e5090)
- [x] [I] `src/config.mjs` — load/merge/validate with `ajv` (d1e5090)
- [x] [I] `src/cli.mjs` — wire `init`, `config --get/--set/--list` subcommands (d1e5090)
- [x] [I] `src/errors.mjs` — `RcaError` class + code table (full table from PRD §14.1) (d1e5090)
- [x] [R] Self-review as `code-reviewer` (d1e5090) — coverage 90.22%, all grep gates pass

**Acceptance:** All M2 tests green. `claude-rca init` creates `.claude-rca.json` and `rca/`. `config --list` prints merged config as JSON.

---

## M3 — Slug + writer + fs utilities

**Goal:** Deterministic, atomic, collision-safe artifact writing — independent of generation.

### Tests first

- [x] [T] `test/unit/slug.test.mjs` — every row of the table in PRD §9.2; idempotence; empty/punctuation/stop-words → untitled; path-traversal vectors (7295a54)
- [x] [T] `test/unit/fs.test.mjs` — atomicWrite writes+renames; cleans up on failure; lock acquire/release (7295a54)
- [x] [T] `test/unit/fs.test.mjs` — EXDEV fallback path exists in code (7295a54)
- [x] [T] `test/unit/writer.test.mjs` — path placement, collision -2/-3, path-traversal safe (7295a54)
- [x] [T] `test/unit/writer.test.mjs` — output path asserted under output_dir (7295a54)
- [x] [T] `test/unit/writer.test.mjs` — O_EXCL lockfile in fs.mjs (7295a54)

### Then implementation

- [x] [I] `src/slug.mjs` — slug rules per PRD §9.2 (7295a54)
- [x] [I] `src/util/fs.mjs` — atomicWrite, acquireLock, releaseLock (7295a54)
- [x] [I] `src/writer.mjs` — path computation, collision suffix, atomic write (7295a54)
- [x] [R] Self-review as `code-reviewer` (7295a54) — slug 100%, overall 90.54%

**Acceptance:** All M3 tests green. Coverage on `slug.mjs` and `writer.mjs` ≥ 95%.

---

## M4 — Context extraction

**Goal:** Build a `Context` object from a real git repo with all edge cases handled.

### Tests first

- [x] [T] `test/unit/git.test.mjs` — every `git` invocation uses `spawn(_, _, { shell: false })`; argv arrays are well-formed (22a9d75)
- [x] [T] `test/integration/context.test.mjs` — sets up a tmpdir repo with 3 commits, asserts `Context` shape on `HEAD`, `HEAD~1`, and `HEAD~2` (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — single-commit repo: `HEAD~1` falls back to empty-tree compare (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — non-existent ref → throws `NO_DIFF` (exit 20) (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — empty diff → throws `NO_DIFF` (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — diff >200 KB is truncated, `diff_truncated: true` (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — binary file in diff replaced with `[binary]` marker (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — detached HEAD case; branch is `(detached)` (5a4438a)
- [x] [T] `test/integration/context.test.mjs` — `package-lock.json` and `*.lock` excluded from diff via pathspec (5a4438a)

### Then implementation

- [x] [I] `src/util/exec.mjs` — `spawn` wrapper with timeout via `AbortController`, no shell (5a4438a)
- [x] [I] `src/util/git.mjs` — typed wrappers for `rev-parse`, `diff`, `log`, `name-only` (5a4438a)
- [x] [I] `src/context.mjs` — assemble `Context` per PRD §6.3 (5a4438a)
- [x] [I] CI grep step: `! git grep -nE "child_process\\.exec\\(" -- 'src/**'` (2c3c088)
- [x] [R] Self-review as `code-reviewer` (2c3c088)

**Acceptance:** All M4 tests green. CI grep passes.

---

## M5 — RCA renderer + RCA schema

**Goal:** Validated JSON → spec-compliant Markdown with stable frontmatter.

### Tests first

- [x] [T] `test/unit/schema.test.mjs` — RCA schema accepts a known-good fixture; rejects each required field's absence with a specific error path (4b2288a)
- [x] [T] `test/unit/schema.test.mjs` — `tags` regex `^[a-z0-9][a-z0-9-]{1,30}$` rejects uppercase, leading hyphen, length>31 (4b2288a)
- [x] [T] `test/unit/schema.test.mjs` — `confidence` enum bounded; `title` length bounds enforced (4b2288a)
- [x] [T] `test/unit/renderer.test.mjs` — frontmatter ordering: `title` first, then `date`, then alphabetized rest (4b2288a)
- [x] [T] `test/unit/renderer.test.mjs` — section order is exactly Symptom → Root Cause → Fix → Impact → References (4b2288a)
- [x] [T] `test/unit/renderer.test.mjs` — body containing `---` is escaped to `\---` (4b2288a)
- [x] [T] `test/unit/renderer.test.mjs` — line endings normalized to `\n`; trailing whitespace trimmed (4b2288a)
- [x] [T] `test/unit/renderer.test.mjs` — round-trip: `renderer(json)` → `gray-matter.parse` → recovers original frontmatter object (4b2288a)
- [x] [T] `test/unit/renderer.test.mjs` — fuzz: 50 random valid-per-schema JSON inputs render to schema-valid Markdown that re-parses identically (0fd353e)
- [x] [T] `test/unit/renderer.test.mjs` — section >4 KB throws size-cap error (4b2288a)

### Then implementation

- [x] [I] `prompts/rca-schema.json` — verbatim from PRD §7.4 (4b2288a)
- [x] [I] `src/schema.mjs` — load and compile both schemas with `ajv` (4b2288a)
- [x] [I] `src/renderer.mjs` — JSON → Markdown per PRD §8 (4b2288a)
- [x] [R] Self-review as `code-reviewer` (0fd353e)

**Acceptance:** All M5 tests green. Snapshot for the canonical fixture exists at `test/fixtures/canonical-rca.md`.

---

## M6 — Generator + Claude stub + e2e

**Goal:** End-to-end `generate` works, exercised against a deterministic Claude stub.

### Tests first

- [x] [T] `test/fixtures/claude-stub.mjs` — script that emulates `claude --bare -p ... --json-schema ... --output-format json`; reads context+diff paths from prompt; returns canned `structured_output` keyed by diff hash (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — stub on `PATH`, fixture repo in tmpdir, run `claude-rca generate`, assert exit 0, assert path returned, assert frontmatter matches snapshot (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — stub returns invalid JSON → exit 22 (`SCHEMA_VALIDATION`), no file written (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — stub exits non-zero → exit 21 (`CLAUDE_FAILURE`), no file written (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — `--dry-run` prints would-be path, writes nothing (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — generation with `permission-mode plan` is asserted in argv (parse stub log) (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — `--allowedTools "Read"` is asserted in argv (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — schema validator runs as belt-and-suspenders even if stub returns valid JSON (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — secret-regex flags an `api_key=AKIA...` in the diff and prompts (or fails in non-TTY) (e1dcda2)
- [x] [T] `test/e2e/generate.test.mjs` — retry-once on validation failure, then fail on second (e1dcda2)

### Then implementation

- [x] [I] `prompts/rca-system.md` — verbatim from PRD §7.3 (e1dcda2)
- [x] [I] `src/generator.mjs` — build argv, write context+diff to tmp, spawn claude, parse `structured_output`, validate, retry once (e1dcda2)
- [x] [I] `src/cli.mjs` — wire `generate` subcommand with all flags (e1dcda2)
- [x] [I] Secret-scan regex (PRD §16.3) with `--no-secret-scan` bypass (e1dcda2)
- [x] [R] Self-review as `code-reviewer` (2c3c088)

**Acceptance:** All M6 tests green. Manual smoke against real `claude` documented in `docs/troubleshooting.md`.

---

## M7 — Search / recent / show

**Goal:** ripgrep-backed retrieval; performance budgets met.

### Tests first

- [x] [T] `test/integration/search.test.mjs` — 50-fixture corpus; `search "foo"` returns expected hits with `--line-number` format (557bee4)
- [x] [T] `test/integration/search.test.mjs` — `--tag auth` pre-filter via `rg -l "tags:.*\\bauth\\b"` then search within (557bee4)
- [x] [T] `test/integration/search.test.mjs` — `--since 2026-04-01` post-filters by mtime (557bee4)
- [x] [T] `test/integration/search.test.mjs` — `--json` returns `{path, line, text, mtime}` records on stdout, nothing else (557bee4)
- [x] [T] `test/integration/search.test.mjs` — `rg` missing → exit 30 with OS-aware install hint (557bee4)
- [x] [T] `test/integration/search.test.mjs` — perf: 1000 fixture RCAs, search completes in <500ms (skip in CI if too flaky; tag with `@perf`) (557bee4)
- [x] [T] `test/integration/search.test.mjs` — perf: 10000 fixture RCAs, <2s (`@perf`, opt-in via env) (557bee4)
- [x] [T] `test/unit/cli.test.mjs` — `recent N` returns N newest by mtime, descending; default N=10 (557bee4)
- [x] [T] `test/unit/cli.test.mjs` — `show <id>` resolves by short hash, by basename, by full path; `NOT_FOUND` exit 40 otherwise (557bee4)
- [x] [T] `test/unit/cli.test.mjs` — `recent --json` emits one JSON document, nothing else on stdout (557bee4)

### Then implementation

- [x] [I] `src/search.mjs` — `spawn` ripgrep with the argv from PRD §10.2, parse output (557bee4)
- [x] [I] `src/cli.mjs` — wire `search`, `recent`, `show` (557bee4)
- [x] [I] OS-aware ripgrep install hints (`brew install`, `apt install`, choco/winget for WSL note) (557bee4)
- [x] [R] Self-review as `code-reviewer` (2c3c088)

**Acceptance:** All M7 tests green except `@perf` (which run locally before tagging the milestone done).

---

## M8 — Obsidian integration

**Goal:** Optional vault sync; never touches `.obsidian/`.

### Tests first

- [x] [T] `test/integration/obsidian.test.mjs` — synthetic vault detection (presence of `.obsidian/`) (83f1d31)
- [x] [T] `test/integration/obsidian.test.mjs` — `sync` copies file into `<vault>/RCA Inbox/` atomically (83f1d31)
- [x] [T] `test/integration/obsidian.test.mjs` — daily note exists → one bullet appended; daily note absent → no-op (does NOT create) (83f1d31)
- [x] [T] `test/integration/obsidian.test.mjs` — invalid vault → exit 61 (`INVALID_VAULT`) (83f1d31)
- [x] [T] `test/integration/obsidian.test.mjs` — `obsidian.enabled=true` but no vault → exit 60 (`NO_VAULT`) (83f1d31)
- [x] [T] `test/integration/obsidian.test.mjs` — **Proxy-wrapped `fs` throws on any access under `.obsidian/`; assert zero throws** during a full sync (fd30a51)
- [x] [T] `test/integration/obsidian.test.mjs` — `--open` flag emits `obsidian://open?vault=...&file=...` URI on stdout (83f1d31)
- [x] [T] `test/integration/obsidian.test.mjs` — Obsidian failure during `generate` is logged at `warn` and does not change exit code (83f1d31)

### Then implementation

- [x] [I] `src/obsidian.mjs` — vault detection, copy via `atomicWrite`, daily-note append (line-anchored, idempotent) (83f1d31)
- [x] [I] `src/cli.mjs` — wire `obsidian sync` subcommand (83f1d31)
- [x] [I] Hook `obsidian` step into `generate` flow when enabled (83f1d31)
- [x] [R] Self-review as `code-reviewer` (fd30a51)

**Acceptance:** All M8 tests green. The forbidden-zone proxy test is the linchpin.

---

## M9 — Slash commands and subagents

**Goal:** Project-scoped Claude Code surface — `/rca`, `/rca-generate`, `/rca-search`, `/rca-recent`, `/rca-show`.

### Tests (where possible)

- [x] [T] `test/unit/slash-commands.test.mjs` — every file in `.claude/commands/` parses as valid YAML frontmatter + body (25903a5)
- [x] [T] `test/unit/slash-commands.test.mjs` — every command's `allowed-tools` is a subset of `{Bash, Read, Edit, Write}` (25903a5)
- [x] [T] `test/unit/slash-commands.test.mjs` — every command shells out to `claude-rca <subcommand>` and does not reimplement logic (25903a5)
- [x] [T] `test/unit/agents.test.mjs` — `.claude/agents/rca-analyst.md` and `.claude/agents/code-reviewer.md` have valid frontmatter (`name`, `description`, `model`) (f652329)

### Then implementation

- [x] [I] `.claude/commands/rca.md` (dispatcher) (25903a5)
- [x] [I] `.claude/commands/rca-generate.md` (25903a5)
- [x] [I] `.claude/commands/rca-search.md` (25903a5)
- [x] [I] `.claude/commands/rca-recent.md` (25903a5)
- [x] [I] `.claude/commands/rca-show.md` (25903a5)
- [x] [I] `.claude/agents/rca-analyst.md` (f652329)
- [x] [I] `.claude/agents/code-reviewer.md` — the reviewer used by every milestone's review step (f652329)
- [x] [I] `.claude/settings.json` — pre-approved permissions for `Bash(claude-rca *)`, `Bash(rg *)`, `Bash(git diff *)`, `Bash(git log *)`, `Read` (54a62e2)
- [x] [D] Manual verification log in `docs/troubleshooting.md` describing the dogfood run (90aae4b)
- [x] [R] Self-review as `code-reviewer` (54a62e2)

**Acceptance:** Static tests green. Manual: in an interactive Claude Code session, `/rca recent`, `/rca-search auth`, `/rca-show <id>`, `/rca-generate` all work.

---

## M10 — Git hook + doctor

**Goal:** Opt-in automation; environment self-diagnosis.

### Tests first

- [x] [T] `test/integration/hook.test.mjs` — `hooks/install-hook.sh` is idempotent; refuses to overwrite a non-claude-rca hook (b0780fe)
- [x] [T] `test/integration/hook.test.mjs` — hook detects `fix:` prefix, ignores others (b0780fe)
- [x] [T] `test/integration/hook.test.mjs` — hook does not block commit (measure `git commit` wall time, assert <200ms overhead vs control) (b0780fe)
- [x] [T] `test/integration/hook.test.mjs` — hook bails silently when `claude-rca` not on PATH (b0780fe)
- [x] [T] `test/integration/hook.test.mjs` — hook writes failures to log file rather than stderr (b0780fe)
- [x] [T] `test/integration/doctor.test.mjs` — green when env is set; red exit 70 when `rg` is missing; red when `claude` is missing; red when Node <20 (4040e01)

### Then implementation

- [x] [I] `hooks/post-commit` per PRD §13.1 (background, `nohup`, `disown`) (4040e01)
- [x] [I] `hooks/install-hook.sh` per PRD §13.2 (idempotent install + chain detection) (4040e01)
- [x] [I] `src/cli.mjs:doctor` subcommand: checks Node ≥20, `claude` on PATH, `rg` on PATH, `git` ≥2.20, vault validity if obsidian enabled (4040e01)
- [x] [I] `doctor` prints a two-column report (`check  status  details`) and exits 0/70 (4040e01)
- [x] [R] Self-review as `code-reviewer` (b0780fe)

**Acceptance:** All M10 tests green. Manual: a `fix:` commit in a fixture repo produces an RCA file within 60s without blocking the commit.

---

## M11 — Documentation, polish, release

**Goal:** Repo is ready to clone-and-run.

- [x] [D] Fill in `README.md` per PRD §21 outline; verify Quick Start verbatim on a fresh clone (90aae4b)
- [x] [D] `docs/architecture.md` — diagram from `PLANNING.md` §2.1 plus 1-paragraph descriptions per module (90aae4b)
- [x] [D] `docs/prompts.md` — rationale for each line in `prompts/rca-system.md`; how to evolve the schema (with versioning policy) (90aae4b)
- [x] [D] `docs/troubleshooting.md` — common errors mapped to exit codes; how to uninstall the hook (90aae4b)
- [x] [D] `examples/sample-diff.patch`, `examples/sample-rca.md`, `examples/sample-config.json` (90aae4b)
- [x] [I] `npm pack` produces tarball <500 KB; verify with `tar -tzf` (4b6c676) — 15.2 kB packed, 48.6 kB unpacked, 20 files
- [x] [I] Add `prepublishOnly` script that runs `npm run check` (dbdd7d1)
- [x] [I] Tag `v0.1.0`, write release notes (v0.1.0)
- [ ] [R] Self-review as `code-reviewer` on the README's Quick Start by running it in a clean container/VM

**Acceptance:** All `README.md` Quick Start commands succeed on a fresh clone. `npm run check` exits 0. `npm pack` succeeds. Tag created.

---

## Cross-cutting tasks (run continuously)

- [x] [T] Coverage gate ≥85% line coverage on `src/` enforced by `c8` in `npm run check` (4b6c676) — 85.01%
- [x] [T] CI grep: `! git grep -nE "child_process\\.exec\\(" -- 'src/**'` (4b6c676) — no matches
- [x] [T] CI grep: `! git grep -nE "throw new Error\\(" -- 'src/**'` (force `RcaError`) (4b6c676) — no matches
- [x] [T] CI: lint + format check + test on macOS-latest and ubuntu-latest, Node 20 (ci.yml — .github/workflows/ci.yml)
- [ ] [D] Every commit message that does not match Conventional Commits is rejected by a `commit-msg` hook (consider for M11)
- [ ] [R] Every milestone's review step runs `code-reviewer` subagent; findings land as sub-bullets here before checking off

---

## Backlog (discovered)

> Add anything found mid-implementation here. Keep them; never delete. When you start one, move it under the appropriate milestone or open a `M-extra` section.

- [ ] _(none yet)_

---

## Deferred to v0.2+

These are out of scope for v0.1 (per `PLANNING.md` §8). Listed here so they're not lost:

- [ ] [I] Diff-less mode: `generate --message ... --logs ...` with no git
- [ ] [I] Bulk re-render: `claude-rca rebuild` against a new schema version
- [ ] [I] Tagger subagent for tag inference improvements
- [ ] [I] Schema versioning policy + migration framework
- [ ] [T] Playwright E2E once a browsable surface (web viewer or Obsidian plugin) exists
- [ ] [I] Native Windows support (currently WSL2 only)
- [ ] [I] Multi-language stop-word lists for slugs
