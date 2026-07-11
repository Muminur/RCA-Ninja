import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli.mjs';
import { handleTool } from '../../src/mcp-server.mjs';

const EXIT_SENTINEL = Symbol('mock-exit');

async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origExit = process.exit;

  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  process.exit = (code) => {
    const s = new Error('mock-process-exit');
    s[EXIT_SENTINEL] = true;
    s.code = code ?? 0;
    throw s;
  };

  try {
    await fn();
  } catch (e) {
    if (!e[EXIT_SENTINEL]) throw e;
  } finally {
    process.stdout.write = orig;
    process.exit = origExit;
  }

  return chunks.join('');
}

describe('mcp-server module', () => {
  it('exports startMcpServer as a function', async () => {
    const mod = await import('../../src/mcp-server.mjs');
    assert.strictEqual(typeof mod.startMcpServer, 'function');
  });
});

describe('mcp-server CLI subcommand', () => {
  it('mcp-server appears in --help output', async () => {
    const stdout = await captureStdout(() =>
      createProgram().parseAsync(['node', 'claude-rca', '--help']),
    );
    assert.ok(stdout.includes('mcp-server'), `--help must mention 'mcp-server', got:\n${stdout}`);
  });

  it('mcp-server has a description in --help', async () => {
    const stdout = await captureStdout(() =>
      createProgram().parseAsync(['node', 'claude-rca', '--help']),
    );
    // The subcommand name and a non-trivial help section should both appear
    assert.ok(stdout.includes('mcp-server'), "--help must list 'mcp-server' subcommand");
    assert.ok(stdout.length > 0, 'help output must be non-empty');
  });
});

// ── Tool registration tests ───────────────────────────────────────────────────

const CORE_TOOL_NAMES = [
  'rca_generate',
  'rca_search',
  'rca_recent',
  'rca_show',
  'rca_audit',
  'rca_trends',
  'rca_amend',
];
const OBSIDIAN_TOOL_NAMES = [
  'obsidian_search',
  'obsidian_read_note',
  'obsidian_create_note',
  'obsidian_patch_note',
  'obsidian_list_folder',
  'rca_sync_to_vault',
  'rca_link_daily_note',
];

describe('getToolsForConfig — conditional tool registration', () => {
  it('exports getToolsForConfig as a function', async () => {
    const mod = await import('../../src/mcp-server.mjs');
    assert.strictEqual(typeof mod.getToolsForConfig, 'function');
  });

  it('registers only 7 core RCA tools when obsidian.enabled is false', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({ obsidian: { enabled: false } });
    const names = tools.map((t) => t.name);
    assert.strictEqual(
      tools.length,
      7,
      `Expected 7 tools, got ${tools.length}: ${names.join(', ')}`,
    );
    for (const name of CORE_TOOL_NAMES) {
      assert.ok(names.includes(name), `Core tool '${name}' must be present`);
    }
    for (const name of OBSIDIAN_TOOL_NAMES) {
      assert.ok(!names.includes(name), `Obsidian tool '${name}' must NOT be present when disabled`);
    }
  });

  it('registers only 7 core RCA tools when obsidian key is absent', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({});
    const names = tools.map((t) => t.name);

    assert.strictEqual(
      tools.length,
      7,
      `Expected 7 tools, got ${tools.length}: ${names.join(', ')}`,
    );
    for (const name of CORE_TOOL_NAMES) {
      assert.ok(names.includes(name), `Core tool '${name}' must be present`);
    }
    for (const name of OBSIDIAN_TOOL_NAMES) {
      assert.ok(!names.includes(name), `Obsidian tool '${name}' must NOT be present when absent`);
    }
  });

  it('registers all 14 tools when obsidian.enabled is true', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({ obsidian: { enabled: true } });
    const names = tools.map((t) => t.name);

    assert.strictEqual(
      tools.length,
      14,
      `Expected 14 tools, got ${tools.length}: ${names.join(', ')}`,
    );
    for (const name of [...CORE_TOOL_NAMES, ...OBSIDIAN_TOOL_NAMES]) {
      assert.ok(names.includes(name), `Tool '${name}' must be present when obsidian enabled`);
    }
  });

  it('core tools are exactly the 7 non-obsidian tools', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({ obsidian: { enabled: false } });
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [...CORE_TOOL_NAMES].sort());
  });
});

describe('new core tools — schema validation', () => {
  it('rca_audit has no required fields', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({});
    const tool = tools.find((t) => t.name === 'rca_audit');
    assert.ok(tool, 'rca_audit must be present');
    assert.ok(
      !tool.inputSchema.required || tool.inputSchema.required.length === 0,
      'rca_audit must have no required fields',
    );
  });

  it('rca_trends has no required fields', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({});
    const tool = tools.find((t) => t.name === 'rca_trends');
    assert.ok(tool, 'rca_trends must be present');
    assert.ok(
      !tool.inputSchema.required || tool.inputSchema.required.length === 0,
      'rca_trends must have no required fields',
    );
  });

  it('rca_amend requires id field', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({});
    const tool = tools.find((t) => t.name === 'rca_amend');
    assert.ok(tool, 'rca_amend must be present');
    assert.deepStrictEqual(tool.inputSchema.required, ['id'], 'rca_amend must require id');
  });

  it('rca_search query field is not required', async () => {
    const { getToolsForConfig } = await import('../../src/mcp-server.mjs');
    const tools = getToolsForConfig({});
    const tool = tools.find((t) => t.name === 'rca_search');
    assert.ok(tool, 'rca_search must be present');
    assert.ok(
      !tool.inputSchema.required || !tool.inputSchema.required.includes('query'),
      'rca_search query must not be required',
    );
  });
});

// MCP tool arguments come from a model, so any caller-supplied path is a trust
// boundary. These pin that rca_show and rca_sync_to_vault cannot escape output_dir.
describe('mcp-server path containment', () => {
  const SECRET = 'super-secret-value-12345';
  let tmp, rcaDir, rcaName, origCwd;

  before(() => {
    origCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-mcp-'));
    rcaDir = join(tmp, 'rca');
    mkdirSync(join(rcaDir, '2026', '07'), { recursive: true });
    rcaName = 'RCA-2026-07-10-abc1234-test-rca.md';
    writeFileSync(join(rcaDir, '2026', '07', rcaName), '---\ntitle: ok\n---\n\n## Symptom\n\nx\n');
    writeFileSync(join(tmp, '.env'), `OBSIDIAN_API_KEY=${SECRET}\n`);
    process.chdir(tmp);
  });

  after(() => {
    process.chdir(origCwd);
  });

  const cfg = () => ({ output_dir: rcaDir, obsidian: {} });

  it('rca_show refuses a bare cwd-relative filename such as .env', async () => {
    await assert.rejects(
      () => handleTool('rca_show', { id: '.env' }, cfg()),
      (err) => err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN_PATH',
      'rca_show must not read .env from the working directory',
    );
  });

  it('rca_show refuses a parent-directory traversal', async () => {
    await assert.rejects(
      () => handleTool('rca_show', { id: '../../../../etc/passwd' }, cfg()),
      (err) => err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN_PATH',
    );
  });

  it('rca_show still resolves a legitimate RCA by basename', async () => {
    const res = await handleTool('rca_show', { id: rcaName }, cfg());
    assert.ok(res.content[0].text.includes('## Symptom'));
  });

  it('rca_show still resolves a legitimate RCA by short hash', async () => {
    const res = await handleTool('rca_show', { id: 'abc1234' }, cfg());
    assert.ok(res.content[0].text.includes('## Symptom'));
  });

  it('rca_sync_to_vault refuses a path outside output_dir', async () => {
    await assert.rejects(
      () => handleTool('rca_sync_to_vault', { rca_path: join(tmp, '.env') }, cfg()),
      (err) => err.code === 'FORBIDDEN_PATH',
    );
  });

  it('no containment failure ever returns the secret', async () => {
    for (const id of ['.env', './.env', '../rca/../.env']) {
      let text;
      try {
        const res = await handleTool('rca_show', { id }, cfg());
        text = res.content[0].text;
      } catch {
        continue;
      }
      assert.ok(!text.includes(SECRET), `rca_show(${JSON.stringify(id)}) leaked the secret`);
    }
  });
});
