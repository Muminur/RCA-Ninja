import {
  writeSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RcaError } from '../errors.mjs';

export async function atomicWrite(dest, content) {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });

  const tmpPath = dest + '.tmp-' + randomUUID();
  try {
    const fd = openSync(tmpPath, 'w');
    try {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      const written = writeSync(fd, buf);
      if (written !== buf.length) {
        throw new RcaError('DISK_ERROR', { op: 'write', errno: 'SHORT_WRITE' });
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      renameSync(tmpPath, dest);
    } catch (err) {
      if (err.code === 'EXDEV') {
        copyFileSync(tmpPath, dest);
        unlinkSync(tmpPath);
      } else {
        throw err;
      }
    }

    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // directory fsync may fail on some platforms (Windows)
    }
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // cleanup best-effort
    }
    throw err;
  }
}

const LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export function acquireLock(lockPath) {
  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_MAX_AGE_MS) {
        process.stderr.write(`Warning: removing stale lock at ${lockPath}\n`);
        unlinkSync(lockPath);
      }
    } catch {
      // race
    }
  }

  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new RcaError('WRITE_CONFLICT', { path: lockPath });
    }
    throw err;
  }
}

export function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // already removed
  }
}
