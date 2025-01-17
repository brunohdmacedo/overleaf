import { memo, useCallback, useState } from 'react'
import { Change, CommentOperation } from '../../../../../types/change'
import { ReviewPanelMessage } from './review-panel-message'
import { useTranslation } from 'react-i18next'
import {
  useThreadsActionsContext,
  useThreadsContext,
} from '../context/threads-context'
import { useCodeMirrorStateContext } from '@/features/source-editor/components/codemirror-editor'
import classnames from 'classnames'
import { isFocused } from '../utils/is-focused'
import AutoExpandingTextArea from '@/shared/components/auto-expanding-text-area'
import MaterialIcon from '@/shared/components/material-icon'

export const ReviewPanelComment = memo<{
  comment: Change<CommentOperation>
  top?: number
}>(({ comment, top }) => {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<Error>()
  const [content, setContent] = useState('')
  const threads = useThreadsContext()
  const { resolveThread, addMessage } = useThreadsActionsContext()
  const state = useCodeMirrorStateContext()

  const handleSubmitReply = useCallback(() => {
    setSubmitting(true)
    addMessage(comment.op.t, content)
      .then(() => {
        setContent('')
      })
      .catch(error => {
        setError(error)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }, [addMessage, comment.op.t, content])

  const handleCommentReplyKeyPress = (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      handleSubmitReply()
    }
  }

  const thread = threads?.[comment.op.t]
  if (!thread || thread.resolved) {
    return null
  }

  const focused = isFocused(comment.op, state.selection.main)

  return (
    <div
      className={classnames(
        'review-panel-entry',
        'review-panel-entry-comment',
        {
          'review-panel-entry-loaded': !!threads?.[comment.op.t],
          'review-panel-entry-focused': focused,
        }
      )}
      data-top={top}
      data-pos={comment.op.p}
      style={{
        position: top === undefined ? 'relative' : 'absolute',
        visibility: top === undefined ? 'visible' : 'hidden',
        transition: 'top .3s, left .1s, right .1s',
      }}
    >
      <div className="review-panel-entry-indicator">
        <MaterialIcon type="edit" className="review-panel-entry-icon" />
      </div>

      <div className="review-panel-entry-content">
        {thread.messages.map((message, i) => {
          const isReply = i !== 0

          return (
            <div key={message.id} className="review-panel-comment-wrapper">
              {isReply && (
                <div className="review-panel-comment-reply-divider" />
              )}

              <ReviewPanelMessage
                message={message}
                threadId={comment.op.t}
                isReply={isReply}
                hasReplies={!isReply && thread.messages.length > 1}
                onResolve={() => resolveThread(comment.op.t)}
              />
            </div>
          )
        })}

        <AutoExpandingTextArea
          name="content"
          className="review-panel-comment-input"
          onChange={e => setContent(e.target.value)}
          onKeyDown={handleCommentReplyKeyPress}
          placeholder={t('reply')}
          value={content}
          disabled={submitting}
        />

        {error && <div>{error.message}</div>}
      </div>
    </div>
  )
})
ReviewPanelComment.displayName = 'ReviewPanelComment'
