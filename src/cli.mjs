import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

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
    .version(pkg.version);

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
      process.stderr.write('Not yet implemented (milestone 2)\n');
      process.exit(1);
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
    .action(() => {
      process.stderr.write('Not yet implemented (milestone 2)\n');
      process.exit(1);
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
