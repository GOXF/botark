// GOXF: first, so a popped-out window never writes the main window's saved state.
import { popoutBotId } from './lib/popout'
import '@fontsource-variable/inter'
import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerBuiltInAdapters } from '@adapters/index'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import App from './App'
import { PopoutApp } from './components/workspace/PopoutApp'

// Adapters must be registered before the store talks to them.
registerBuiltInAdapters()

// Files dropped outside a drop zone must not navigate away from the app.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => event.preventDefault())
}

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {popoutBotId ? <PopoutApp botId={popoutBotId} /> : <App />}
    </ErrorBoundary>
  </StrictMode>
)
