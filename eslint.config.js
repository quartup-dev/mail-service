import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Librerías de transporte e infraestructura que domain/ y application/ no pueden importar
const INFRASTRUCTURE_PACKAGES = [
  'fastify',
  '@fastify/*',
  'fastify-type-provider-zod',
  'bullmq',
  'ioredis',
  'drizzle-orm',
  'drizzle-orm/*',
  'pg',
  'postgres',
  'nodemailer',
  'nodemailer/*',
  'mailgun.js',
  'form-data',
  '@aws-sdk/*',
  'pino',
];

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'docker/dev-certs/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Fastify espera plugins y handlers async aunque no usen await
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/infrastructure/**', '**/interfaces/**'],
              message: 'domain/ no puede depender de otras capas.',
            },
            {
              group: INFRASTRUCTURE_PACKAGES,
              message: 'domain/ no puede importar librerías de infraestructura.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/interfaces/**'],
              message: 'application/ solo depende de domain/ y de sus puertos.',
            },
            {
              group: INFRASTRUCTURE_PACKAGES,
              message: 'application/ no puede importar librerías de infraestructura.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
