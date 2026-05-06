// Vitest config for Pulumi program tests.
// Uses forks pool to avoid gRPC worker-thread conflicts with @pulumi/aws and @pulumi/azure-native.
// Run with: pnpm test:pulumi

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // run all Pulumi tests in one fork to share setMocks state
      },
    },
    include: ['tests/providers/**/program.test.ts'],
    testTimeout: 30_000,
  },
})
