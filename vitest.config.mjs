import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    // Other agents' git worktrees live under worktrees/; never scan them.
    exclude: ['worktrees/**', 'node_modules/**'],
    environment: 'node',
  },
});
