import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // electron-vite's `x.png?asset` (the file's absolute path at runtime): here, the source file's path.
      name: 'valence-asset',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('?asset')) return `export default ${JSON.stringify(id.slice(0, -'?asset'.length))}`
      },
    },
  ],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
})
