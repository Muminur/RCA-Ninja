import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const COMMANDS_DIR = join(ROOT, '.claude', 'commands');

const ALLOWED_TOOLS = new Set(['Bash', 'Read', 'Edit', 'Write']);

function parseCommandFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 3) {
    throw new Error(`${filePath}: missing YAML frontmatter (expected ---...--- block)`);
  }
  return {
    yamlContent: parts[1].trim(),
    body: parts.slice(2).join('---').trim(),
  };
}

function parseSimpleYaml(yaml) {
  const result = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([a-z-]+):\s*(.*)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

describe('slash commands', () => {
  it('commands directory exists with at least 5 command files', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 5, `Expected ≥5 command files, got ${files.length}`);
  });

  it('all command files have valid YAML frontmatter', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      assert.doesNotThrow(
        () => parseCommandFile(join(COMMANDS_DIR, file)),
        `${file} must have valid ---frontmatter--- block`,
      );
    }
  });

  it('all command files have a description field', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const { yamlContent } = parseCommandFile(join(COMMANDS_DIR, file));
      const fm = parseSimpleYaml(yamlContent);
      assert.ok(fm.description, `${file}: frontmatter must have a description field`);
    }
  });

  it('all command files allowed-tools are a subset of {Bash, Read, Edit, Write}', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const { yamlContent } = parseCommandFile(join(COMMANDS_DIR, file));
      const fm = parseSimpleYaml(yamlContent);
      if (!fm['allowed-tools']) continue;
      const tools = fm['allowed-tools'].split(',').map((t) => t.trim());
      for (const tool of tools) {
        assert.ok(
          ALLOWED_TOOLS.has(tool),
          `${file}: allowed-tools '${tool}' is not in {Bash, Read, Edit, Write}`,
        );
      }
    }
  });

  it('each command body references claude-rca (no reimplemented logic)', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const { body } = parseCommandFile(join(COMMANDS_DIR, file));
      assert.ok(
        body.includes('claude-rca'),
        `${file}: body must reference claude-rca`,
      );
    }
  });

  it('rca.md dispatcher references all four subcommands', () => {
    const { body } = parseCommandFile(join(COMMANDS_DIR, 'rca.md'));
    for (const cmd of ['generate', 'search', 'recent', 'show']) {
      assert.ok(body.includes(cmd), `rca.md must reference ${cmd} subcommand`);
    }
  });
});
