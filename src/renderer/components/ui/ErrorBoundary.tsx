import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: (err: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary]', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset)
      return (
        <div className="p-6 text-xs">
          <div className="text-red-400 mb-2">something broke in this panel</div>
          <pre className="text-fg-faint whitespace-pre-wrap mb-3">
            {this.state.error.message}
          </pre>
          <button
            onClick={this.reset}
            className="px-2 py-0.5 border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
          >
            retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
