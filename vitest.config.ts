import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Solo se mide con --coverage (bun run test:coverage)
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          globalSetup: ['test/integration/global-setup.ts'],
          // Comparten base de datos y Redis: un fichero cada vez
          fileParallelism: false,
        },
      },
    ],
  },
});
