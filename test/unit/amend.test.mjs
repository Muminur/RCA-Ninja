import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  installGitleaksStub,
  scannerReceiptMarker,
  scannerRejectPayload,
} from '../fixtures/gitleaks-test-env.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const scannerBootstrapDir = mkdtempSync(join(tmpdir(), 'rca-amend-bootstrap-'));
process.env.PATH = installGitleaksStub(scannerBootstrapDir);
const { amendRca } = await import('../../src/amend.mjs');
process.once('exit', () => rmSync(scannerBootstrapDir, { recursive: true, force: true }));

function makeContext(overrides = {}) {
  return {
    repo_root: REPO_ROOT,
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

function writeFakeRcaFile(dir, filename, frontmatterFields = {}) {
  const frontmatter = {
    title: '"Test RCA"',
    date: '2026-01-01T00:00:00Z',
    ref: 'abc1234',
    branch: 'main',
    confidence: 'high',
    files: ['src/foo.mjs'],
    tags: ['test', 'bugfix'],
    ...frontmatterFields,
  };
  const lines = Object.entries(frontmatter).map(([key, value]) =>
    Array.isArray(value) ? `${key}: [${value.join(', ')}]` : `${key}: ${value}`,
  );
  const path = join(dir, filename);
  writeFileSync(path, `---\n${lines.join('\n')}\n---\n\n## Symptom\n\nSomething broke.\n`, 'utf8');
  return path;
}

function writeTemplates(dir, systemPrompt) {
  const systemPromptPath = join(dir, 'system-prompt.txt');
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(systemPromptPath, systemPrompt, 'utf8');
  writeFileSync(schemaPath, JSON.stringify({ type: 'object' }), 'utf8');
  return { systemPromptPath, schemaPath };
}

describe('amendRca fail-closed generation boundary', () => {
  it('throws NOT_FOUND when outputDir does not exist', async () => {
    const nonExistentDir = join(tmpdir(), `claude-rca-amend-nodir-${Date.now()}`);
    await assert.rejects(
      () =>
        amendRca({
          id: 'any-id',
          correctionHint: 'fix',
          outputDir: nonExistentDir,
          cwd: nonExistentDir,
          config: {},
          systemPromptPath: 'prompts/rca-system.md',
          schemaPath: 'prompts/rca-schema.json',
        }),
      (error) => error.code === 'NOT_FOUND',
    );
  });

  it('throws NOT_FOUND when no RCA matches the requested id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-notfound-'));
    try {
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
        (error) => error.code === 'NOT_FOUND',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores an injected generator and sends amend inputs through the central scanner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-isolation-'));
    const receiptPath = join(dir, 'scanner-receipt.json');
    const target = writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');
    const originalContent = readFileSync(target, 'utf8');
    const { systemPromptPath, schemaPath } = writeTemplates(
      dir,
      `safe prompt ${scannerReceiptMarker(receiptPath)}`,
    );
    const priorRcas = [{ title: 'existing RCA' }];
    let injectedCalls = 0;
    let rebuildCalls = 0;

    try {
      await assert.rejects(
        () =>
          amendRca({
            id: 'abc1234',
            correctionHint: 'preserve the exact causal chain',
            outputDir: dir,
            cwd: dir,
            config: {},
            systemPromptPath,
            schemaPath,
            _buildContextFn: async () => makeContext(),
            _readPriorRcasFn: () => priorRcas,
            _rebuildManifestFn: async () => {
              rebuildCalls += 1;
            },
            _generateFn: async () => {
              injectedCalls += 1;
              return { rca: { title: 'injected bypass' } };
            },
          }),
        (error) => {
          assert.strictEqual(error.code, 'PROVIDER_ISOLATION_UNAVAILABLE');
          assert.strictEqual(
            error.message,
            'No approved isolated provider broker is available; provider execution was refused.',
          );
          return true;
        },
      );

      assert.strictEqual(injectedCalls, 0);
      assert.strictEqual(rebuildCalls, 0);
      assert.strictEqual(readFileSync(target, 'utf8'), originalContent);
      const payload = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.strictEqual(payload.correctionHint, 'preserve the exact causal chain');
      assert.deepStrictEqual(payload.priorRcas, priorRcas);
      assert.strictEqual(payload.context.diff, makeContext().diff);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rethrows a static scanner failure without modifying the existing RCA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-scanner-reject-'));
    const target = writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');
    const originalContent = readFileSync(target, 'utf8');
    const { systemPromptPath, schemaPath } = writeTemplates(dir, scannerRejectPayload());

    try {
      await assert.rejects(
        () =>
          amendRca({
            id: 'abc1234',
            correctionHint: 'private hint must not be sent',
            outputDir: dir,
            cwd: dir,
            config: {},
            systemPromptPath,
            schemaPath,
            _buildContextFn: async () => makeContext(),
          }),
        (error) => {
          assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
          assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
          assert.ok(!error.message.includes('private hint'));
          return true;
        },
      );
      assert.strictEqual(readFileSync(target, 'utf8'), originalContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds an RCA file below the output directory before enforcing the scanner gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-subdir-'));
    try {
      const subDir = join(dir, '2026', '04');
      mkdirSync(subDir, { recursive: true });
      writeFakeRcaFile(subDir, 'RCA-2026-04-01-abc5678-sub-fix.md');
      const { systemPromptPath, schemaPath } = writeTemplates(dir, 'safe prompt');

      await assert.rejects(
        () =>
          amendRca({
            id: 'abc5678',
            correctionHint: 'fix the subdirectory file',
            outputDir: dir,
            cwd: dir,
            config: {},
            systemPromptPath,
            schemaPath,
            _buildContextFn: async () => makeContext(),
          }),
        (error) => error.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps successful persistence covered through an isolated child-process generator fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-child-fixture-'));
    const target = writeFakeRcaFile(dir, 'RCA-2026-01-01-abc1234-test-fix.md');
    const originalContent = readFileSync(target, 'utf8');
    const { systemPromptPath, schemaPath } = writeTemplates(dir, 'safe prompt');
    const entryPath = join(dir, 'amend-entry.mjs');
    const loaderPath = join(dir, 'generator-loader.mjs');
    const fakeGeneratorPath = join(dir, 'fake-generator.mjs');
    const capturePath = join(dir, 'generator-args.json');
    const rebuildPath = join(dir, 'manifest-rebuilt.txt');
    const context = makeContext();
    const priorRcas = [{ title: 'existing RCA' }];
    const fakeRca = {
      title: 'Child fixture RCA',
      symptom: 'A test failed',
      root_cause: 'A missing boundary',
      fix: 'Added a boundary',
      impact: 'Test-only',
      references: [],
      files: ['src/foo.mjs'],
      tags: ['test'],
      confidence: 'high',
      code_changes: [],
      description: '',
      components: [],
    };

    try {
      writeFileSync(
        fakeGeneratorPath,
        [
          "import { writeFileSync } from 'node:fs';",
          'export async function generate(args) {',
          '  writeFileSync(process.env.RCA_NINJA_GENERATOR_CAPTURE, JSON.stringify(args));',
          '  return { rca: ' + JSON.stringify(fakeRca) + ' };',
          '}',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        loaderPath,
        [
          'const target = process.env.RCA_NINJA_GENERATOR_TARGET;',
          'const replacement = process.env.RCA_NINJA_GENERATOR_FIXTURE;',
          'export async function resolve(specifier, context, nextResolve) {',
          '  const candidate = context.parentURL ? new URL(specifier, context.parentURL).href : specifier;',
          '  if (candidate === target) return { url: replacement, shortCircuit: true };',
          '  return nextResolve(specifier, context);',
          '}',
        ].join('\n'),
        'utf8',
      );
      const amendUrl = pathToFileURL(join(REPO_ROOT, 'src', 'amend.mjs')).href;
      const generatorUrl = pathToFileURL(join(REPO_ROOT, 'src', 'generator.mjs')).href;
      writeFileSync(
        entryPath,
        [
          "import { writeFileSync } from 'node:fs';",
          'import { amendRca } from ' + JSON.stringify(amendUrl) + ';',
          'const result = await amendRca({',
          "  id: 'abc1234',",
          "  correctionHint: 'preserve the exact causal chain',",
          '  outputDir: ' + JSON.stringify(dir) + ',',
          '  cwd: ' + JSON.stringify(dir) + ',',
          '  config: {},',
          '  systemPromptPath: ' + JSON.stringify(systemPromptPath) + ',',
          '  schemaPath: ' + JSON.stringify(schemaPath) + ',',
          '  _buildContextFn: async () => (' + JSON.stringify(context) + '),',
          '  _readPriorRcasFn: () => (' + JSON.stringify(priorRcas) + '),',
          "  _rebuildManifestFn: async () => writeFileSync(process.env.RCA_NINJA_REBUILD_MARKER, 'rebuilt'),",
          '});',
          'process.stdout.write(JSON.stringify(result));',
        ].join('\n'),
        'utf8',
      );

      const result = spawnSync(
        process.execPath,
        ['--experimental-loader', pathToFileURL(loaderPath).href, entryPath],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            RCA_NINJA_GENERATOR_CAPTURE: capturePath,
            RCA_NINJA_GENERATOR_FIXTURE: pathToFileURL(fakeGeneratorPath).href,
            RCA_NINJA_GENERATOR_TARGET: generatorUrl,
            RCA_NINJA_REBUILD_MARKER: rebuildPath,
          },
        },
      );

      assert.strictEqual(result.status, 0, result.stdout + '\n' + result.stderr);
      assert.deepStrictEqual(JSON.parse(result.stdout), { path: target });
      assert.ok(readFileSync(target, 'utf8').includes('Child fixture RCA'));
      assert.notStrictEqual(readFileSync(target, 'utf8'), originalContent);
      assert.strictEqual(readFileSync(rebuildPath, 'utf8'), 'rebuilt');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.strictEqual(captured.correctionHint, 'preserve the exact causal chain');
      assert.deepStrictEqual(captured.priorRcas, priorRcas);
      assert.deepStrictEqual(captured.context, context);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
