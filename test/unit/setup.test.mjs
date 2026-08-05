import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('keeps automatic generation disabled until provider isolation is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-setup-isolation-'));
    try {
      const child = spawn('node', [BIN, '--cwd', dir, 'setup'], {
        cwd: ROOT,
        env: { ...process.env, HOME: dir, USERPROFILE: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let responseStage = 0;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (responseStage === 0 && stderr.includes('Use this vault?')) {
          responseStage = 1;
          child.stdin.write('n\n');
        } else if (responseStage === 0 && stderr.includes('Enter vault path')) {
          responseStage = 2;
          child.stdin.write('\n');
        } else if (responseStage === 1 && stderr.includes('Enter vault path')) {
          responseStage = 2;
          child.stdin.write('\n');
        } else if (responseStage === 2 && stderr.includes('Enable Obsidian REST API sync?')) {
          responseStage = 3;
          child.stdin.end('\n');
        }
      });
      const [status] = await once(child, 'close');
      assert.strictEqual(status, 0, stderr);
      const config = JSON.parse(readFileSync(join(dir, '.claude-rca.json'), 'utf8'));
      assert.strictEqual(config.auto_generate, false);
      assert.ok(/auto_generate:\s+false/i.test(stderr));
      assert.ok(/isolation.*unavailable|unavailable.*isolation/i.test(stderr));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setup command source never writes api_key to .claude-rca.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const cliSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.mjs'),
      'utf8',
    );
    const setupSection = cliSource.slice(
      cliSource.indexOf("command('setup')"),
      cliSource.indexOf("command('generate')"),
    );
    assert.ok(
      !setupSection.includes('setConfigValue') || !setupSection.includes('api_key'),
      'setup command must not write api_key via setConfigValue — use .env instead',
    );
    assert.ok(
      setupSection.includes('OBSIDIAN_API_KEY'),
      'setup command must write OBSIDIAN_API_KEY to .env',
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
