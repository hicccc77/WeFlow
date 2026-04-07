import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/services/intelligence/**/*.test.ts'],
    coverage: {
      include: ['electron/services/intelligence/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts']
    }
  }
})
