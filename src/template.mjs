import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the effective schema and system-prompt paths for a given working
 * directory.  If `.claude-rca/rca-schema.json` or `.claude-rca/rca-system.md`
 * exist inside `cwd`, they override the bundled defaults.
 *
 * @param {string} cwd  - Project root to check for local overrides.
 * @param {string} defaultSchemaPath  - Absolute path to the bundled schema.
 * @param {string} defaultSystemPromptPath - Absolute path to the bundled prompt.
 * @returns {{ schemaPath: string, systemPromptPath: string }}
 */
export function resolveTemplatePaths(cwd, defaultSchemaPath, defaultSystemPromptPath) {
  const localSchemaPath = join(cwd, '.claude-rca', 'rca-schema.json');
  const localPromptPath = join(cwd, '.claude-rca', 'rca-system.md');

  return {
    schemaPath: existsSync(localSchemaPath) ? localSchemaPath : defaultSchemaPath,
    systemPromptPath: existsSync(localPromptPath) ? localPromptPath : defaultSystemPromptPath,
  };
}
