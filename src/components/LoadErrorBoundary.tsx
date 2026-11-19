import { Component, type ErrorInfo, type ReactNode } from 'react'
import './LoadErrorBoundary.scss'

interface Props {
  children: ReactNode
  /** 错误标题，例如「AI 页面加载失败」 */
  title?: string
  /** 点击重试时触发；不传则不渲染重试按钮 */
  onRetry?: () => void
  retryLabel?: string
}

interface State {
  error: Error | null
}

/**
 * 通用错误边界。
 *
 * 动态导入（React.lazy）失败时，错误会一路冒泡到根节点；如果没有边界兜底，
 * React 会卸载整棵树，窗口只剩下背景色，表现为无法恢复的黑屏。
 *
 * 注意：Chromium 会缓存失败的模块加载，同一个 URL 的再次 import() 会立刻复用
 * 上次的失败结果，所以「重试」只能通过重新加载页面/窗口来实现。
 */
export class LoadErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('LoadErrorBoundary caught:', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="load-error" role="alert">
        <p className="load-error__title">{this.props.title || '页面加载失败'}</p>
        <p className="load-error__detail">{error.message || '未知错误'}</p>
        {this.props.onRetry ? (
          <button type="button" className="load-error__retry" onClick={this.handleRetry}>
            {this.props.retryLabel || '重试'}
          </button>
        ) : null}
      </div>
    )
  }
}
