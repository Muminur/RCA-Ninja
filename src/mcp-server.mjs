import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { buildContext } from './context.mjs';
import { generate } from './generator.mjs';
import { RcaError } from './errors.mjs';
import { renderRca } from './renderer.mjs';
import { writeRca } from './writer.mjs';
import { search, recent, show } from './search.mjs';
import { createObsidianClient } from './obsidian-api.mjs';
import { syncToVault, appendDailyNote } from './obsidian.mjs';
import { auditCorpus } from './audit.mjs';
import { computeTrends } from './trends.mjs';
import { amendRca } from './amend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CORE_TOOLS = [
  {
    name: 'rca_generate',
    description:
      'Generate a Root Cause Analysis for a git commit. Analyzes the diff and produces a structured RCA document.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to analyze (default: HEAD)', default: 'HEAD' },
        cwd: { type: 'string', description: 'Working directory of the git repo' },
        dry_run: { type: 'boolean', description: 'Print path without writing', default: false },
      },
    },
  },
  {
    name: 'rca_search',
    description: 'Search the RCA corpus using ripgrep full-text search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (omit to filter by tag/since/files only)',
        },
        tag: { type: 'string', description: 'Filter by tag' },
        since: { type: 'string', description: 'Filter by date (YYYY-MM-DD)' },
        files: { type: 'string', description: 'Filter by file path substring' },
      },
    },
  },
  {
    name: 'rca_recent',
    description: 'List the N most recently modified RCA documents.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of RCAs to return (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'rca_show',
    description: 'Read and display a specific RCA by ID, commit hash, or filename.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'RCA identifier (filename, short hash, or full path)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'rca_audit',
    description:
      'Audit the RCA corpus for degraded documents where fields were auto-filled during generation.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory of the git repo' },
      },
    },
  },
  {
    name: 'rca_trends',
    description:
      'Show tag, file, and component frequency trends across the RCA corpus. Identifies bug-prone hotspots.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory of the git repo' },
      },
    },
  },
  {
    name: 'rca_amend',
    description:
      'Re-generate an existing RCA in place, optionally with a correction hint to guide the analyst.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'RCA identifier (short hash, basename, or full path)' },
        correction_hint: { type: 'string', description: 'Optional guidance for improving the RCA' },
        cwd: { type: 'string', description: 'Working directory of the git repo' },
      },
      required: ['id'],
    },
  },
];

const OBSIDIAN_TOOLS = [
  {
    name: 'obsidian_search',
    description:
      'Full-text search inside the Obsidian vault using the Local REST API. More powerful than ripgrep — searches all indexed notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
      },
      required: ['query'],
    },
  },
  {
    name: 'obsidian_read_note',
    description: 'Read the contents of a note from the Obsidian vault.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note within the vault (e.g. "RCA Inbox/my-note.md")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'obsidian_create_note',
    description: 'Create a new note in the Obsidian vault.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path for the new note (e.g. "RCA Inbox/new-note.md")',
        },
        content: { type: 'string', description: 'Markdown content for the note' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'obsidian_patch_note',
    description: 'Insert or append content at a specific heading or block in an Obsidian note.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the note' },
        content: { type: 'string', description: 'Content to insert' },
        heading: { type: 'string', description: 'Target heading to insert under (optional)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'obsidian_list_folder',
    description: 'List files and folders in a vault directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder path within the vault (default: root)',
          default: '/',
        },
      },
    },
  },
  {
    name: 'rca_sync_to_vault',
    description:
      'Sync an RCA file to the Obsidian vault. Uses REST API if configured, falls back to filesystem copy.',
    inputSchema: {
      type: 'object',
      properties: {
        rca_path: { type: 'string', description: 'Path to the RCA file to sync' },
      },
      required: ['rca_path'],
    },
  },
  {
    name: 'rca_link_daily_note',
    description:
      "Append a wikilink to today's daily note referencing an RCA. Uses REST API PATCH if configured.",
    inputSchema: {
      type: 'object',
      properties: {
        rca_basename: {
          type: 'string',
          description: 'RCA filename (e.g. "RCA-2026-04-30-a3f2c1d-fix-session.md")',
        },
        title: { type: 'string', description: 'RCA title for the wikilink label' },
      },
      required: ['rca_basename', 'title'],
    },
  },
];

/**
 * Returns the list of MCP tools to register based on config.
 * Obsidian tools (7) are only included when obsidian.enabled === true,
 * saving 2000-3500 tokens per turn when Obsidian is not in use.
 *
 * @param {object} cfg - Loaded config object
 * @returns {Array} Tools array to register with the MCP server
 */
export function getToolsForConfig(cfg) {
  if (cfg?.obsidian?.enabled === true) {
    return [...CORE_TOOLS, ...OBSIDIAN_TOOLS];
  }
  return [...CORE_TOOLS];
}

function getObsidianClient(cfg) {
  if (!cfg.obsidian?.api_key) return null;
  return createObsidianClient({
    apiKey: cfg.obsidian.api_key,
    host: cfg.obsidian.api_host || '127.0.0.1',
    port: cfg.obsidian.api_port || 27124,
    protocol: cfg.obsidian.api_protocol || 'https',
  });
}

async function handleTool(name, args, cfg, dependencies = {}) {
  const cwd = args.cwd || process.cwd();

  switch (name) {
    case 'rca_generate': {
      const ref = args.ref || 'HEAD';
      const buildContextFn = dependencies.buildContext || buildContext;
      const generateFn = dependencies.generate || generate;
      const context = await buildContextFn({ cwd, ref });

      const systemPromptPath = join(__dirname, '..', 'prompts', 'rca-system.md');
      const schemaPath = join(__dirname, '..', 'prompts', 'rca-schema.json');

      const { rca } = await generateFn({ context, config: cfg, systemPromptPath, schemaPath });
      const md = renderRca(rca, context);
      const date = context.timestamp_utc.slice(0, 10);

      const { path: writtenPath } = await writeRca({
        outputDir: cfg.output_dir,
        content: md,
        date,
        shortHash: context.short_hash,
        title: rca.title,
      });

      return {
        content: [
          {
            type: 'text',
            text: `RCA generated: ${writtenPath}\n\nTitle: ${rca.title}\nConfidence: ${rca.confidence}\nTags: ${rca.tags.join(', ')}`,
          },
        ],
      };
    }

    case 'rca_search': {
      if (!args.query && !args.tag && !args.since && !args.files) {
        return {
          content: [
            {
              type: 'text',
              text: 'rca_search requires at least one of: query, tag, since, files.',
            },
          ],
          isError: true,
        };
      }
      const results = await search({
        outputDir: cfg.output_dir,
        query: args.query,
        tag: args.tag,
        since: args.since,
        files: args.files,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No RCAs found matching the query.' }] };
      }
      const text = results.map((r) => `${r.path}:${r.line}:${r.text}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${results.length} matches:\n\n${text}` }] };
    }

    case 'rca_recent': {
      const count = args.count || 10;
      const results = recent({ outputDir: cfg.output_dir, count });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No RCAs found.' }] };
      }
      const text = results.map((r) => `${r.basename}  ${r.mtime}`).join('\n');
      return { content: [{ type: 'text', text: text }] };
    }

    case 'rca_show': {
      const content = show({ outputDir: cfg.output_dir, id: args.id });
      return { content: [{ type: 'text', text: content }] };
    }

    case 'rca_audit': {
      const { degraded, clean_count } = await auditCorpus({ outputDir: cfg.output_dir });
      const text =
        degraded.length > 0
          ? `${degraded.length} degraded RCAs:\n${degraded.map((d) => `  ${d.path} (auto_filled: ${(d.auto_filled || []).join(', ')})`).join('\n')}\n\n${clean_count} clean.`
          : `All ${clean_count} RCAs pass quality audit.`;
      return { content: [{ type: 'text', text }] };
    }

    case 'rca_trends': {
      const trends = await computeTrends({ outputDir: cfg.output_dir });
      const lines = [
        `Total RCAs: ${trends.total}`,
        `Top tags: ${Object.entries(trends.tag_counts)
          .slice(0, 5)
          .map(([t, n]) => `${t}(${n})`)
          .join(', ')}`,
        `Top files: ${Object.entries(trends.file_counts)
          .slice(0, 5)
          .map(([f, n]) => `${f}(${n})`)
          .join(', ')}`,
        trends.recurrent_files.length > 0
          ? `Hotspots: ${trends.recurrent_files.map((r) => `${r.file}(${r.count})`).join(', ')}`
          : 'No recurrent files.',
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'rca_amend': {
      if (!args.id) {
        return {
          content: [{ type: 'text', text: 'rca_amend requires an id argument.' }],
          isError: true,
        };
      }
      const amendSystemPromptPath = join(__dirname, '..', 'prompts', 'rca-system.md');
      const amendSchemaPath = join(__dirname, '..', 'prompts', 'rca-schema.json');
      const { path: amendedPath } = await amendRca({
        id: args.id,
        correctionHint: args.correction_hint,
        outputDir: cfg.output_dir,
        cwd,
        config: cfg,
        systemPromptPath: amendSystemPromptPath,
        schemaPath: amendSchemaPath,
      });
      return { content: [{ type: 'text', text: `RCA amended: ${amendedPath}` }] };
    }

    case 'obsidian_search': {
      const client = getObsidianClient(cfg);
      if (!client) {
        return {
          content: [
            {
              type: 'text',
              text: 'Obsidian REST API not configured. Set obsidian.api_key in .claude-rca.json.',
            },
          ],
          isError: true,
        };
      }
      const results = await client.searchVault(args.query);
      const text = typeof results === 'string' ? results : JSON.stringify(results, null, 2);
      return { content: [{ type: 'text', text: text }] };
    }

    case 'obsidian_read_note': {
      const client = getObsidianClient(cfg);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Obsidian REST API not configured.' }],
          isError: true,
        };
      }
      const content = await client.readNote(args.path);
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return { content: [{ type: 'text', text: text }] };
    }

    case 'obsidian_create_note': {
      const client = getObsidianClient(cfg);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Obsidian REST API not configured.' }],
          isError: true,
        };
      }
      await client.createNote(args.path, args.content);
      return { content: [{ type: 'text', text: `Note created: ${args.path}` }] };
    }

    case 'obsidian_patch_note': {
      const client = getObsidianClient(cfg);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Obsidian REST API not configured.' }],
          isError: true,
        };
      }
      await client.patchNote(args.path, args.content, { heading: args.heading });
      return { content: [{ type: 'text', text: `Note patched: ${args.path}` }] };
    }

    case 'obsidian_list_folder': {
      const client = getObsidianClient(cfg);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Obsidian REST API not configured.' }],
          isError: true,
        };
      }
      const folderPath = args.path || '/';
      const results = await client.listFolder(folderPath);
      const text = typeof results === 'string' ? results : JSON.stringify(results, null, 2);
      return { content: [{ type: 'text', text: text }] };
    }

    case 'rca_sync_to_vault': {
      const client = getObsidianClient(cfg);
      if (client) {
        const content = readFileSync(args.rca_path, 'utf8');
        const { basename } = await import('node:path');
        const targetFolder = cfg.obsidian.target_folder || 'RCA Inbox';
        const notePath = `${targetFolder}/${basename(args.rca_path)}`;
        await client.createNote(notePath, content);
        return { content: [{ type: 'text', text: `Synced via REST API: ${notePath}` }] };
      }
      if (cfg.obsidian?.vault_path) {
        const destFile = await syncToVault({
          rcaPath: args.rca_path,
          vaultPath: cfg.obsidian.vault_path,
          targetFolder: cfg.obsidian.target_folder || 'RCA Inbox',
        });
        return { content: [{ type: 'text', text: `Synced via filesystem: ${destFile}` }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: 'No Obsidian vault configured (set obsidian.vault_path or obsidian.api_key).',
          },
        ],
        isError: true,
      };
    }

    case 'rca_link_daily_note': {
      const client = getObsidianClient(cfg);
      const dailyNotesFolder = cfg.obsidian?.daily_notes_folder || 'Daily Notes';
      const format = cfg.obsidian?.daily_note_format || 'YYYY-MM-DD';
      const today = new Date().toISOString().slice(0, 10);
      const noteName = format
        .replace('YYYY', today.slice(0, 4))
        .replace('MM', today.slice(5, 7))
        .replace('DD', today.slice(8, 10));
      const linkName = args.rca_basename.replace(/\.md$/, '');
      const bullet = `\n- [[${linkName}]] — ${args.title}\n`;

      if (client) {
        const notePath = `${dailyNotesFolder}/${noteName}.md`;
        await client.appendNote(notePath, bullet);
        return {
          content: [{ type: 'text', text: `Wikilink appended to ${notePath} via REST API` }],
        };
      }
      if (cfg.obsidian?.vault_path) {
        const result = appendDailyNote({
          vaultPath: cfg.obsidian.vault_path,
          dailyNotesFolder,
          dailyNoteFormat: format,
          rcaBasename: args.rca_basename,
          title: args.title,
        });
        return {
          content: [
            {
              type: 'text',
              text: result ? `Wikilink appended to ${result}` : 'Daily note not found (skipped).',
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'No Obsidian vault configured.' }], isError: true };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function staticToolError(err) {
  if (err?.code === 'SECRET_SCAN_FAILED' || err?.code === 'SECRET_SCANNER_UNAVAILABLE') {
    return new RcaError(err.code).message;
  }
  return err instanceof Error ? err.message : 'Tool request failed.';
}

export async function dispatchToolRequest({ name, args = {}, cfg, dependencies } = {}) {
  try {
    return await handleTool(name, args, cfg, dependencies);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${staticToolError(err)}` }],
      isError: true,
    };
  }
}

export async function startMcpServer({ cwd } = {}) {
  const cfg = loadConfig({ cwd });
  const tools = getToolsForConfig(cfg);

  const server = new Server(
    { name: 'codex-rca', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolRequest({ name, args: args || {}, cfg });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
