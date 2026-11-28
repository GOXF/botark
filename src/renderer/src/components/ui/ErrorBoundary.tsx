import { desktopCopy } from '@/lib/desktopCopy'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Short name of the surface (e.g. "对话区", "右侧面板") shown on fallback. */
  surface?: string
  /** Optional reset key (e.g. selectedBotId) so switching bots recovers automatically. */
  resetKey?: string | null
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Lightweight React ErrorBoundary that isolates render failures to a single pane
 * (or the app root) and offers 1-click recovery without losing workspace data.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.surface ? `:${this.props.surface}` : ''}]`, error.message, info.componentStack?.slice(0, 400))
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex h-full min-h-[180px] flex-1 flex-col items-center justify-center gap-3 bg-main p-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-2xl border border-line bg-surface text-status-error shadow-soft">
          <AlertTriangle className="size-4.5" aria-hidden />
        </div>
        <div className="max-w-xs space-y-1">
          <p className="text-[14px] font-semibold text-ink">
            {this.props.surface ? desktopCopy("{0}渲染异常", "Couldn’t display {0}", [(this.props.surface)]) : desktopCopy("界面出现异常", "Something went wrong")}
          </p>
          <p className="truncate text-[12px] text-ink-muted">
            {this.state.error.message || desktopCopy("发生了意外错误，可一键恢复", "Something went wrong. Try again or reload the window.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-surface shadow-soft hover:opacity-90"
          >
            <RotateCcw className="size-3.5" aria-hidden />{desktopCopy("重试恢复", "Retry")}</button>
          {!this.props.surface && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="press inline-flex h-8 items-center rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
            >{desktopCopy("刷新窗口", "Refresh Window")}</button>
          )}
        </div>
      </div>
    )
  }
}
