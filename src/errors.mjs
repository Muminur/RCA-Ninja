const ERROR_TABLE = {
  ALREADY_INIT: { category: 'input', exit: 10, template: 'Already initialized at {path}.' },
  NO_DIFF: { category: 'input', exit: 20, template: 'No diff to analyze for ref {ref}.' },
  // CLAUDE_FAILURE: kept for exit-code (21) stability; covers any LLM provider.
  CLAUDE_FAILURE: {
    category: 'external',
    exit: 21,
    template: 'LLM provider exited {exitCode} ({stderr_first_line}).',
  },
  SCHEMA_VALIDATION: {
    category: 'external',
    exit: 22,
    template: 'LLM output failed schema validation: {ajv_first_error}.',
  },
  WRITE_CONFLICT: {
    category: 'fs',
    exit: 23,
    template: 'An RCA already exists at {path}. Refusing to overwrite.',
  },
  DISK_ERROR: { category: 'fs', exit: 24, template: 'Filesystem error during {op}: {errno}.' },
  TOKEN_BUDGET_EXCEEDED: {
    category: 'input',
    exit: 25,
    template: 'Token budget exceeded: {reason}.',
  },
  RIPGREP_MISSING: {
    category: 'env',
    exit: 30,
    template: 'ripgrep (rg) is not on PATH. Install: {hint}.',
  },
  SECRET_SCANNER_UNAVAILABLE: {
    category: 'env',
    exit: 31,
    template: 'An approved secret scanner is unavailable; provider execution was refused.',
  },
  SECRET_SCAN_FAILED: {
    category: 'input',
    exit: 32,
    template: 'The secret scanner blocked provider execution.',
  },
  PROVIDER_ISOLATION_UNAVAILABLE: {
    category: 'env',
    exit: 33,
    template: 'No approved isolated provider broker is available; provider execution was refused.',
  },
  NOT_FOUND: { category: 'input', exit: 40, template: 'RCA not found: {id}.' },
  INVALID_CONFIG_KEY: { category: 'input', exit: 50, template: 'Unknown config key: {key}.' },
  INVALID_CONFIG_VALUE: {
    category: 'input',
    exit: 50,
    template: 'Invalid value for {key}: {reason}.',
  },
  NO_VAULT: {
    category: 'env',
    exit: 60,
    template: 'Obsidian is enabled but no vault configured.',
  },
  INVALID_VAULT: {
    category: 'env',
    exit: 61,
    template: 'Path {p} is not an Obsidian vault (no .obsidian/ found).',
  },
  DOCTOR_UNHEALTHY: {
    category: 'env',
    exit: 70,
    template: 'Environment unhealthy: {n} checks failed.',
  },
  INTERNAL: { category: 'bug', exit: 100, template: 'Unexpected: {message}. Please file a bug.' },
};

export class RcaError extends Error {
  constructor(code, context = {}) {
    const entry = ERROR_TABLE[code];
    if (!entry) {
      super(`Unknown error code: ${code}`);
      this.code = 'INTERNAL';
      this.exitCode = 100;
      this.category = 'bug';
      return;
    }
    let message = entry.template;
    for (const [k, v] of Object.entries(context)) {
      message = message.replace(`{${k}}`, String(v));
    }
    super(message);
    this.code = code;
    this.exitCode = entry.exit;
    this.category = entry.category;
    this.context = context;
  }
}

export { ERROR_TABLE };
