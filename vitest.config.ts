import { defineConfig } from 'vitest/config';

// Two projects: `unit` (pure logic) and `contract` (code checked against the files in contracts/).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/**/*.test.ts'],
          exclude: ['**/*.contract.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'contract',
          include: ['{apps,packages}/*/test/**/*.contract.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
});
