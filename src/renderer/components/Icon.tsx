// Inline icon set (24×24, 1.8px strokes unless filled). Kept local so the app has no icon font.

import type { CSSProperties } from 'react'

const P: Record<string, string> = {
  play: 'M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z',
  pause: 'M7 4h3.2v16H7zM13.8 4H17v16h-3.2z',
  next: 'M4 5.2v13.6a.8.8 0 0 0 1.2.7l9.6-6.8a.8.8 0 0 0 0-1.4L5.2 4.5A.8.8 0 0 0 4 5.2zM17 4.5h3v15h-3z',
  prev: 'M20 5.2v13.6a.8.8 0 0 1-1.2.7l-9.6-6.8a.8.8 0 0 1 0-1.4l9.6-6.8a.8.8 0 0 1 1.2.7zM4 4.5h3v15H4z',
  stop: 'M6.5 5h11A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-11A1.5 1.5 0 0 1 6.5 5z',
}

const S: Record<string, string> = {
  shuffle: 'M3 7h3.5c2 0 3.2.9 4.3 2.6l2.4 4.8c1.1 1.7 2.3 2.6 4.3 2.6H21m0 0-3-3m3 3-3 3M3 17h3.5c1.3 0 2.2-.4 3-1.1M21 7h-3.5c-1.3 0-2.2.4-3 1.1M21 7l-3-3m3 3-3 3',
  repeat: 'M4 11V9a3 3 0 0 1 3-3h13m0 0-3-3m3 3-3 3M20 13v2a3 3 0 0 1-3 3H4m0 0 3 3m-3-3 3-3',
  volume: 'M4 9.5v5h3.5L12 19V5L7.5 9.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  volumeLow: 'M4 9.5v5h3.5L12 19V5L7.5 9.5H4zM15.5 9a4 4 0 0 1 0 6',
  mute: 'M4 9.5v5h3.5L12 19V5L7.5 9.5H4zM16 9.5l5 5m0-5-5 5',
  queue: 'M4 6h12M4 11h12M4 16h7M17 14v6l4.5-3-4.5-3z',
  lyrics: 'M5 5h14v10H9l-4 4V5zM8.5 9h7M8.5 12h4.5',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.3 15.3 20 20',
  songs: 'M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 18.5V5l11-2v13M20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  albums: 'M4 4h16v16H4zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 12h.01',
  artists: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  genres: 'M4 6.5 12 3l8 3.5-8 3.5-8-3.5zM4 12l8 3.5 8-3.5M4 17.5 12 21l8-3.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  playlist: 'M4 6h11M4 11h11M4 16h6M19 6v9.5M19 15.5a2.5 2.5 0 1 1-2.5-2.5 2.5 2.5 0 0 1 2.5 2.5z',
  smart: 'M12 3l2.1 5.4L19.5 10l-5.4 2.1L12 17.5l-2.1-5.4L4.5 10l5.4-1.6L12 3zM18.5 16l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z',
  wave: 'M3 12h2l2-6 3 12 3-15 3 15 2-6h3',
  tag: 'M3 12.2V4h8.2L21 13.8 13.8 21 3 12.2zM7.5 8.5h.01',
  inbox: 'M4 13l2.5-8h11L20 13v6H4v-6zM4 13h4.5l1 2.5h5l1-2.5H20',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  download: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14',
  folder: 'M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11z',
  mini: 'M4 5h16v14H4zM12 12h6v5h-6z',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8m0-4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16m0 4v-4h-4',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  warning: 'M12 4 2.5 20h19L12 4zM12 10v4.5M12 17.5h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5h.01',
  pin: 'M12 17v4M8 3h8l-1 6 3 3H6l3-3-1-6z',
  disc: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  mic: 'M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 0 0-7 0v5A3.5 3.5 0 0 0 12 15zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  heart: 'M12 20s-7.5-4.4-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.6-7.5 10-7.5 10z',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 4v6M10 14v6',
  eq: 'M6 20v-6M6 10V4M12 20v-9M12 7V4M18 20v-3M18 13V4M4 14h4M10 7h4M16 13h4',
  library: 'M5 4v16M10 4v16M14.5 4.8l4.8 14.9',
  zoomIn: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.3 15.3 20 20M10.5 8v5M8 10.5h5',
  zoomOut: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.3 15.3 20 20M8 10.5h5',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  moon: 'M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z',
  chart: 'M5 20v-8M11 20V5M17 20v-5M3 20h18',
  keyboard: 'M3 7h18v10H3zM7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M7.5 14h9',
  panel: 'M4 5h16v14H4zM14.5 5v14',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17M15.5 9h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  collapse: 'M11 17l-5-5 5-5M18 17l-5-5 5-5',
  sparkle: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z',
  device: 'M5 4h14v12H5zM9 20h6M12 16v4',
}

export type IconName = keyof typeof P | keyof typeof S

export function Icon({ name, size = 18, style, className, filled }: { name: IconName; size?: number; style?: CSSProperties; className?: string; filled?: boolean }) {
  const fill = P[name]
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden focusable="false">
      {fill ? (
        <path d={fill} fill="currentColor" />
      ) : (
        <path d={S[name]} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}
