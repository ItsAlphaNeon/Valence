// Runs the fixture generator with the desktop's own aliases, from the repo root:
//   npx vitest run --config android/tags/fixtures-src/vitest.config.mts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

export default defineConfig({
  root: repo,
  resolve: {
    alias: {
      '@shared': resolve(repo, 'src/shared'),
      '@main': resolve(repo, 'src/main'),
    },
  },
  test: {
    include: ['android/tags/fixtures-src/*.test.ts'],
    testTimeout: 120_000,
    pool: 'forks',
  },
})
