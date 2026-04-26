import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { initProject, loadConfig, getConfigValue, setConfigValue } from './config.mjs';
import { RcaError } from './errors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require(join(__dirname, '..', 'package.json'));

function createProgram() {
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
    .action(() => {
      process.stderr.write('Not yet implemented (milestone 6)\n');
      process.exit(1);
    });

  program
    .command('search <query>')
    .description('Search RCA corpus via ripgrep')
    .option('--since <date>', 'Filter by date')
    .option('--tag <tag>', 'Filter by tag')
    .option('--json', 'Output as JSON')
    .action(() => {
      process.stderr.write('Not yet implemented (milestone 7)\n');
      process.exit(1);
    });

  program
    .command('recent [count]')
    .description('List most recent RCAs')
    .option('--json', 'Output as JSON')
    .action(() => {
      process.stderr.write('Not yet implemented (milestone 7)\n');
      process.exit(1);
    });

  program
    .command('show <id>')
    .description('Display an RCA by ID or path')
    .action(() => {
      process.stderr.write('Not yet implemented (milestone 7)\n');
      process.exit(1);
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
    .action(() => {
      process.stderr.write('Not yet implemented (milestone 10)\n');
      process.exit(1);
    });

  return program;
}

export function main(argv) {
  const program = createProgram();
  program.parse(argv);
}
