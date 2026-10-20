import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2023',
  },
});

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
    projects: [
      {
        plugins: [swcPlugin],
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [swcPlugin],
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e-spec.ts'],
          environment: 'node',
          globalSetup: ['test/e2e/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
