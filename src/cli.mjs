import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { initProject, loadConfig, getConfigValue, setConfigValue } from './config.mjs';
import { RcaError } from './errors.mjs';
import { buildContext } from './context.mjs';
import { generate, scanForSecrets } from './generator.mjs';
import { renderRca } from './renderer.mjs';
import { writeRca, computeRcaPath } from './writer.mjs';
import { search, recent, show } from './search.mjs';
import { syncToVault, appendDailyNote, buildObsidianUri } from './obsidian.mjs';
import { createObsidianClient } from './obsidian-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require(join(__dirname, '..', 'package.json'));

export function createProgram() {
  const program = new Command();

  program
    .name('claude-rca')
    .description(
      'Local-first CLI that generates structured Root Cause Analysis artifacts from bug-fix commits',
    )
    .version(pkg.version)
    .option('--cwd <path>', 'Run as if from <path>')
    .option('--config <path>', 'Override config file path');

  program
    .command('version')
    .description('Print version')
    .action(() => {
      process.stdout.write(pkg.version + '\n');
    });

  program
    .command('init')
    .description('Scaffold rca/ directory, .claude-rca.json config, and install git hooks')
    .option('--no-hooks', 'Skip git hook installation')
    .action(async (opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const { configPath, rcaDir } = initProject(cwd);
        process.stderr.write(`✓ created ${rcaDir}\n`);
        process.stderr.write(`✓ wrote ${configPath}\n`);

        if (opts.hooks !== false) {
          const hookScript = join(__dirname, '..', 'hooks', 'install-hook.sh');
          try {
            const { spawnSync } = await import('node:child_process');
            const result = spawnSync('bash', [hookScript], {
              cwd,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 10000,
            });
            const out = result.stdout.toString('utf8').trim();
            const errOut = result.stderr.toString('utf8').trim();
            if (out) {
              for (const line of out.split('\n')) {
                if (line) process.stderr.write(`${line}\n`);
              }
            }
            if (result.status !== 0 && !out) {
              process.stderr.write(
                `⚠ git hooks not installed${errOut ? ': ' + errOut : ' (not a git repo?)'}\n`,
              );
            }
          } catch {
            process.stderr.write(`⚠ git hooks not installed (bash not available)\n`);
          }
        }
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('generate')
    .description('Generate an RCA for a commit')
    .option('--from <ref>', 'Git ref to analyze', 'HEAD')
    .option('--message <msg>', 'Override commit message')
    .option('--logs <file>', 'Attach log file')
    .option('--dry-run', 'Print what would be generated without writing')
    .option('--no-obsidian', 'Skip Obsidian sync')
    .option('--no-secret-scan', 'Skip secret scanning of diff')
    .action(async (opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const configPath = program.opts().config;
        const cfg = loadConfig({ cwd, configPath });

        const context = await buildContext({ cwd, ref: opts.from });

        if (!opts.secretScan && scanForSecrets(context.diff)) {
          throw new RcaError('INTERNAL', {
            message: 'Diff may contain secrets. Use --no-secret-scan to bypass.',
          });
        }

        const systemPromptPath = join(__dirname, '..', 'prompts', 'rca-system.md');
        const schemaPath = join(__dirname, '..', 'prompts', 'rca-schema.json');

        if (opts.dryRun) {
          const date = context.timestamp_utc.slice(0, 10);
          const p = computeRcaPath({
            outputDir: cfg.output_dir,
            date,
            shortHash: context.short_hash,
            title: 'dry-run-placeholder',
          });
          process.stdout.write(p + '\n');
          return;
        }

        const { rca } = await generate({ context, config: cfg, systemPromptPath, schemaPath });
        const md = renderRca(rca, context);
        const date = context.timestamp_utc.slice(0, 10);

        const { path: writtenPath } = await writeRca({
          outputDir: cfg.output_dir,
          content: md,
          date,
          shortHash: context.short_hash,
          title: rca.title,
        });

        process.stdout.write(writtenPath + '\n');

        if (opts.obsidian !== false && cfg.obsidian && cfg.obsidian.enabled) {
          try {
            const targetFolder = cfg.obsidian.target_folder || 'RCA Inbox';
            const vaultPath = cfg.obsidian.vault_path;
            const rcaBasename = basename(writtenPath);
            const rcaContent = readFileSync(writtenPath, 'utf8');
            let synced = false;

            if (cfg.obsidian.api_key) {
              try {
                const client = createObsidianClient({
                  apiKey: cfg.obsidian.api_key,
                  host: cfg.obsidian.api_host || '127.0.0.1',
                  port: cfg.obsidian.api_port || 27124,
                  protocol: cfg.obsidian.api_protocol || 'https',
                });
                const notePath = `${targetFolder}/${rcaBasename}`;
                await client.createNote(notePath, rcaContent);
                process.stderr.write(`✓ synced to vault via REST API: ${notePath}\n`);
                synced = true;

                if (cfg.obsidian.update_daily_note) {
                  const dailyNotesFolder = cfg.obsidian.daily_notes_folder || 'Daily Notes';
                  const format = cfg.obsidian.daily_note_format || 'YYYY-MM-DD';
                  const today = new Date().toISOString().slice(0, 10);
                  const noteName = format
                    .replace('YYYY', today.slice(0, 4))
                    .replace('MM', today.slice(5, 7))
                    .replace('DD', today.slice(8, 10));
                  const linkName = rcaBasename.replace(/\.md$/, '');
                  const bullet = `\n- [[${linkName}]] — ${rca.title}\n`;
                  try {
                    await client.appendNote(`${dailyNotesFolder}/${noteName}.md`, bullet);
                    process.stderr.write(`✓ daily note updated via REST API\n`);
                  } catch {
                    process.stderr.write(`⚠ daily note not found (skipped)\n`);
                  }
                }
              } catch (apiErr) {
                process.stderr.write(`⚠ REST API sync failed: ${apiErr.message}\n`);
                process.stderr.write(`  falling back to filesystem sync...\n`);
              }
            }

            if (!synced && vaultPath) {
              await syncToVault({ rcaPath: writtenPath, vaultPath, targetFolder });
              process.stderr.write(
                `✓ synced to vault via filesystem: ${targetFolder}/${rcaBasename}\n`,
              );

              if (cfg.obsidian.update_daily_note) {
                appendDailyNote({
                  vaultPath,
                  dailyNotesFolder: cfg.obsidian.daily_notes_folder || 'Daily Notes',
                  dailyNoteFormat: cfg.obsidian.daily_note_format || 'YYYY-MM-DD',
                  rcaBasename,
                  title: rca.title,
                });
              }
            }

            if (cfg.obsidian.open_on_create && vaultPath) {
              const uri = buildObsidianUri({ vaultPath, targetFolder, rcaBasename });
              process.stderr.write(`✓ obsidian: ${uri}\n`);
            }
          } catch (obsErr) {
            process.stderr.write(`⚠ obsidian sync failed: ${obsErr.message}\n`);
          }
        }
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('search <query>')
    .description('Search RCA corpus via ripgrep')
    .option('--since <date>', 'Filter by date')
    .option('--tag <tag>', 'Filter by tag')
    .option('--json', 'Output as JSON')
    .action(async (query, opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });
        const results = await search({
          outputDir: cfg.output_dir,
          query,
          tag: opts.tag,
          since: opts.since,
          json: opts.json,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        } else if (results.length === 0) {
          process.exit(1);
        } else {
          for (const r of results) {
            process.stdout.write(`${r.path}:${r.line}:${r.text}\n`);
          }
        }
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('recent [count]')
    .description('List most recent RCAs')
    .option('--json', 'Output as JSON')
    .action((count, opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });
        const n = count ? parseInt(count, 10) : 10;
        const results = recent({ outputDir: cfg.output_dir, count: n, json: opts.json });
        if (opts.json) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        } else {
          for (const r of results) {
            process.stdout.write(`${r.basename}  ${r.mtime}\n`);
          }
        }
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('show <id>')
    .description('Display an RCA by ID or path')
    .action((id) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });
        const content = show({ outputDir: cfg.output_dir, id });
        process.stdout.write(content);
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('config')
    .description('Read or write configuration')
    .option('--get <key>', 'Get a config value')
    .option('--set <key=value>', 'Set a config value')
    .option('--list', 'List all config values')
    .action((opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const configPath = program.opts().config;
        const cfg = loadConfig({ cwd, configPath });

        if (opts.get) {
          const val = getConfigValue(cfg, opts.get);
          process.stdout.write(
            (typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)) + '\n',
          );
        } else if (opts.set) {
          const eqIdx = opts.set.indexOf('=');
          if (eqIdx === -1) {
            process.stderr.write('Usage: config --set key=value\n');
            process.exit(1);
          }
          const key = opts.set.slice(0, eqIdx);
          const value = opts.set.slice(eqIdx + 1);
          const projectPath = join(cwd, '.claude-rca.json');
          setConfigValue(projectPath, key, value);
          process.stderr.write(`✓ set ${key}\n`);
        } else {
          process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
        }
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('doctor')
    .description('Check environment: Node, claude, rg, git, vault')
    .action(async () => {
      const { execFileSync: execSync } = await import('node:child_process');
      const checks = [];
      let failures = 0;

      function check(name, fn) {
        try {
          const detail = fn();
          checks.push({ name, status: 'ok', detail });
        } catch (err) {
          failures++;
          checks.push({ name, status: 'FAIL', detail: err.message || String(err) });
        }
      }

      check('node', () => {
        const ver = process.version;
        const major = parseInt(ver.slice(1), 10);
        if (major < 20) {
          throw new RcaError('DOCTOR_UNHEALTHY', { n: 1 });
        }
        return ver;
      });

      check('git', () => {
        const ver = execSync('git', ['--version'], { encoding: 'utf8' }).trim();
        return ver;
      });

      check('rg', () => {
        const ver = execSync('rg', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
        return ver;
      });

      check('claude', () => {
        const ver = execSync('claude', ['--version'], { encoding: 'utf8' }).trim();
        return ver;
      });

      const maxName = Math.max(...checks.map((c) => c.name.length));
      for (const c of checks) {
        process.stdout.write(`${c.name.padEnd(maxName + 2)}${c.status.padEnd(6)}${c.detail}\n`);
      }

      if (failures > 0) {
        process.exit(70);
      }
    });

  const obsidianCmd = program.command('obsidian').description('Obsidian vault integration');

  obsidianCmd
    .command('sync <rca-path>')
    .description('Sync an RCA file to the configured Obsidian vault')
    .option('--open', 'Print obsidian:// URI after sync')
    .action(async (rcaPath, opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });

        if (!cfg.obsidian || (!cfg.obsidian.vault_path && !cfg.obsidian.api_key)) {
          throw new RcaError('NO_VAULT', {});
        }

        const vaultPath = cfg.obsidian.vault_path;
        const targetFolder = cfg.obsidian.target_folder || 'RCA Inbox';
        const resolvedRcaPath = resolvePath(cwd, rcaPath);
        const rcaBasename = basename(resolvedRcaPath);
        const rcaContent = readFileSync(resolvedRcaPath, 'utf8');
        let synced = false;

        if (cfg.obsidian.api_key) {
          try {
            const client = createObsidianClient({
              apiKey: cfg.obsidian.api_key,
              host: cfg.obsidian.api_host || '127.0.0.1',
              port: cfg.obsidian.api_port || 27124,
              protocol: cfg.obsidian.api_protocol || 'https',
            });
            const notePath = `${targetFolder}/${rcaBasename}`;
            await client.createNote(notePath, rcaContent);
            process.stderr.write(`✓ synced via REST API: ${notePath}\n`);
            synced = true;

            if (cfg.obsidian.update_daily_note) {
              const matter = await import('gray-matter');
              const { data } = matter.default(rcaContent);
              const dailyNotesFolder = cfg.obsidian.daily_notes_folder || 'Daily Notes';
              const format = cfg.obsidian.daily_note_format || 'YYYY-MM-DD';
              const today = new Date().toISOString().slice(0, 10);
              const noteName = format
                .replace('YYYY', today.slice(0, 4))
                .replace('MM', today.slice(5, 7))
                .replace('DD', today.slice(8, 10));
              const linkName = rcaBasename.replace(/\.md$/, '');
              const bullet = `\n- [[${linkName}]] — ${data.title || rcaBasename}\n`;
              try {
                await client.appendNote(`${dailyNotesFolder}/${noteName}.md`, bullet);
                process.stderr.write(`✓ daily note updated via REST API\n`);
              } catch {
                process.stderr.write(`⚠ daily note not found (skipped)\n`);
              }
            }
          } catch (apiErr) {
            process.stderr.write(`⚠ REST API failed: ${apiErr.message}\n`);
            if (vaultPath) {
              process.stderr.write(`  falling back to filesystem sync...\n`);
            }
          }
        }

        if (!synced && vaultPath) {
          await syncToVault({ rcaPath: resolvedRcaPath, vaultPath, targetFolder });
          process.stderr.write(`✓ synced via filesystem: ${targetFolder}/${rcaBasename}\n`);

          if (cfg.obsidian.update_daily_note) {
            const matter = await import('gray-matter');
            const { data } = matter.default(rcaContent);
            appendDailyNote({
              vaultPath,
              dailyNotesFolder: cfg.obsidian.daily_notes_folder || 'Daily Notes',
              dailyNoteFormat: cfg.obsidian.daily_note_format || 'YYYY-MM-DD',
              rcaBasename,
              title: data.title || rcaBasename,
            });
            process.stderr.write(`✓ daily note updated\n`);
          }
        }

        if (!synced && !vaultPath) {
          throw new RcaError('NO_VAULT', {});
        }

        if (opts.open && vaultPath) {
          const uri = buildObsidianUri({ vaultPath, targetFolder, rcaBasename });
          process.stdout.write(uri + '\n');
        }
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('mcp-server')
    .description('Start the MCP (Model Context Protocol) server for Claude integration')
    .action(async () => {
      const { startMcpServer } = await import('./mcp-server.mjs');
      const cwd = program.opts().cwd || process.cwd();
      await startMcpServer({ cwd });
    });

  return program;
}

export function main(argv) {
  const program = createProgram();
  program.parse(argv);
}
