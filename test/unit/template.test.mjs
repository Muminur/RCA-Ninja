import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTemplatePaths } from '../../src/template.mjs';

const DEFAULT_SCHEMA = '/some/default/rca-schema.json';
const DEFAULT_PROMPT = '/some/default/rca-system.md';

describe('resolveTemplatePaths', () => {
  let tmp;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-template-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns default paths when no local overrides exist', () => {
    const result = resolveTemplatePaths(tmp, DEFAULT_SCHEMA, DEFAULT_PROMPT);
    assert.equal(result.schemaPath, DEFAULT_SCHEMA);
    assert.equal(result.systemPromptPath, DEFAULT_PROMPT);
  });

  it('returns local schema path when .claude-rca/rca-schema.json exists', () => {
    const overrideDir = join(tmp, '.claude-rca');
    mkdirSync(overrideDir, { recursive: true });
    const localSchema = join(overrideDir, 'rca-schema.json');
    writeFileSync(localSchema, JSON.stringify({ $schema: 'custom' }));

    const result = resolveTemplatePaths(tmp, DEFAULT_SCHEMA, DEFAULT_PROMPT);
    assert.equal(result.schemaPath, localSchema);
    // Prompt still default — only schema override present
    assert.equal(result.systemPromptPath, DEFAULT_PROMPT);

    // Cleanup for next tests
    rmSync(localSchema);
  });

  it('returns local prompt path when .claude-rca/rca-system.md exists', () => {
    const overrideDir = join(tmp, '.claude-rca');
    mkdirSync(overrideDir, { recursive: true });
    const localPrompt = join(overrideDir, 'rca-system.md');
    writeFileSync(localPrompt, '# Custom system prompt');

    const result = resolveTemplatePaths(tmp, DEFAULT_SCHEMA, DEFAULT_PROMPT);
    assert.equal(result.systemPromptPath, localPrompt);
    // Schema still default
    assert.equal(result.schemaPath, DEFAULT_SCHEMA);

    rmSync(localPrompt);
  });

  it('returns both local paths when both overrides exist', () => {
    const overrideDir = join(tmp, '.claude-rca');
    mkdirSync(overrideDir, { recursive: true });
    const localSchema = join(overrideDir, 'rca-schema.json');
    const localPrompt = join(overrideDir, 'rca-system.md');
    writeFileSync(localSchema, JSON.stringify({ $schema: 'custom' }));
    writeFileSync(localPrompt, '# Custom system prompt');

    const result = resolveTemplatePaths(tmp, DEFAULT_SCHEMA, DEFAULT_PROMPT);
    assert.equal(result.schemaPath, localSchema);
    assert.equal(result.systemPromptPath, localPrompt);
  });
});
