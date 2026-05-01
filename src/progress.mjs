import { stderr } from 'node:process';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createProgress() {
  let interval = null;
  let frame = 0;
  let currentPhase = '';
  let startTime = Date.now();

  return {
    start(phase) {
      currentPhase = phase;
      startTime = Date.now();
      frame = 0;
      if (stderr.isTTY) {
        interval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          stderr.write(`\r${SPINNER[frame++ % SPINNER.length]} ${currentPhase} [${elapsed}s]`);
        }, 100);
      } else {
        stderr.write(`${phase}...\n`);
      }
    },
    update(phase) {
      currentPhase = phase;
      startTime = Date.now();
      if (!stderr.isTTY) {
        stderr.write(`${phase}...\n`);
      }
    },
    stop(message) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (stderr.isTTY) {
        stderr.write(`\r✓ ${message}\n`);
      } else {
        stderr.write(`✓ ${message}\n`);
      }
    },
    fail(message) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (stderr.isTTY) {
        stderr.write(`\r✖ ${message}\n`);
      } else {
        stderr.write(`✖ ${message}\n`);
      }
    },
  };
}
