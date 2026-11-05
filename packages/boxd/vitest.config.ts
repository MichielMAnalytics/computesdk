import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // With BOXD_API_KEY set the suites run against real computers: a computer's first port
    // URL waits for its certificate (about 20 s), longer than vitest's 5 s default.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*'
      ]
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
