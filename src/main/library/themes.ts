// User themes: JSON files in ~/Music/.valence/themes/ (synced, so every device gets them). Each file
// is validated here; the renderer only ever sees well-formed token maps.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { valenceDir } from '@main/sync/device-log'
import type { ThemeFile, ThemeTier, UserThemes } from '@shared/ipc/settings'

const TIERS: ThemeTier[] = ['full', 'glass', 'flat', 'minimal']
const TOKEN_KEY = /^(--)?[a-zA-Z][\w-]{0,63}$/
const MAX_FILE = 256 * 1024
const MAX_CSS = 64 * 1024

export function themesDir(libraryRoot: string): string {
  return join(valenceDir(libraryRoot), 'themes')
}

function tokenMap(v: unknown, field: string): Record<string, string> | undefined {
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`"${field}" must be an object of CSS values`)
  const out: Record<string, string> = {}
  for (const [k, raw] of Object.entries(v)) {
    if (!TOKEN_KEY.test(k)) throw new Error(`"${field}.${k}" isn't a valid token name`)
    const val = typeof raw === 'number' ? String(raw) : raw
    if (typeof val !== 'string' || !val.trim()) throw new Error(`"${field}.${k}" must be a string`)
    // Values end up inside a generated stylesheet; keep each one to a single declaration.
    if (/[;{}<]/.test(val) || val.length > 500) throw new Error(`"${field}.${k}" contains ; { } or <`)
    out[k.startsWith('--') ? k : `--${k}`] = val.trim()
  }
  return out
}

/** Validates one theme file's JSON. Throws a readable message on the first problem. */
export function parseTheme(json: unknown, file: string): ThemeFile {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('must be a JSON object')
  const o = json as Record<string, unknown>
  const slug = file.replace(/\.json$/i, '')
  const t: ThemeFile = { id: `user:${slug}`, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : slug, file }
  if (typeof o.description === 'string') t.description = o.description.slice(0, 200)
  if (o.scheme != null) {
    if (o.scheme !== 'light' && o.scheme !== 'dark' && o.scheme !== 'auto') throw new Error('"scheme" must be "light", "dark" or "auto"')
    if (o.scheme !== 'auto') t.scheme = o.scheme
  }
  if (o.maxTier != null) {
    if (!TIERS.includes(o.maxTier as ThemeTier)) throw new Error(`"maxTier" must be one of ${TIERS.join(', ')}`)
    t.maxTier = o.maxTier as ThemeTier
  }
  if (o.artTint != null) {
    if (typeof o.artTint !== 'boolean') throw new Error('"artTint" must be true or false')
    t.artTint = o.artTint
  }
  if (o.accent != null) {
    if (typeof o.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.accent)) throw new Error('"accent" must be a #rrggbb color')
    t.accent = o.accent.toLowerCase()
  }
  const tokens = tokenMap(o.tokens, 'tokens')
  const light = tokenMap(o.light, 'light')
  const dark = tokenMap(o.dark, 'dark')
  if (tokens) t.tokens = tokens
  if (light) t.light = light
  if (dark) t.dark = dark
  if (o.css != null) {
    const css = Array.isArray(o.css) ? o.css.join('\n') : o.css
    if (typeof css !== 'string') throw new Error('"css" must be a string (or an array of lines)')
    if (css.length > MAX_CSS) throw new Error('"css" is over 64 KB')
    if (/<\/?style/i.test(css)) throw new Error('"css" must not contain <style>')
    t.css = css
  }
  return t
}

export function loadUserThemes(libraryRoot: string): UserThemes {
  const dir = themesDir(libraryRoot)
  const res: UserThemes = { dir, themes: [], errors: [] }
  let names: string[] = []
  try {
    // Created up front so "Show in Explorer" always has somewhere to go.
    mkdirSync(dir, { recursive: true })
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('.') && !n.includes('.sync-conflict-'))
  } catch {
    return res
  }
  for (const file of names.sort((a, b) => a.localeCompare(b))) {
    try {
      const p = join(dir, file)
      if (statSync(p).size > MAX_FILE) throw new Error('file is over 256 KB')
      const text = readFileSync(p, 'utf8').replace(/^﻿/, '')
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch (e) {
        throw new Error(`not valid JSON (${(e as Error).message})`)
      }
      res.themes.push(parseTheme(json, file))
    } catch (e) {
      res.errors.push({ file, error: (e as Error).message })
    }
  }
  return res
}

export const EXAMPLE_THEME = {
  name: 'Midnight Ember',
  description: 'Example theme: warm fixed accent, deeper glass. Edit or copy this file; changes apply live.',
  scheme: 'auto',
  artTint: false,
  accent: '#ff7a45',
  tokens: { 'r-lg': '16px', 'glass-blur': '34px' },
  light: { 'bg-solid': '#f6f1ec', 'glass-bg': 'rgb(255 250 245 / 0.58)' },
  dark: { 'bg-solid': '#141010', 'glass-bg': 'rgb(40 30 28 / 0.5)', fg: '#f7efe9' },
  css: ['/* Any CSS works here, e.g.: */', '.sidebar { letter-spacing: 0.01em; }'],
}

/** Creates the themes folder and an example file (never overwrites). Returns the example's path. */
export function writeExampleTheme(libraryRoot: string): string {
  const dir = themesDir(libraryRoot)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'example.json')
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(EXAMPLE_THEME, null, 2) + '\n')
  return p
}
