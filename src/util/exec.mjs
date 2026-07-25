import { spawn } from 'node:child_process';
import { RcaError } from '../errors.mjs';

export function run(cmd, args = [], { cwd, timeoutMs = 30000, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      signal: ac.signal,
      env: env || process.env,
      // Pipe stdin only when we have input to send. Passing a large prompt via
      // stdin (instead of argv) keeps us under the OS command-line length limit
      // (e.g. Windows' ~32 KB CreateProcess cap) for big diffs.
      stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (input != null) {
      // Guard against EPIPE if the child exits before consuming all input.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    const chunks = { stdout: [], stderr: [] };
    child.stdout.on('data', (d) => chunks.stdout.push(d));
    child.stderr.on('data', (d) => chunks.stderr.push(d));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ABORT_ERR' || ac.signal.aborted) {
        reject(
          Object.assign(
            new RcaError('INTERNAL', { message: `${cmd} timed out after ${timeoutMs}ms` }),
            { killed: true, signal: 'SIGTERM' },
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.stdout).toString('utf8');
      const stderr = Buffer.concat(chunks.stderr).toString('utf8');
      if (code !== 0) {
        const err = new RcaError('INTERNAL', {
          message: `${cmd} exited with code ${code}`,
        });
        err.exitCode = code;
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
