import { spawn } from 'node:child_process';
import { RcaError } from '../errors.mjs';

export function run(cmd, args = [], { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      signal: ac.signal,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
