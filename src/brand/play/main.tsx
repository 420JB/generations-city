import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import '../preview/preview.css'
import './play.css'
import { ErrorBoundary } from '../../ui/ErrorBoundary'
import { PlayCityApp } from './PlayCityApp'

// PROOFY PLAY LAUNCH PAGE ENTRY. It never imports the sample brands: a city is drawn only from
// the configuration the Rare City server returned for a Play run.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <PlayCityApp />
    </ErrorBoundary>
  </StrictMode>,
)
