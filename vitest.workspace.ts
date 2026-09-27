import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts'],
      exclude: ['**/*.int.test.ts', '**/*.fail.test.ts', '**/node_modules/**', '**/dist/**'],
      passWithNoTests: true,
    },
  },
  {
    test: {
      name: 'integration',
      include: ['packages/*/src/**/*.int.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 600_000,
      passWithNoTests: true,
    },
  },
  {
    test: {
      name: 'failure',
      include: ['packages/*/src/**/*.fail.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 900_000,
      passWithNoTests: true,
    },
  },
]);
