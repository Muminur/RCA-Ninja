import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTriggeringCommit, TRIGGER_DEFAULTS, triggerSettings } from '../../src/triggers.mjs';

describe('isTriggeringCommit', () => {
  it('triggers on fix: by default', () => {
    assert.strictEqual(isTriggeringCommit({ message: 'fix: correct the null check' }), true);
  });

  it('triggers on a scoped, breaking fix', () => {
    assert.strictEqual(isTriggeringCommit({ message: 'fix(auth)!: drop the legacy path' }), true);
  });

  it('does not trigger on chore:', () => {
    assert.strictEqual(isTriggeringCommit({ message: 'chore: bump dependency' }), false);
  });

  it('does not trigger on feat: by default', () => {
    assert.strictEqual(isTriggeringCommit({ message: 'feat: add login flow' }), false);
  });

  it('triggers on feat: when commit_types includes feat', () => {
    const config = { triggers: { commit_types: ['fix', 'feat'] } };
    assert.strictEqual(isTriggeringCommit({ message: 'feat: add login flow', config }), true);
  });

  it('triggers on a feat: whose body closes a reported issue', () => {
    const message = 'feat: add retry to the uploader\n\nCloses #142\n';
    assert.strictEqual(isTriggeringCommit({ message }), true);
  });

  it('recognises fixes/fixed/resolves/resolved/closed as closing keywords', () => {
    for (const kw of ['Fixes', 'Fixed', 'fix', 'Resolves', 'resolved', 'Closed', 'closes']) {
      assert.strictEqual(
        isTriggeringCommit({ message: `feat: thing\n\n${kw} #7\n` }),
        true,
        `${kw} #7 should trigger`,
      );
    }
  });

  it('does not read closing keywords out of the subject line alone being a type', () => {
    assert.strictEqual(isTriggeringCommit({ message: 'docs: describe the fix workflow' }), false);
  });

  it('ignores closing keywords when closes_issue is false', () => {
    const config = { triggers: { closes_issue: false } };
    const message = 'feat: add retry to the uploader\n\nCloses #142\n';
    assert.strictEqual(isTriggeringCommit({ message, config }), false);
  });

  it('reads the whole message, not just the subject', () => {
    // GitHub's squash-merge default puts the PR description in the body, which
    // is where a closing keyword lands.
    const message = ['feat: uploader retries', '', 'Some prose.', '', 'Resolves #9'].join('\n');
    assert.strictEqual(isTriggeringCommit({ message }), true);
  });

  it('skips leading comment and blank lines when finding the subject', () => {
    assert.strictEqual(isTriggeringCommit({ message: '\n# a comment\nfix: real subject' }), true);
  });

  it('returns false for an empty or missing message', () => {
    assert.strictEqual(isTriggeringCommit({ message: '' }), false);
    assert.strictEqual(isTriggeringCommit({}), false);
  });

  it('treats a type list with a regex metacharacter literally', () => {
    const config = { triggers: { commit_types: ['fi.'] } };
    assert.strictEqual(isTriggeringCommit({ message: 'fix: x', config }), false);
    assert.strictEqual(isTriggeringCommit({ message: 'fi.: x', config }), true);
  });
});

describe('triggerSettings', () => {
  it('falls back to the defaults when config has no triggers block', () => {
    assert.deepStrictEqual(triggerSettings(null), TRIGGER_DEFAULTS);
    assert.deepStrictEqual(triggerSettings({}), TRIGGER_DEFAULTS);
  });

  it('merges a partial triggers block over the defaults', () => {
    const settings = triggerSettings({ triggers: { commit_types: ['fix', 'perf'] } });
    assert.deepStrictEqual(settings.commit_types, ['fix', 'perf']);
    assert.strictEqual(settings.closes_issue, true);
  });

  it('ignores an empty commit_types array rather than matching nothing', () => {
    assert.deepStrictEqual(triggerSettings({ triggers: { commit_types: [] } }).commit_types, [
      'fix',
    ]);
  });
});
