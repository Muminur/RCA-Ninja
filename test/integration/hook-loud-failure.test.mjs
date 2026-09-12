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
      /log "INFO" "skipped: .*not configured for this repo/.test(block),
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

  it('checks the commit message before spawning the RCA CLI', () => {
    // The trigger rule itself lives in the CLI (generate --if-triggered). The
    // hook keeps only a cheap shell pre-filter, and it must still come first.
    const preFilter = src.indexOf('is not an RCA candidate');
    // Matches both the bare name and the ${RCA_BIN} indirection.
    const firstRca = src.search(/(\$\{RCA_BIN\}"?|claude-rca|codex-rca)\s+config/);
    assert.ok(
      preFilter !== -1 && firstRca !== -1 && preFilter < firstRca,
      'ordinary commits must not pay for a node process or spam the log',
    );
  });

  it('the shell pre-filter is a superset of the trigger config, never a copy of it', () => {
    // A narrower pre-filter would silently veto whatever triggers.commit_types
    // asks for, so it must accept any "<type>:" subject rather than just fix:.
    assert.match(src, /\[A-Za-z\]\[A-Za-z0-9_\.-\]\*/, 'pre-filter must accept any commit type');
    assert.match(src, /close\[sd\]\?/, 'pre-filter must also let issue-closing bodies through');
    assert.ok(src.includes('--if-triggered'), 'the real decision must be delegated to the CLI');
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
