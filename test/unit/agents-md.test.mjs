import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('AGENTS.md', () => {
  it('AGENTS.md exists at repo root', () => {
    const agentsMdPath = join(ROOT, 'AGENTS.md');
    assert.ok(existsSync(agentsMdPath), 'AGENTS.md must exist at repo root');
  });

  it('AGENTS.md contains manifest index reference', () => {
    const agentsMdPath = join(ROOT, 'AGENTS.md');
    const content = readFileSync(agentsMdPath, 'utf8');
    assert.ok(
      content.includes('_manifest.jsonl') || content.includes('_manifest.yaml'),
      'AGENTS.md must reference the RCA manifest for AI discovery',
    );
  });

  it('AGENTS.md contains rg search instructions', () => {
    const agentsMdPath = join(ROOT, 'AGENTS.md');
    const content = readFileSync(agentsMdPath, 'utf8');
    assert.ok(content.includes('rg'), 'AGENTS.md must include rg (ripgrep) search instructions');
  });

  it('AGENTS.md mentions .claudeignore', () => {
    const agentsMdPath = join(ROOT, 'AGENTS.md');
    const content = readFileSync(agentsMdPath, 'utf8');
    assert.ok(
      content.includes('.claudeignore'),
      'AGENTS.md must mention .claudeignore so AI assistants know rca/ is excluded from incidental scans',
    );
  });

  it('AGENTS.md recommends codex-rca search --files for file-based RCA lookup', () => {
    const agentsMdPath = join(ROOT, 'AGENTS.md');
    const content = readFileSync(agentsMdPath, 'utf8');
    assert.ok(
      content.includes('codex-rca search --files'),
      'AGENTS.md must recommend `codex-rca search --files <path>` as the manifest-first search workflow',
    );
  });
});

describe('.claudeignore', () => {
  it('.claudeignore exists at repo root', () => {
    const claudeignorePath = join(ROOT, '.claudeignore');
    assert.ok(existsSync(claudeignorePath), '.claudeignore must exist at repo root');
  });

  it('.claudeignore contains rca/', () => {
    const claudeignorePath = join(ROOT, '.claudeignore');
    const content = readFileSync(claudeignorePath, 'utf8');
    assert.ok(
      content.includes('rca/'),
      '.claudeignore must contain rca/ to prevent Claude Code from scanning RCA files incidentally',
    );
  });
});

describe('.claude/rules/rca-discovery.md', () => {
  const rulesPath = join(ROOT, '.claude', 'rules', 'rca-discovery.md');

  it('.claude/rules/rca-discovery.md exists', () => {
    assert.ok(existsSync(rulesPath), '.claude/rules/rca-discovery.md must exist');
  });

  it('.claude/rules/rca-discovery.md has YAML frontmatter with globs containing rca/**/*.md', () => {
    const content = readFileSync(rulesPath, 'utf8');
    const parts = content.split(/^---\s*$/m);
    assert.ok(parts.length >= 3, 'rca-discovery.md must have YAML frontmatter');
    const frontmatter = parts[1];
    assert.ok(
      frontmatter.includes('rca/**/*.md'),
      'rca-discovery.md frontmatter must contain glob: rca/**/*.md',
    );
  });

  it('.claude/rules/rca-discovery.md glob includes source file patterns', () => {
    const content = readFileSync(rulesPath, 'utf8');
    const parts = content.split(/^---\s*$/m);
    assert.ok(parts.length >= 3, 'rca-discovery.md must have YAML frontmatter');
    const frontmatter = parts[1];
    assert.ok(
      frontmatter.includes('src/**/*.'),
      'rca-discovery.md frontmatter globs must include source file patterns (e.g. src/**/*.mjs)',
    );
  });

  it('.claude/rules/rca-discovery.md body instructs to read manifest first', () => {
    const content = readFileSync(rulesPath, 'utf8');
    const parts = content.split(/^---\s*$/m);
    const body = parts.slice(2).join('---');
    assert.ok(
      body.toLowerCase().includes('manifest'),
      'rca-discovery.md body must instruct to read manifest first',
    );
  });

  it('.claude/rules/rca-discovery.md body instructs to use claude-rca search for retrieval', () => {
    const content = readFileSync(rulesPath, 'utf8');
    const parts = content.split(/^---\s*$/m);
    const body = parts.slice(2).join('---');
    assert.ok(
      body.includes('claude-rca search'),
      'rca-discovery.md body must reference `claude-rca search` as the primary retrieval command',
    );
  });
});
