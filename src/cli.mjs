import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
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
import { sendWebhook } from './webhook.mjs';
import { createProgress } from './progress.mjs';
import { resolveTemplatePaths } from './template.mjs';
import { auditCorpus } from './audit.mjs';
import { findRelatedRcas } from './dedup.mjs';

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

          // After hook installation, verify claude-rca is on PATH
          try {
            const { spawnSync: spawnCheck } = await import('node:child_process');
            const which = spawnCheck(
              process.platform === 'win32' ? 'where.exe' : 'which',
              ['claude-rca'],
              { shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
            );
            if (which.status !== 0) {
              process.stderr.write(
                `⚠ claude-rca is not on PATH — the post-commit hook will not fire.\n`,
              );
              process.stderr.write(`  Run: cd ${join(__dirname, '..')} && npm link\n`);
            } else {
              process.stderr.write(`✓ claude-rca is on PATH\n`);
            }
          } catch {
            process.stderr.write(`⚠ could not verify claude-rca on PATH\n`);
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
    .command('setup')
    .description('Interactive setup wizard — configure vault, API keys, and environment')
    .action(async () => {
      function ask(question) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        return new Promise((resolve) => {
          rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });
      }

      try {
        const cwd = program.opts().cwd || process.cwd();
        const configPath = join(cwd, '.claude-rca.json');

        // Step 1: Run init if .claude-rca.json doesn't exist
        if (!existsSync(configPath)) {
          process.stderr.write('No .claude-rca.json found — running init...\n');
          const { rcaDir } = initProject(cwd);
          process.stderr.write(`✓ created ${rcaDir}\n`);
          process.stderr.write(`✓ wrote ${configPath}\n`);
        } else {
          process.stderr.write(`✓ config already exists at ${configPath}\n`);
        }

        // Step 2: Detect Obsidian vault
        const home = homedir();
        const candidatePaths = [
          join(home, 'Documents', 'Obsidian Vault'),
          join(home, 'Documents', 'Obsidian'),
          join(home, 'Obsidian'),
        ];
        let detectedVault = null;
        for (const p of candidatePaths) {
          if (existsSync(p)) {
            detectedVault = p;
            break;
          }
        }

        let vaultPath = null;
        if (detectedVault) {
          process.stderr.write(`\nDetected Obsidian vault at: ${detectedVault}\n`);
          const confirm = await ask(`Use this vault? [Y/n] `);
          if (confirm === '' || confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
            vaultPath = detectedVault;
          } else {
            const custom = await ask('Enter vault path (leave blank to skip): ');
            if (custom) vaultPath = resolvePath(cwd, custom);
          }
        } else {
          process.stderr.write('\nNo Obsidian vault detected in common locations.\n');
          const custom = await ask('Enter vault path (leave blank to skip): ');
          if (custom) vaultPath = resolvePath(cwd, custom);
        }

        // Step 3: Ask if they want REST API sync
        const wantApi = await ask('\nEnable Obsidian REST API sync? [y/N] ');
        if (wantApi.toLowerCase() === 'y' || wantApi.toLowerCase() === 'yes') {
          const apiKey = await ask('Enter Obsidian REST API key: ');
          if (apiKey) {
            const { atomicWrite } = await import('./util/fs.mjs');
            const envPath = join(cwd, '.env');
            let existing = '';
            if (existsSync(envPath)) {
              existing = readFileSync(envPath, 'utf8');
              // Remove any existing OBSIDIAN_API_KEY line
              existing = existing
                .split('\n')
                .filter((line) => !line.startsWith('OBSIDIAN_API_KEY='))
                .join('\n');
              if (existing && !existing.endsWith('\n')) existing += '\n';
            }
            await atomicWrite(envPath, existing + `OBSIDIAN_API_KEY=${apiKey}\n`);
            process.stderr.write(`✓ wrote OBSIDIAN_API_KEY to .env\n`);
          }
        }

        // Step 4: Set auto_generate=true
        setConfigValue(configPath, 'auto_generate', 'true');
        process.stderr.write(`✓ set auto_generate=true\n`);

        // Step 5: Set obsidian.enabled=true with vault path
        if (vaultPath) {
          setConfigValue(configPath, 'obsidian.enabled', 'true');
          setConfigValue(configPath, 'obsidian.vault_path', vaultPath);
          process.stderr.write(`✓ set obsidian.enabled=true\n`);
          process.stderr.write(`✓ set obsidian.vault_path=${vaultPath}\n`);
        }

        // Step 6: Run doctor to verify
        process.stderr.write('\nRunning doctor checks...\n');
        const { execFileSync: execSync } = await import('node:child_process');
        const doctorChecks = [];
        let doctorFailures = 0;

        function doctorCheck(name, fn) {
          try {
            const detail = fn();
            doctorChecks.push({ name, status: 'ok', detail });
          } catch (err) {
            doctorFailures++;
            doctorChecks.push({ name, status: 'FAIL', detail: err.message || String(err) });
          }
        }

        doctorCheck('node', () => {
          const ver = process.version;
          const major = parseInt(ver.slice(1), 10);
          if (major < 20) throw new RcaError('DOCTOR_UNHEALTHY', { n: 1 });
          return ver;
        });

        doctorCheck('git', () => execSync('git', ['--version'], { encoding: 'utf8' }).trim());

        doctorCheck(
          'rg',
          () => execSync('rg', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0],
        );

        doctorCheck('claude', () => execSync('claude', ['--version'], { encoding: 'utf8' }).trim());

        const maxName = Math.max(...doctorChecks.map((c) => c.name.length));
        for (const c of doctorChecks) {
          process.stderr.write(`  ${c.name.padEnd(maxName + 2)}${c.status.padEnd(6)}${c.detail}\n`);
        }

        // Step 7: Print summary
        process.stderr.write('\n--- Setup complete ---\n');
        process.stderr.write(`  Config:       ${configPath}\n`);
        process.stderr.write(`  auto_generate: true\n`);
        if (vaultPath) {
          process.stderr.write(`  Vault:        ${vaultPath}\n`);
        } else {
          process.stderr.write(`  Vault:        (not configured)\n`);
        }
        if (doctorFailures > 0) {
          process.stderr.write(
            `  Doctor:       ${doctorFailures} check(s) failed — run "claude-rca doctor" for details\n`,
          );
        } else {
          process.stderr.write(`  Doctor:       all checks passed\n`);
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
      const progress = createProgress();
      const overallStart = Date.now();

      try {
        const cwd = program.opts().cwd || process.cwd();
        const configPath = program.opts().config;
        const cfg = loadConfig({ cwd, configPath });

        progress.start('Extracting context');
        const context = await buildContext({ cwd, ref: opts.from });

        progress.update('Scanning for secrets');
        if (!opts.secretScan && scanForSecrets(context.diff)) {
          progress.fail('Secret scan failed');
          throw new RcaError('INTERNAL', {
            message: 'Diff may contain secrets. Use --no-secret-scan to bypass.',
          });
        }

        const defaultSystemPromptPath = join(__dirname, '..', 'prompts', 'rca-system.md');
        const defaultSchemaPath = join(__dirname, '..', 'prompts', 'rca-schema.json');
        const { schemaPath, systemPromptPath } = resolveTemplatePaths(
          cwd,
          defaultSchemaPath,
          defaultSystemPromptPath,
        );

        if (opts.dryRun) {
          progress.stop('Dry run — no file written');
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

        const relatedRcas = findRelatedRcas({
          outputDir: cfg.output_dir,
          filesChanged: context.files_changed,
        });
        if (relatedRcas.length > 0) {
          process.stderr.write(`⚠ Found ${relatedRcas.length} related RCA(s):\n`);
          for (const r of relatedRcas) {
            process.stderr.write(
              `  - ${r.title} (${Math.round(r.overlap_score * 100)}% overlap)\n`,
            );
          }
        }

        progress.update('Calling Claude');
        const { rca } = await generate({
          context,
          config: cfg,
          systemPromptPath,
          schemaPath,
        });

        progress.update('Validating and rendering');
        const md = renderRca(rca, context);
        const date = context.timestamp_utc.slice(0, 10);

        progress.update('Writing RCA');
        const { path: writtenPath } = await writeRca({
          outputDir: cfg.output_dir,
          content: md,
          date,
          shortHash: context.short_hash,
          title: rca.title,
        });

        process.stdout.write(writtenPath + '\n');

        if (opts.obsidian !== false && cfg.obsidian && cfg.obsidian.enabled) {
          progress.update('Syncing to Obsidian');
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

        // Webhook notification (non-blocking, like Obsidian sync)
        if (cfg.webhooks && cfg.webhooks.enabled && cfg.webhooks.url) {
          try {
            await sendWebhook(rca, writtenPath, cfg);
          } catch (whErr) {
            process.stderr.write(`⚠ webhook notification failed: ${whErr.message}\n`);
          }
        }

        progress.stop(
          `Done in ${((Date.now() - overallStart) / 1000).toFixed(1)}s — ${writtenPath}`,
        );
      } catch (err) {
        if (err instanceof RcaError) {
          progress.fail(err.message);
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
      const { existsSync: fsExistsSync, readFileSync: fsReadFileSync } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');
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

      // Non-fatal sentinel check: read .last-rca-error from output_dir
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });
        const sentinelPath = pathJoin(cfg.output_dir, '.last-rca-error');
        if (fsExistsSync(sentinelPath)) {
          try {
            const s = JSON.parse(fsReadFileSync(sentinelPath, 'utf8'));
            process.stdout.write(
              `rca-gen  WARN  Last generation failed at ${s.timestamp} for ${s.ref}: ${s.error}\n`,
            );
          } catch {
            process.stdout.write('rca-gen  WARN  Last generation failed (sentinel unreadable)\n');
          }
        }
      } catch {
        // Config load failure is non-fatal for the sentinel check
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
    .command('audit')
    .description('Audit RCA corpus for quality — flag auto-filled or missing fields')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const cwd = program.opts().cwd || process.cwd();
      const cfg = loadConfig({ cwd, configPath: program.opts().config });
      const result = auditCorpus({ outputDir: cfg.output_dir });
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        if (result.degraded.length > 0) {
          process.exit(1);
        }
      } else {
        if (result.degraded.length === 0) {
          process.stdout.write(
            `All ${result.clean_count} RCA(s) are clean. No auto-filled fields found.\n`,
          );
        } else {
          for (const entry of result.degraded) {
            const fields = entry.auto_filled.join(', ');
            process.stdout.write(`DEGRADED  ${entry.path}  [auto_filled: ${fields}]\n`);
          }
          process.stdout.write(
            `\n${result.degraded.length} degraded, ${result.clean_count} clean.\n`,
          );
          process.exit(1);
        }
      }
    });

  program
    .command('rebuild')
    .description('Re-validate existing RCAs against current schema; --fix to patch missing fields')
    .option('--fix', 'Auto-fix missing required fields with defaults')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });
        const { readdirSync: readdir } = await import('node:fs');
        const { validateRca } = await import('./schema.mjs');
        const matter = await import('gray-matter');

        const mdFiles = [];
        try {
          for (const entry of readdir(cfg.output_dir, { recursive: true })) {
            if (typeof entry === 'string' && entry.endsWith('.md')) {
              mdFiles.push(join(cfg.output_dir, entry));
            }
          }
        } catch {
          process.stderr.write('No RCA directory found.\n');
          return;
        }

        const results = { valid: [], invalid: [], fixed: [] };
        for (const filePath of mdFiles) {
          const raw = readFileSync(filePath, 'utf8');
          const { data } = matter.default(raw);
          const check = validateRca(data);
          if (check.valid) {
            results.valid.push(filePath);
          } else if (opts.fix) {
            if (!data.files) data.files = ['unknown'];
            if (!data.references) data.references = [];
            if (!data.confidence) data.confidence = 'medium';
            if (!data.tags || data.tags.length < 2) data.tags = ['rca', 'bugfix'];
            if (!data.impact) data.impact = data.symptom || 'Unknown impact.';
            const recheck = validateRca(data);
            if (recheck.valid) {
              const updated = matter.default.stringify(
                raw.replace(/^---[\s\S]*?---/, '').trim(),
                data,
              );
              const { atomicWrite } = await import('./util/fs.mjs');
              await atomicWrite(filePath, updated);
              results.fixed.push(filePath);
            } else {
              results.invalid.push({ path: filePath, errors: recheck.errors });
            }
          } else {
            results.invalid.push({ path: filePath, errors: check.errors });
          }
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        } else {
          process.stderr.write(
            `Valid: ${results.valid.length}, Invalid: ${results.invalid.length}, Fixed: ${results.fixed.length}\n`,
          );
          for (const item of results.invalid) {
            process.stderr.write(`  ✖ ${basename(item.path)}: ${item.errors[0]}\n`);
          }
          for (const f of results.fixed) {
            process.stderr.write(`  ✓ fixed ${basename(f)}\n`);
          }
        }
        if (results.invalid.length > 0) process.exit(1);
      } catch (err) {
        if (err instanceof RcaError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  obsidianCmd
    .command('sync-all')
    .description('Sync all RCA files to the Obsidian vault')
    .action(async () => {
      try {
        const cwd = program.opts().cwd || process.cwd();
        const cfg = loadConfig({ cwd, configPath: program.opts().config });
        const { readdirSync: readdir } = await import('node:fs');

        if (!cfg.obsidian || (!cfg.obsidian.vault_path && !cfg.obsidian.api_key)) {
          throw new RcaError('NO_VAULT', {});
        }

        const mdFiles = [];
        try {
          for (const entry of readdir(cfg.output_dir, { recursive: true })) {
            if (typeof entry === 'string' && entry.endsWith('.md')) {
              mdFiles.push(join(cfg.output_dir, entry));
            }
          }
        } catch {
          process.stderr.write('No RCA files found.\n');
          return;
        }

        let synced = 0;
        const targetFolder = cfg.obsidian.target_folder || 'RCA Inbox';
        const vaultPath = cfg.obsidian.vault_path;
        let client = null;
        if (cfg.obsidian.api_key) {
          try {
            client = createObsidianClient({
              apiKey: cfg.obsidian.api_key,
              host: cfg.obsidian.api_host || '127.0.0.1',
              port: cfg.obsidian.api_port || 27124,
              protocol: cfg.obsidian.api_protocol || 'https',
            });
          } catch {
            client = null;
          }
        }

        for (const filePath of mdFiles) {
          const rcaBasename = basename(filePath);
          const content = readFileSync(filePath, 'utf8');
          let ok = false;

          if (client) {
            try {
              await client.createNote(`${targetFolder}/${rcaBasename}`, content);
              ok = true;
            } catch {
              /* fall through */
            }
          }
          if (!ok && vaultPath) {
            try {
              await syncToVault({ rcaPath: filePath, vaultPath, targetFolder });
              ok = true;
            } catch {
              /* skip */
            }
          }
          if (ok) synced++;
        }

        process.stderr.write(`✓ synced ${synced}/${mdFiles.length} RCAs to vault\n`);
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
