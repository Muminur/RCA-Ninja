import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProgram } from '../../src/cli.mjs';

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
