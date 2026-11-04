// Keyboard shortcuts overlay (press ?).

import { Fragment } from 'react'
import { useUi } from '../state/ui'
import { Modal } from '../components/ui'
import { MOD } from './TopBar'

export const SHORTCUTS: Array<[string, Array<[string, string[]]>]> = [
  [
    'Playback',
    [
      ['Play / pause', ['Space']],
      ['Next song', [MOD, '→']],
      ['Previous song', [MOD, '←']],
      ['Seek forward 10 s', ['Shift', '→']],
      ['Seek back 10 s', ['Shift', '←']],
      ['Volume up', [MOD, '↑']],
      ['Volume down', [MOD, '↓']],
      ['Mute', ['M']],
      ['Shuffle', [MOD, 'S']],
      ['Repeat', [MOD, 'R']],
      ['Like current song', ['Alt', 'Shift', 'B']],
    ],
  ],
  [
    'Navigation',
    [
      ['Command palette', [MOD, 'K']],
      ['Search', [MOD, 'F']],
      ['Back', ['Alt', '←']],
      ['Forward', ['Alt', '→']],
      ['Settings', [MOD, ',']],
      ['New playlist', [MOD, 'N']],
      ['Keyboard shortcuts', ['?']],
    ],
  ],
  [
    'Layout',
    [
      ['Queue', [MOD, 'U']],
      ['Lyrics', [MOD, 'L']],
      ['Now playing info', [MOD, 'I']],
      ['Collapse the sidebar', ['Alt', 'Shift', 'L']],
      ['Toggle right panel', ['Alt', 'Shift', 'R']],
      ['Mini player', [MOD, 'Shift', 'M']],
      ['Zoom in / out', [MOD, '+ / −']],
      ['Reset zoom', [MOD, '0']],
    ],
  ],
  [
    'Lists',
    [
      ['Select all', [MOD, 'A']],
      ['Play selection', ['Enter']],
      ['Get Info', [MOD, 'I']],
      ['Close / clear', ['Esc']],
    ],
  ],
]

export function ShortcutsOverlay() {
  const open = useUi((s) => s.shortcuts)
  if (!open) return null
  return (
    <Modal title="Keyboard shortcuts" width={760} onClose={() => useUi.getState().setShortcuts(false)}>
      <div className="shortcuts">
        {SHORTCUTS.map(([group, rows]) => (
          <Fragment key={group}>
            <h4>{group}</h4>
            {rows.map(([label, keys]) => (
              <div className="shortcut-row" key={label}>
                <span>{label}</span>
                <span className="shortcut-keys">
                  {keys.map((k) => (
                    <span className="kbd" key={k}>
                      {k}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </Modal>
  )
}
