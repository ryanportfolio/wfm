import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { errorMessage } from './errors'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: unknown
  hasError: boolean
}

/** Catches render-time exceptions anywhere in the app and shows a plain fallback. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, hasError: false }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error, hasError: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <main className="container">
        <div className="card" style={{ marginTop: 24 }}>
          <div className="card-title">
            <h2 className="error-text">Something went wrong</h2>
          </div>
          <p className="note">
            The app hit an error it could not recover from: {errorMessage(this.state.error)}
          </p>
          <p className="note">
            Reload the page to start over. Your data stays on this device, so nothing was sent or
            lost beyond the current view.
          </p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      </main>
    )
  }
}
