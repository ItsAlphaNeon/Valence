import { createRoot } from 'react-dom/client'

function App() {
  return <div style={{ fontFamily: 'system-ui', padding: 24 }}>Valence</div>
}

createRoot(document.getElementById('root')!).render(<App />)
