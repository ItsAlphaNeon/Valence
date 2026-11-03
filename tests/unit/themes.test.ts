// User themes: file validation, folder loading and the stylesheet the renderer applies.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXAMPLE_THEME, loadUserThemes, parseTheme, themesDir, writeExampleTheme } from '@main/library/themes'

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown }
  g.window ??= { valence: { platform: 'win32', invoke: async () => null, on: () => () => {}, send: () => {} } }
})

const { themeCss, capTier, BUILTIN_THEMES } = await import('@renderer/theme/themes')

describe('parseTheme', () => {
  it('normalizes token names and keeps the optional fields', () => {
    const t = parseTheme({ name: ' Ember ', scheme: 'dark', maxTier: 'glass', artTint: false, accent: '#FF7A45', tokens: { 'r-lg': '16px', '--fg': '#fff' }, light: { 'bg-solid': 2 } }, 'ember.json')
    expect(t).toMatchObject({ id: 'user:ember', name: 'Ember', scheme: 'dark', maxTier: 'glass', artTint: false, accent: '#ff7a45', file: 'ember.json' })
    expect(t.tokens).toEqual({ '--r-lg': '16px', '--fg': '#fff' })
    expect(t.light).toEqual({ '--bg-solid': '2' })
  })

  it('treats "auto" as following the system and falls back to the file name', () => {
    const t = parseTheme({ scheme: 'auto' }, 'Plain.json')
    expect(t.scheme).toBeUndefined()
    expect(t.name).toBe('Plain')
  })

  it('joins css given as an array of lines', () => {
    expect(parseTheme({ css: ['a { b: c }', 'd { e: f }'] }, 'x.json').css).toBe('a { b: c }\nd { e: f }')
  })

  it.each([
    [[], 'JSON object'],
    [{ scheme: 'sepia' }, '"scheme"'],
    [{ maxTier: 'ultra' }, '"maxTier"'],
    [{ accent: 'orange' }, '"accent"'],
    [{ tokens: ['x'] }, '"tokens"'],
    [{ tokens: { 'bad name': '1px' } }, 'token name'],
    [{ tokens: { fg: 'red; } body { display: none' } }, 'contains'],
    [{ dark: { fg: '' } }, 'must be a string'],
    [{ css: '</style><script>' }, '<style>'],
  ])('rejects %j', (json, msg) => {
    expect(() => parseTheme(json, 'bad.json')).toThrow(msg)
  })
})

describe('loadUserThemes', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'valence-themes-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('creates the folder and returns nothing when empty', () => {
    const r = loadUserThemes(root)
    expect(r.dir).toBe(themesDir(root))
    expect(r.themes).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('loads valid files, reports broken ones and skips non-theme files', () => {
    const dir = themesDir(root)
    loadUserThemes(root)
    writeFileSync(join(dir, 'b.json'), '﻿' + JSON.stringify({ name: 'B' }))
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'A', accent: '#123456' }))
    writeFileSync(join(dir, 'broken.json'), '{ "name": ')
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ maxTier: 'x' }))
    writeFileSync(join(dir, 'a.sync-conflict-20260101-000000-ABC.json'), '{}')
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    const r = loadUserThemes(root)
    expect(r.themes.map((t) => t.name)).toEqual(['A', 'B'])
    expect(r.errors.map((e) => e.file).sort()).toEqual(['bad.json', 'broken.json'])
    expect(r.errors.find((e) => e.file === 'broken.json')?.error).toMatch(/not valid JSON/)
  })

  it('writes a valid example and never overwrites it', () => {
    const p = writeExampleTheme(root)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(EXAMPLE_THEME)
    writeFileSync(p, JSON.stringify({ name: 'Mine' }))
    writeExampleTheme(root)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ name: 'Mine' })
    const r = loadUserThemes(root)
    expect(r.errors).toEqual([])
    expect(r.themes[0].name).toBe('Mine')
  })
})

describe('themeCss', () => {
  it('is empty for the built-in themes', () => {
    for (const t of BUILTIN_THEMES) expect(themeCss(t)).toBe('')
  })

  it('scopes light and dark tokens and keeps flat/minimal surfaces opaque', () => {
    const t = parseTheme(EXAMPLE_THEME, 'example.json')
    const css = themeCss(t)
    expect(css).toContain(':root:root { --r-lg: 16px; --glass-blur: 34px; }')
    expect(css).toContain("@media (prefers-color-scheme: dark) { :root:root:not([data-scheme='light']) { --bg-solid: #141010;")
    expect(css).toContain(":root:root[data-scheme='light'] { --bg-solid: #f6f1ec;")
    expect(css).toMatch(/:root:root:root\[data-tier='minimal'\] \{ --glass-bg: var\(--surface\)/)
    expect(css.trim().endsWith('.sidebar { letter-spacing: 0.01em; }')).toBe(true)
  })

  it('caps the tier for user themes too', () => {
    expect(capTier('full', parseTheme({ maxTier: 'flat' }, 'x.json'))).toBe('flat')
  })
})
