import { Component, type ReactNode } from 'react'
import { clearState } from '../game/persistence'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="fatal" role="alert">
        <h1>The city lost power.</h1>
        <p>Something went wrong while rendering Generations City. Your demo state may be from an older build.</p>
        <pre>{this.state.error.message}</pre>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            clearState(window.localStorage)
            window.location.reload()
          }}
        >
          Reset demo & reload
        </button>
      </div>
    )
  }
}
