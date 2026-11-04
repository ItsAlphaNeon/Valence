// Icons: Material Icons (Rounded), the set the Android app draws with, so both apps look alike.
// The paths come from scripts/gen-icons.mjs (icons.generated.ts); nothing is loaded at runtime.

import type { CSSProperties } from 'react'
import { ICON_PATHS } from './icons.generated'

/** Musicolet's options button: a filled rounded square with three dots cut out of it. */
const OPTIONS =
  'M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm1.3 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm3.7 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm3.7 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z'

const PATHS = { ...ICON_PATHS, more: OPTIONS }

export type IconName = keyof typeof PATHS

/** Icons with an outline form, used unless `filled` is set (an empty heart or star). */
const OUTLINE: Partial<Record<IconName, IconName>> = { heart: 'heartOutline', star: 'starOutline' }

export function Icon({ name, size = 18, style, className, filled }: { name: IconName; size?: number; style?: CSSProperties; className?: string; filled?: boolean }) {
  const shown = (!filled && OUTLINE[name]) || name
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden focusable="false">
      <path d={PATHS[shown]} fill="currentColor" fillRule={shown === 'more' ? 'evenodd' : undefined} />
    </svg>
  )
}
