import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const FRAMEWORKS = {
  group: [
    '@nestjs/*',
    'mongodb',
    'fastify',
    'agenda',
    '@agendajs/*',
    '@modelcontextprotocol/*',
    'resend',
    'pdfmake',
  ],
  message:
    'Domínio e aplicação são agnósticos de framework/infra (arquitetura hexagonal): use uma porta.',
};

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            FRAMEWORKS,
            {
              group: ['**/application/**', '**/adapters/**', '**/config/**'],
              message: 'O domínio não depende de camadas externas.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            FRAMEWORKS,
            {
              group: ['**/adapters/**', '**/config/**'],
              message: 'A aplicação depende só de portas.',
            },
          ],
        },
      ],
    },
  }
);
