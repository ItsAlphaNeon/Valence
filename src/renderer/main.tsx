import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

const EngineLab = lazy(() => import('./audio/lab/EngineLab'))

function App() {
  if (location.hash.startsWith('#engine-lab')) {
    return (
      <Suspense fallback={null}>
        <EngineLab />
      </Suspense>
    )
  }
  return <div style={{ fontFamily: 'system-ui', padding: 24 }}>Valence</div>
}

createRoot(document.getElementById('root')!).render(<App />)
