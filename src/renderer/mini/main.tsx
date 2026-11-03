import { createRoot } from 'react-dom/client'

function Mini() {
  return <div style={{ fontFamily: 'system-ui', padding: 12 }}>Valence Mini Player</div>
}

createRoot(document.getElementById('root')!).render(<Mini />)
