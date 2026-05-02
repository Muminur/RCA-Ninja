import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../../src/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');

describe('setup command', () => {
  it('setup command exists in help output', () => {
    const out = execFileSync('node', [BIN, '--help'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.ok(out.includes('setup'), 'help output should mention "setup"');
  });

  it('setup command appears in createProgram commands list', () => {
    const program = createProgram();
    const commands = program.commands.map((c) => c.name());
    assert.ok(commands.includes('setup'), `expected "setup" in commands: ${commands.join(', ')}`);
  });

  it('setup command has the expected description', () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === 'setup');
    assert.ok(cmd, 'setup command should exist');
    assert.ok(
      cmd.description().toLowerCase().includes('wizard') ||
        cmd.description().toLowerCase().includes('setup') ||
        cmd.description().toLowerCase().includes('configure'),
      `description should describe the wizard: "${cmd.description()}"`,
    );
  });

  it('init command source includes PATH verification logic', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const cliSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.mjs'),
      'utf8',
    );
    assert.ok(
      cliSource.includes('claude-rca') && cliSource.includes('on PATH'),
      'init command must verify claude-rca is on PATH after hook installation',
    );
  });
});
