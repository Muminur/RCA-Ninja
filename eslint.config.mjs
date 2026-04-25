import js from '@eslint/js';

const noExecRule = {
  meta: {
    type: 'problem',
    messages: { noExec: 'Use spawn() from src/util/exec.mjs instead of child_process.exec()' },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.name === 'exec' &&
          node.callee.object.name === 'child_process'
        ) {
          context.report({ node, messageId: 'noExec' });
        }
        if (node.callee.name === 'exec') {
          const scope = context.sourceCode.getScope(node);
          const binding = scope.references.find((r) => r.identifier === node.callee);
          if (binding && binding.resolved) {
            const def = binding.resolved.defs[0];
            if (
              def &&
              def.parent &&
              def.parent.source &&
              def.parent.source.value === 'node:child_process'
            ) {
              context.report({ node, messageId: 'noExec' });
            }
          }
        }
      },
    };
  },
};

const noBareErrorRule = {
  meta: {
    type: 'problem',
    messages: { noBareError: 'Throw RcaError from src/errors.mjs instead of bare Error' },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        if (!node.argument) return;
        const arg = node.argument;
        const isNewError = arg.type === 'NewExpression' && arg.callee.name === 'Error';
        const isCallError = arg.type === 'CallExpression' && arg.callee.name === 'Error';
        if (isNewError || isCallError) {
          context.report({ node, messageId: 'noBareError' });
        }
      },
    };
  },
};

const customPlugin = {
  rules: {
    'no-exec': noExecRule,
    'no-bare-error': noBareErrorRule,
  },
};

export default [
  js.configs.recommended,
  {
    plugins: { 'claude-rca': customPlugin },
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['bin/claude-rca'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
    },
  },
  {
    files: ['src/**/*.mjs'],
    rules: {
      'claude-rca/no-exec': 'error',
      'claude-rca/no-bare-error': 'error',
    },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'rca/'],
  },
];
