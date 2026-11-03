import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('.sandbox')

/** Creates a fresh, unique sandbox directory under .sandbox/ (gitignored). */
export function sandbox(name: string): { dir: string; cleanup: () => void } {
  mkdirSync(ROOT, { recursive: true })
  const dir = mkdtempSync(join(ROOT, `${name}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
