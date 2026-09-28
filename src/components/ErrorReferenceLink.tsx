import { ArrowRight, CircleHelp } from 'lucide-react'
import { openErrorReferenceWindow } from '../utils/errorReference'
import './ErrorReferenceLink.scss'

interface ErrorReferenceLinkProps {
  error?: unknown
  label?: string
  compact?: boolean
  inverse?: boolean
  className?: string
}

export default function ErrorReferenceLink({
  error,
  label = '核对错误码',
  compact = false,
  inverse = false,
  className = '',
}: ErrorReferenceLinkProps) {
  return (
    <button
      type="button"
      onClick={() => { void openErrorReferenceWindow(error) }}
      className={`error-reference-link ${compact ? 'compact' : ''} ${inverse ? 'inverse' : ''} ${className}`.trim()}
      aria-label={`${label}，在独立窗口中打开报错核对`}
    >
      <CircleHelp size={compact ? 13 : 15} aria-hidden="true" />
      {label}
      {!compact && <ArrowRight size={14} aria-hidden="true" />}
    </button>
  )
}
