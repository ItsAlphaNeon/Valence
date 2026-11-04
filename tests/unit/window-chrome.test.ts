// Pure window-chrome helpers: colours, zoom, overlay geometry, the playback title, taskbar
// progress over a burst of import jobs, and the thumbnail-toolbar glyphs.

import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { TOPBAR_HEIGHT } from '@shared/types'
import {
  clampZoom,
  MAIN_BACKGROUND,
  MINI_BACKGROUND,
  overlayHeight,
  parseChrome,
  playbackTitle,
  TaskbarBatch,
  thumbarSpecs,
  thumbarSvg,
  trafficLightPosition,
  validColor,
} from '@main/windows/chrome-state'

describe('window chrome helpers', () => {
  it('accepts only hex colours', () => {
    expect(validColor('#fff')).toBe('#fff')
    expect(validColor(' #12345678 ')).toBe('#12345678')
    expect(validColor('red')).toBeNull()
    expect(validColor('#12')).toBeNull()
    expect(validColor(42)).toBeNull()
    expect(parseChrome({ symbolColor: '#000', background: 'nope' })).toEqual({ symbolColor: '#000', background: MAIN_BACKGROUND })
    expect(parseChrome(null)).toEqual({ symbolColor: '#ffffff', background: '#121212' })
    expect(MINI_BACKGROUND).toBe('#181818')
  })

  it('clamps zoom and sizes the overlay to the top bar', () => {
    expect(clampZoom(1.25)).toBe(1.25)
    expect(clampZoom(0.2)).toBe(0.7)
    expect(clampZoom('3')).toBe(1.6)
    expect(clampZoom('x')).toBeNull()
    expect(clampZoom(0)).toBeNull()
    expect(TOPBAR_HEIGHT).toBe(56)
    expect(overlayHeight()).toBe(56)
    expect(overlayHeight(1.5)).toBe(84)
    // Traffic lights (16 px) centred in the 56 px bar.
    expect(trafficLightPosition()).toEqual({ x: 18, y: 20 })
  })

  it('titles the window after the playing track', () => {
    expect(playbackTitle(null)).toBe('Valence')
    expect(playbackTitle({ hasTrack: false, title: 'X' })).toBe('Valence')
    expect(playbackTitle({ hasTrack: true, playing: true, title: ' Song ', artist: 'Band' })).toBe('Song • Band')
    expect(playbackTitle({ hasTrack: true, title: 'Song' })).toBe('Song')
    expect(playbackTitle({ hasTrack: true, title: 'x'.repeat(300) })).toHaveLength(200)
  })

  it('shows taskbar progress across a burst of jobs, only moving forward as jobs finish', () => {
    const b = new TaskbarBatch()
    expect(b.update([])).toBeNull()
    expect(b.update([{ id: 'a', status: 'queued', progress: 0 }])).toBeNull()
    expect(
      b.update([
        { id: 'a', status: 'running', progress: 0.5 },
        { id: 'b', status: 'queued', progress: 0 },
      ]),
    ).toBeCloseTo(0.25)
    // 'a' finished: it counts as complete while the burst lasts.
    expect(b.update([{ id: 'b', status: 'running', progress: 0.5 }])).toBeCloseTo(0.75)
    expect(b.update([])).toBeNull()
    // A new burst starts from scratch.
    expect(b.update([{ id: 'c', status: 'running', progress: 0.1 }])).toBeCloseTo(0.1)
  })

  it('lays out thumbnail-toolbar buttons without the flag Windows rejects', () => {
    const playing = thumbarSpecs({ playing: true, hasTrack: true })
    expect(playing.map((b) => [b.tooltip, b.glyph, b.command])).toEqual([
      ['Previous', 'prev', 'prev'],
      ['Pause', 'pause', 'toggle'],
      ['Next', 'next', 'next'],
    ])
    // Usable buttons carry no flags at all: passing 'enabled' makes setThumbarButtons fail.
    expect(playing.every((b) => b.flags.length === 0)).toBe(true)
    const paused = thumbarSpecs({ playing: false, hasTrack: true })
    expect(paused[1]).toMatchObject({ tooltip: 'Play', glyph: 'play' })
    const empty = thumbarSpecs({ playing: false, hasTrack: false })
    expect(empty.every((b) => b.flags.length === 1 && b.flags[0] === 'disabled')).toBe(true)
  })

  it('renders thumbnail-toolbar glyphs', async () => {
    for (const kind of ['prev', 'play', 'pause', 'next'] as const) {
      const png = await sharp(Buffer.from(thumbarSvg(kind, '#ffffff', 32))).png().toBuffer()
      const meta = await sharp(png).metadata()
      expect([meta.width, meta.height]).toEqual([32, 32])
    }
  })
})
