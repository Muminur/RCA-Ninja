import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from '../../src/progress.mjs';

describe('createProgress', () => {
  it('returns an object with start, update, stop, and fail methods', () => {
    const p = createProgress();
    assert.equal(typeof p.start, 'function');
    assert.equal(typeof p.update, 'function');
    assert.equal(typeof p.stop, 'function');
    assert.equal(typeof p.fail, 'function');
  });

  describe('non-TTY mode (isTTY falsy)', () => {
    let originalIsTTY;
    let originalWrite;
    const written = [];

    before(() => {
      originalIsTTY = process.stderr.isTTY;
      originalWrite = process.stderr.write.bind(process.stderr);
      // Force non-TTY
      Object.defineProperty(process.stderr, 'isTTY', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      process.stderr.write = (msg) => {
        written.push(msg);
        return true;
      };
    });

    after(() => {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
        writable: true,
      });
      process.stderr.write = originalWrite;
    });

    it('stop writes a success message to stderr', () => {
      written.length = 0;
      const p = createProgress();
      p.start('Phase one');
      p.stop('Done successfully');
      assert.ok(written.some((m) => m.includes('Done successfully')));
    });

    it('fail writes a failure message to stderr', () => {
      written.length = 0;
      const p = createProgress();
      p.start('Phase one');
      p.fail('Something went wrong');
      assert.ok(written.some((m) => m.includes('Something went wrong')));
    });
  });

  describe('TTY mode (isTTY=true) — no dangling interval after stop', (_t) => {
    let originalIsTTY;
    let originalWrite;

    before(() => {
      originalIsTTY = process.stderr.isTTY;
      // Force TTY
      Object.defineProperty(process.stderr, 'isTTY', {
        value: true,
        configurable: true,
        writable: true,
      });
      originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
    });

    after(() => {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
        writable: true,
      });
      process.stderr.write = originalWrite;
    });

    it('stop clears the spinner interval (no leak)', (t, done) => {
      const p = createProgress();
      p.start('Spinning');
      // Give it a tick so the interval fires at least once
      setTimeout(() => {
        p.stop('All done');
        // If the interval leaked, the test runner would complain about active handles.
        // Assert stop returned without throwing, and the subsequent state is clean.
        assert.doesNotThrow(() => p.stop('calling stop again is safe'));
        done();
      }, 150);
    });

    it('fail clears the spinner interval (no leak)', (t, done) => {
      const p = createProgress();
      p.start('Spinning');
      setTimeout(() => {
        p.fail('Failed');
        assert.doesNotThrow(() => p.fail('calling fail again is safe'));
        done();
      }, 150);
    });
  });

  describe('update phase', () => {
    let originalIsTTY;
    let originalWrite;
    const written = [];

    before(() => {
      originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, 'isTTY', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (msg) => {
        written.push(msg);
        return true;
      };
    });

    after(() => {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
        writable: true,
      });
      process.stderr.write = originalWrite;
    });

    it('update emits a new phase message in non-TTY mode', () => {
      written.length = 0;
      const p = createProgress();
      p.start('Phase one');
      p.update('Phase two');
      p.stop('Done');
      assert.ok(written.some((m) => m.includes('Phase two')));
    });
  });
});
