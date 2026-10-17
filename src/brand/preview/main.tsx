import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import './preview.css'
import { ErrorBoundary } from '../../ui/ErrorBoundary'
import { SAMPLE_BRANDS } from '../samples'
import { PreviewApp } from './PreviewApp'

// LOCAL PREVIEW ENTRY: the only module allowed to import the simulated sample brands.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <PreviewApp brands={SAMPLE_BRANDS} />
    </ErrorBoundary>
  </StrictMode>,
)
