import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const AGENTS_DIR = join(ROOT, '.claude', 'agents');
const VALID_MODELS = new Set(['sonnet', 'haiku', 'opus']);

const SKIP = !existsSync(AGENTS_DIR)
  ? 'skip: .claude/agents/ not found (gitignored, local-only files)'
  : false;

function parseAgentFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 3) throw new Error(`${filePath}: missing YAML frontmatter`);
  const fm = {};
  for (const line of parts[1].trim().split('\n')) {
    const m = line.match(/^([a-z-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: parts.slice(2).join('---').trim() };
}

describe('subagents', () => {
  it('agents directory has at least 2 agent files', { skip: SKIP }, () => {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 2, `Expected ≥2 agent files, got ${files.length}`);
  });

  it('all agent files have valid YAML frontmatter', { skip: SKIP }, () => {
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      assert.doesNotThrow(() => parseAgentFile(join(AGENTS_DIR, file)), `${file}: bad frontmatter`);
    }
  });

  it('all agent files have a name field', { skip: SKIP }, () => {
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const { fm } = parseAgentFile(join(AGENTS_DIR, file));
      assert.ok(fm.name, `${file}: must have name field`);
    }
  });

  it('all agent files have a description field', { skip: SKIP }, () => {
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const { fm } = parseAgentFile(join(AGENTS_DIR, file));
      assert.ok(fm.description, `${file}: must have description field`);
    }
  });

  it('model field when present must be sonnet, haiku, or opus', { skip: SKIP }, () => {
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const { fm } = parseAgentFile(join(AGENTS_DIR, file));
      if (!fm.model) continue;
      assert.ok(
        VALID_MODELS.has(fm.model),
        `${file}: model '${fm.model}' must be sonnet/haiku/opus`,
      );
    }
  });

  it('code-reviewer.md exists with correct name and tools fields', { skip: SKIP }, () => {
    const { fm } = parseAgentFile(join(AGENTS_DIR, 'code-reviewer.md'));
    assert.strictEqual(fm.name, 'code-reviewer');
    assert.ok(fm.tools || fm.model, 'code-reviewer.md must have tools or model field');
  });

  it('all agent bodies are non-trivial (>50 chars)', { skip: SKIP }, () => {
    for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const { body } = parseAgentFile(join(AGENTS_DIR, file));
      assert.ok(
        body.trim().length > 50,
        `${file}: body must be >50 chars, got ${body.trim().length}`,
      );
    }
  });
});
