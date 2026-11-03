export function duration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0:00'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function longDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const d = Math.floor(h / 24)
  if (d >= 2) return `${d} days`
  return `${h} hr ${min % 60} min`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString()
}

export function quality(t: { codec: string; bitrate: number; sampleRate: number; lossless: boolean }): string {
  const codec = (t.codec || '').toUpperCase()
  if (t.lossless) return `${codec} ${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz`
  return `${codec} ${Math.round(t.bitrate / 1000)} kbps`
}

export function cx(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ')
}
