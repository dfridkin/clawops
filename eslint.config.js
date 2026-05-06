import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Disable TypeScript projectService (language server) — it resolves all
  // transitive .d.ts files including @pulumi/azure-native's 29k files, making
  // ESLint hang. We only use syntax-level rules, not type-aware rules.
  {
    languageOptions: {
      parserOptions: {
        project: false,
        EXPERIMENTAL_useProjectService: false,
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // I7: never call console.log/warn/error directly in command handlers.
      // Use src/output/human.ts helpers instead.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name=/^(log|warn|error|info|debug)$/]",
          message:
            'Use src/output/human.ts helpers (success, failure, warn, info) instead of console.*. ' +
            'See I7 in spec/invariants.yaml.',
        },
      ],
    },
    files: ['src/cli/commands/**/*.ts', 'src/cli/index.ts'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
)
