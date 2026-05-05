import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { amendRca } from '../../src/amend.mjs';

/** Minimal context object satisfying renderer.mjs requirements */
function makeFakeContext(overrides = {}) {
  return {
    short_hash: 'abc1234',
    branch: 'main',
    timestamp_utc: '2026-01-01T00:00:00Z',
    files_changed: ['src/foo.mjs'],
    ref: 'abc1234',
    diff: 'diff --git a/src/foo.mjs b/src/foo.mjs\n+// fix',
    commit_message: 'fix: test fix',
    bug_introduced_by: null,
    ...overrides,
  };
}

/** Minimal RCA object satisfying renderer.mjs requirements */
function makeFakeRca(overrides = {}) {
  return {
    title: 'Test RCA',
    symptom: 'Something broke',
    root_cause: 'A bug',
    fix: 'Fixed the bug',
    impact: 'Minor',
    references: [],
    files: ['src/foo.mjs'],
    tags: ['test', 'bugfix'],
    confidence: 'high',
    code_changes: [],
    description: '',
    components: [],
    ...overrides,
  };
}

/** Write a fake RCA .md file with YAML frontmatter into dir */
function writeFakeRcaFile(dir, filename, frontmatterFields = {}) {
  const fm = {
    title: '"Test RCA"',
    date: '2026-01-01T00:00:00Z',
    ref: 'abc1234',
    branch: 'main',
    confidence: 'high',
    files: ['src/foo.mjs'],
    tags: ['test', 'bugfix'],
    ...frontmatterFields,
  };
  const lines = Object.entries(fm).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  });
  const content = `---\n${lines.join('\n')}\n---\n\n## Symptom\n\nSomething broke.\n`;
  writeFileSync(join(dir, filename), content, 'utf8');
  return join(dir, filename);
}

describe('amendRca', () => {
  it('throws NOT_FOUND when id does not match any file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-notfound-'));
    try {
      // No RCA files in dir — only the manifest placeholder
      await assert.rejects(
        () =>
          amendRca({
            id: 'nonexistent-id',
            correctionHint: 'fix this',
            outputDir: dir,
            cwd: dir,
            config: {},
            systemPromptPath: 'prompts/rca-system.md',
            schemaPath: 'prompts/rca-schema.json',
          }),
        (err) => {
          assert.strictEqual(err.code, 'NOT_FOUND');
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves matching file by basename substring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-match-'));
    try {
      writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');

      let _capturedArgs;
      const fakegen = async (args) => {
        _capturedArgs = args;
        return { rca: makeFakeRca(), cost: 0, sessionId: 'fake', autoFilled: [] };
      };

      const result = await amendRca({
        id: 'abc1234',
        correctionHint: 'the hint',
        outputDir: dir,
        cwd: dir,
        config: {},
        systemPromptPath: 'prompts/rca-system.md',
        schemaPath: 'prompts/rca-schema.json',
        _generateFn: fakegen,
        _buildContextFn: async () => makeFakeContext(),
        _rebuildManifestFn: async () => {},
      });

      assert.ok(result.path.includes('RCA-2026-01-01-abc1234-test-fix.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls _generateFn with correctionHint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-hint-'));
    try {
      writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');

      let capturedArgs;
      const fakegen = async (args) => {
        capturedArgs = args;
        return { rca: makeFakeRca(), cost: 0, sessionId: 'fake', autoFilled: [] };
      };

      await amendRca({
        id: 'abc1234',
        correctionHint: 'please fix the severity level',
        outputDir: dir,
        cwd: dir,
        config: {},
        systemPromptPath: 'prompts/rca-system.md',
        schemaPath: 'prompts/rca-schema.json',
        _generateFn: fakegen,
        _buildContextFn: async () => makeFakeContext(),
        _rebuildManifestFn: async () => {},
      });

      assert.ok(capturedArgs, '_generateFn should have been called');
      assert.strictEqual(capturedArgs.correctionHint, 'please fix the severity level');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites the RCA file in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-overwrite-'));
    try {
      const filePath = writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');
      const originalContent = readFileSync(filePath, 'utf8');

      const fakegen = async () => ({
        rca: makeFakeRca({ title: 'Amended RCA Title' }),
        cost: 0,
        sessionId: 'fake',
        autoFilled: [],
      });

      await amendRca({
        id: 'abc1234',
        correctionHint: 'amend this',
        outputDir: dir,
        cwd: dir,
        config: {},
        systemPromptPath: 'prompts/rca-system.md',
        schemaPath: 'prompts/rca-schema.json',
        _generateFn: fakegen,
        _buildContextFn: async () => makeFakeContext(),
        _rebuildManifestFn: async () => {},
      });

      const newContent = readFileSync(filePath, 'utf8');
      assert.notStrictEqual(newContent, originalContent, 'file should have been overwritten');
      assert.ok(newContent.includes('Amended RCA Title'), 'new content should reflect amended rca');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls rebuildManifest after writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-rebuild-'));
    try {
      writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');

      let rebuildCalled = false;
      const fakeRebuild = async () => {
        rebuildCalled = true;
      };

      await amendRca({
        id: 'abc1234',
        correctionHint: 'fix',
        outputDir: dir,
        cwd: dir,
        config: {},
        systemPromptPath: 'prompts/rca-system.md',
        schemaPath: 'prompts/rca-schema.json',
        _generateFn: async () => ({
          rca: makeFakeRca(),
          cost: 0,
          sessionId: 'fake',
          autoFilled: [],
        }),
        _buildContextFn: async () => makeFakeContext(),
        _rebuildManifestFn: fakeRebuild,
      });

      assert.strictEqual(rebuildCalled, true, 'rebuildManifest should have been called');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns { path } of the amended file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-return-'));
    try {
      writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');

      const result = await amendRca({
        id: 'abc1234',
        correctionHint: 'fix',
        outputDir: dir,
        cwd: dir,
        config: {},
        systemPromptPath: 'prompts/rca-system.md',
        schemaPath: 'prompts/rca-schema.json',
        _generateFn: async () => ({
          rca: makeFakeRca(),
          cost: 0,
          sessionId: 'fake',
          autoFilled: [],
        }),
        _buildContextFn: async () => makeFakeContext(),
        _rebuildManifestFn: async () => {},
      });

      assert.ok('path' in result, 'result should have a path property');
      assert.ok(result.path.endsWith('.md'), 'path should be a .md file');
      assert.ok(result.path.includes(dir), 'path should be under outputDir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
