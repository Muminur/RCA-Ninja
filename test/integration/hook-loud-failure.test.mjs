import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POST_COMMIT = join(__dirname, '..', '..', 'hooks', 'post-commit');

/**
 * A `fix:` commit that produces no RCA must be LOUD. The original hook logged
 * the same INFO line whether auto_generate was deliberately off or the config
 * simply could not be resolved — so a three-day outage looked like normal
 * "skipped" noise in the log.
 */
describe('post-commit hook fails loudly, never silently', () => {
  const src = readFileSync(POST_COMMIT, 'utf8');

  it('distinguishes an unresolvable config from auto_generate being off', () => {
    assert.ok(
      src.includes('config --path'),
      'hook must probe `config --path` to tell "no config" from "disabled"',
    );
    const unresolved = src.indexOf('config --path');
    const autoGate = src.indexOf('--get auto_generate');
    assert.ok(
      unresolved !== -1 && autoGate !== -1 && unresolved < autoGate,
      'the config-resolution check must run before the auto_generate gate',
    );
  });

  it('logs ERROR (not INFO) when no config can be resolved', () => {
    // Grab the block that handles the empty-config-path case.
    const idx = src.indexOf('config --path');
    const block = src.slice(idx, idx + 700);
    assert.ok(
      /log\s+"?ERROR/.test(block),
      'an unresolvable config must be logged at ERROR, not INFO',
    );
  });

  it('warns on stderr so the failure is visible in git commit output', () => {
    assert.ok(
      /warn\(\)/.test(src) && />&2/.test(src),
      'hook must define a warn() helper that writes to stderr',
    );
    const idx = src.indexOf('config --path');
    const block = src.slice(idx, idx + 700);
    assert.ok(warnCalled(block), 'the no-config path must call warn() so the user sees it');
  });

  it('stays quiet in repos that never used claude-rca (global-install safe)', () => {
    const idx = src.indexOf('config --path');
    const block = src.slice(idx, idx + 900);
    assert.ok(
      /-d "\$\{MAIN_ROOT\}\/rca"/.test(block),
      'the no-config path must check for an existing rca/ corpus before warning',
    );
    assert.ok(
      /log "INFO" "skipped: claude-rca not configured/.test(block),
      'an unconfigured repo must log INFO, not ERROR — otherwise the warning becomes noise',
    );
  });

  it('never uses the literal string "undefined" as a log filename', () => {
    assert.ok(
      src.includes('undefined'),
      'hook must explicitly guard against the string "undefined" from `config --get`',
    );
    assert.ok(
      /GEN_LOG=.*\n.*undefined/.test(src) || /case "\$\{?GEN_LOG/.test(src),
      'the guard must apply to GEN_LOG immediately after it is read',
    );
  });

  it('checks the commit message before spawning claude-rca', () => {
    const msgCase = src.indexOf('fix:*');
    const firstRca = src.indexOf('claude-rca config');
    assert.ok(
      msgCase !== -1 && firstRca !== -1 && msgCase < firstRca,
      'non-fix commits must not pay for a node process or spam the log',
    );
  });

  it('still defines LOG_FILE before checking PATH for claude-rca', () => {
    assert.ok(
      src.indexOf('LOG_FILE=') < src.indexOf('command -v'),
      'LOG_FILE must exist before the PATH check so that failure is recorded',
    );
  });
});

function warnCalled(block) {
  return /\bwarn\s+"/.test(block);
}
