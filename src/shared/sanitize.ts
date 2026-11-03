// Filename sanitizing that keeps library paths valid and readable on Windows, macOS, Linux
// and Android (FAT/exFAT SD cards included), and friendly to Syncthing.

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿­]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

export const MAX_COMPONENT = 80
export const MAX_REL_PATH = 180

/** Normalizes display text: NFC, strips zero-width/control characters, collapses whitespace. */
export function cleanText(input: string | undefined | null): string {
  if (!input) return ''
  return input
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null

/** Truncates to at most `max` UTF-16 code units without splitting a grapheme cluster. */
export function truncateGraphemes(s: string, max: number): string {
  if (s.length <= max) return s
  if (!segmenter) return s.slice(0, max)
  let out = ''
  for (const { segment } of segmenter.segment(s)) {
    if (out.length + segment.length > max) break
    out += segment
  }
  return out
}

/** Makes a single path component (folder or file stem) safe on every target filesystem. */
export function sanitizeComponent(input: string | undefined | null, maxLen = MAX_COMPONENT): string {
  let s = cleanText(input)
  s = s
    .replace(/\s*:\s+/g, ' - ') // "Fast & Furious: The Fast Saga" -> "Fast & Furious - The Fast Saga"
    .replace(/:/g, '-') // "Re:Zero" -> "Re-Zero"
    .replace(/[/\\]/g, '-')
    .replace(/[?*]/g, '')
    .replace(/"/g, "'")
    .replace(/[<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  // Leading dots hide files on Unix; trailing dots/spaces are stripped by Windows.
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`
  s = truncateGraphemes(s, maxLen).replace(/[. ]+$/, '')
  return s || '_'
}

/** Case-folded key used to detect folders that collide on case-insensitive filesystems. */
export function foldKey(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('en-US')
}

/** Normalizes text for fuzzy matching (artist/title/album comparisons). */
export function matchKey(s: string | undefined | null): string {
  return cleanText(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
