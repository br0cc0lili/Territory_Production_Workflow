import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // the SDK's AIO logger is chatty at info level; keep test output readable
    onConsoleLog: (log) => !/\[ffcpe-(custom-node|node-worker)/.test(log),
  },
})
