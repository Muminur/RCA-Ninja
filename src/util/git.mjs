import { run } from './exec.mjs';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function git(args, cwd) {
  const { stdout } = await run('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

export async function revParse(what, cwd) {
  return git(['rev-parse', what], cwd);
}

export async function shortHash(ref, cwd) {
  return git(['rev-parse', '--short=7', ref], cwd);
}

export async function commitMessage(ref, cwd) {
  return git(['log', '-1', '--pretty=%B', ref], cwd);
}

export async function author(ref, cwd) {
  return git(['log', '-1', '--pretty=%an', ref], cwd);
}

export async function timestamp(ref, cwd) {
  return git(['log', '-1', '--pretty=%aI', ref], cwd);
}

export async function branch(cwd) {
  try {
    const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    return b === 'HEAD' ? '(detached)' : b;
  } catch {
    return '(detached)';
  }
}

async function hasParent(ref, cwd) {
  try {
    await revParse(`${ref}~1`, cwd);
    return true;
  } catch {
    return false;
  }
}

export async function diff(ref, cwd) {
  const excludes = ['--', '.', ':(exclude)package-lock.json', ':(exclude)*.lock'];
  if (await hasParent(ref, cwd)) {
    return git(['diff', `${ref}~1..${ref}`, ...excludes], cwd);
  }
  return git(['show', '--format=', ref, ...excludes], cwd);
}

export async function filesChanged(ref, cwd) {
  let raw;
  if (await hasParent(ref, cwd)) {
    raw = await git(['diff', '--name-only', `${ref}~1..${ref}`], cwd);
  } else {
    raw = await git(['show', '--format=', '--name-only', ref], cwd);
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}
