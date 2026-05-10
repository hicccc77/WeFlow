import React from 'react'
import { Check } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import type { ChatSession, Message } from '../../types/models'

export interface ChatMessageBubbleProps {
  message: Message
  messageKey: string
  session: ChatSession
  showTime?: boolean
  timeText?: string
  isSent: boolean
  isSystem: boolean
  isEmoji?: boolean
  isImage?: boolean
  isVoice?: boolean
  emojiHasAsset?: boolean
  emojiError?: boolean
  avatarUrl?: string
  isGroupChat?: boolean
  resolvedSenderName?: string
  isSelectionMode?: boolean
  isSelected?: boolean
  onContextMenu?: (event: React.MouseEvent, message: Message) => void
  onToggleSelection?: (messageKey: string, isShiftKey?: boolean) => void
  children: React.ReactNode
  portal?: React.ReactNode
}

function SelectionCheckbox({ checked, side }: { checked?: boolean; side: 'left' | 'right' }) {
  return (
    <div className={`chat-selection-checkbox ${side} ${checked ? 'checked' : ''}`}>
      {checked && <Check size={14} strokeWidth={3} />}
    </div>
  )
}

function ChatMessageBubble({
  message,
  messageKey,
  session,
  showTime,
  timeText,
  isSent,
  isSystem,
  isEmoji,
  isImage,
  isVoice,
  emojiHasAsset,
  emojiError,
  avatarUrl,
  isGroupChat,
  resolvedSenderName,
  isSelectionMode,
  isSelected,
  onContextMenu,
  onToggleSelection,
  children,
  portal
}: ChatMessageBubbleProps) {
  const bubbleClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')
  const avatarName = !isSent
    ? (isGroupChat ? (resolvedSenderName || '?') : (session.displayName || session.username))
    : '我'

  return (
    <>
      {showTime && timeText && (
        <div className="time-divider">
          <span>{timeText}</span>
        </div>
      )}
      <div
        className={`message-wrapper-with-selection ${isSelectionMode ? 'selectable' : ''}`}
        data-sent={isSent ? 'true' : 'false'}
        onClick={(event) => {
          if (!isSelectionMode) return
          event.stopPropagation()
          onToggleSelection?.(messageKey, event.shiftKey)
        }}
      >
        {isSelectionMode && !isSent && <SelectionCheckbox checked={isSelected} side="left" />}

        <div
          className={`message-bubble ${bubbleClass} ${isEmoji && emojiHasAsset && !emojiError ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVoice ? 'voice' : ''}`}
          onContextMenu={(event) => onContextMenu?.(event, message)}
        >
          <div className="bubble-avatar">
            <Avatar src={avatarUrl} name={avatarName} size={36} className="bubble-avatar" />
          </div>
          <div className="bubble-body">
            {isGroupChat && !isSent && (
              <div className="sender-name">
                {resolvedSenderName || '群成员'}
              </div>
            )}
            {children}
          </div>
        </div>

        {isSelectionMode && isSent && <SelectionCheckbox checked={isSelected} side="right" />}
        {portal}
      </div>
    </>
  )
}

function areEqual(prev: ChatMessageBubbleProps, next: ChatMessageBubbleProps) {
  return (
    prev.message === next.message &&
    prev.messageKey === next.messageKey &&
    prev.session.username === next.session.username &&
    prev.session.displayName === next.session.displayName &&
    prev.session.avatarUrl === next.session.avatarUrl &&
    prev.showTime === next.showTime &&
    prev.timeText === next.timeText &&
    prev.isSent === next.isSent &&
    prev.isSystem === next.isSystem &&
    prev.isEmoji === next.isEmoji &&
    prev.isImage === next.isImage &&
    prev.isVoice === next.isVoice &&
    prev.emojiHasAsset === next.emojiHasAsset &&
    prev.emojiError === next.emojiError &&
    prev.avatarUrl === next.avatarUrl &&
    prev.isGroupChat === next.isGroupChat &&
    prev.resolvedSenderName === next.resolvedSenderName &&
    prev.isSelectionMode === next.isSelectionMode &&
    prev.isSelected === next.isSelected &&
    prev.onContextMenu === next.onContextMenu &&
    prev.onToggleSelection === next.onToggleSelection &&
    prev.children === next.children &&
    prev.portal === next.portal
  )
}

export default React.memo(ChatMessageBubble, areEqual)
