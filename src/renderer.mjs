import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RcaError } from './errors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require(join(__dirname, '..', 'package.json'));

const SECTION_MAX_BYTES = 4096;
const SECTION_ORDER = ['Symptom', 'Root Cause', 'Fix', 'Impact', 'References'];
const SECTION_KEYS = ['symptom', 'root_cause', 'fix', 'impact', 'references'];

/** Map file extensions to fenced-code-block language tags. */
const EXT_TO_LANG = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.md': 'markdown',
};

function inferLanguage(file) {
  const ext = extname(file).toLowerCase();
  return EXT_TO_LANG[ext] || '';
}

function escapeBody(text) {
  return String(text).replace(/^---$/gm, '\\---');
}

function trimLines(text) {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n');
}

function renderCodeChanges(codeChanges) {
  if (!codeChanges || codeChanges.length === 0) return null;

  const parts = ['## Code Changes'];
  for (const entry of codeChanges) {
    const lang = entry.language !== undefined ? entry.language : inferLanguage(entry.file);
    parts.push(`\n### \`${entry.file}\``);
    if (entry.description) {
      parts.push(`\n${entry.description}`);
    }
    parts.push(`\n**Before**\n\n\`\`\`${lang}\n${entry.before}\n\`\`\``);
    parts.push(`\n**After**\n\n\`\`\`${lang}\n${entry.after}\n\`\`\``);
  }
  return parts.join('\n');
}

export function renderRca(rca, context) {
  for (const key of SECTION_KEYS.slice(0, 4)) {
    if (rca[key] && Buffer.byteLength(rca[key]) > SECTION_MAX_BYTES) {
      throw new RcaError('SCHEMA_VALIDATION', {
        ajv_first_error: `${key} exceeds ${SECTION_MAX_BYTES} byte limit`,
      });
    }
  }

  const fm = {};
  fm.title = rca.title;
  fm.date = context.timestamp_utc;
  fm.ref = context.short_hash;
  fm.branch = context.branch;
  if (context.bug_introduced_by) {
    const b = context.bug_introduced_by;
    fm.bug_introduced_by = `${b.commit} by ${b.author} on ${b.date.slice(0, 10)}`;
  }
  fm.confidence = rca.confidence;
  // Optional: description (only when non-empty)
  if (rca.description && rca.description.length > 0) {
    fm.description = rca.description;
  }
  fm.files = rca.files;
  fm.generated_by = `claude-rca/${pkg.version}`;
  fm.schema = 'claude-rca.rca.v1';
  fm.tags = rca.tags;
  // Optional: components (only when non-empty)
  if (rca.components && rca.components.length > 0) {
    fm.components = rca.components;
  }

  const yamlLines = [];
  yamlLines.push(`title: ${JSON.stringify(fm.title)}`);
  yamlLines.push(`date: ${fm.date}`);

  const rest = Object.entries(fm)
    .filter(([k]) => k !== 'title' && k !== 'date')
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [key, val] of rest) {
    if (Array.isArray(val)) {
      if (key === 'tags') {
        yamlLines.push(`${key}: [${val.join(', ')}]`);
      } else {
        yamlLines.push(`${key}:`);
        for (const item of val) {
          yamlLines.push(`  - ${item}`);
        }
      }
    } else if (key === 'description') {
      // JSON.stringify to handle colons and special characters safely
      yamlLines.push(`${key}: ${JSON.stringify(val)}`);
    } else {
      yamlLines.push(`${key}: ${val}`);
    }
  }

  const sections = [];
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const heading = SECTION_ORDER[i];
    const key = SECTION_KEYS[i];
    let body;
    if (key === 'references') {
      const refs = rca.references || [];
      body = refs.length > 0 ? refs.map((r) => `- ${r}`).join('\n') : 'None.';
    } else {
      body = escapeBody(rca[key] || '');
    }
    sections.push(`## ${heading}\n\n${body}`);

    // Insert Code Changes after Fix (index 2), before Impact (index 3)
    if (key === 'fix') {
      const codeSection = renderCodeChanges(rca.code_changes);
      if (codeSection) {
        sections.push(codeSection);
      }
    }
  }

  let md = `---\n${yamlLines.join('\n')}\n---\n\n${sections.join('\n\n')}\n`;
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  md = trimLines(md);

  return md;
}
