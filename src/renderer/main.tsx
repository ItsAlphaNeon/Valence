import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/figtree'
import './theme/theme.css'
import './app.css'
import './features.css'

const root = createRoot(document.getElementById('root')!)

async function boot(): Promise<void> {
  // Dev-only harness for the audio engine (scripts/e2e-playback.mjs drives it).
  if (location.hash.startsWith('#engine-lab')) {
    const EngineLab = lazy(() => import('./audio/lab/EngineLab'))
    root.render(
      <Suspense fallback={null}>
        <EngineLab />
      </Suspense>,
    )
    return
  }
  const [{ App }, { initLibraryState }, { initAppearance }, { initPlayer }] = await Promise.all([
    import('./shell/App'),
    import('./state/library'),
    import('./theme/boot'),
    import('./state/player'),
  ])
  initLibraryState()
  void import('./state/favorites').then((m) => m.initFavorites())
  // scripts/e2e-ui.mjs launches with #e2e and drives routes directly.
  if (location.hash === '#e2e') {
    const ui = await import('./state/ui')
    Object.assign(window, { __valence: { navigate: ui.navigate, ui: ui.useUi } })
  }
  await initAppearance()
  root.render(<App />)
  void initPlayer()
}

void boot()
