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
    .description('Scaffold rca/ directory and .claude-rca.json config')
    .action(() => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const { configPath, rcaDir } = initProject(cwd);
        process.stderr.write(`✓ created ${rcaDir}\n`);
        process.stderr.write(`✓ wrote ${configPath}\n`);
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

            await syncToVault({ rcaPath: writtenPath, vaultPath, targetFolder });
            process.stderr.write(`✓ synced to vault: ${targetFolder}/${rcaBasename}\n`);

            if (cfg.obsidian.update_daily_note) {
              appendDailyNote({
                vaultPath,
                dailyNotesFolder: cfg.obsidian.daily_notes_folder || 'Daily Notes',
                dailyNoteFormat: cfg.obsidian.daily_note_format || 'YYYY-MM-DD',
                rcaBasename,
                title: rca.title,
              });
            }

            if (cfg.obsidian.open_on_create) {
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

        if (!cfg.obsidian || !cfg.obsidian.vault_path) {
          throw new RcaError('NO_VAULT', {});
        }

        const vaultPath = cfg.obsidian.vault_path;
        const targetFolder = cfg.obsidian.target_folder || 'RCA Inbox';
        const resolvedRcaPath = resolvePath(cwd, rcaPath);
        const rcaBasename = basename(resolvedRcaPath);

        const destFile = await syncToVault({
          rcaPath: resolvedRcaPath,
          vaultPath,
          targetFolder,
        });
        process.stderr.write(`✓ synced to ${destFile}\n`);

        if (cfg.obsidian.update_daily_note) {
          const matter = await import('gray-matter');
          const content = readFileSync(resolvedRcaPath, 'utf8');
          const { data } = matter.default(content);
          appendDailyNote({
            vaultPath,
            dailyNotesFolder: cfg.obsidian.daily_notes_folder || 'Daily Notes',
            dailyNoteFormat: cfg.obsidian.daily_note_format || 'YYYY-MM-DD',
            rcaBasename,
            title: data.title || rcaBasename,
          });
          process.stderr.write(`✓ daily note updated\n`);
        }

        if (opts.open) {
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

  return program;
}

export function main(argv) {
  const program = createProgram();
  program.parse(argv);
}
