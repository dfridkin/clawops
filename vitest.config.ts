import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Fails fast when the mutation checker has a file mutated; see the file for why.
    globalSetup: ['tests/setup/no-mutation-in-flight.ts'],
    exclude: ['tests/integration/**', 'tests/e2e/local/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
    },
  },
})
