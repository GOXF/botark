import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { BotAvatar } from '@/components/ui/Avatar'
import { cn } from '@/lib/cn'
import { formatDayLabel, isSameDay } from '@/lib/format'
import type { Bot, BotAccount, ChatMessage } from '@/types'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'
import { t } from '@/lib/i18n'

interface MessageListProps {
  bot: Bot
  messages: ChatMessage[]
  accounts: BotAccount[]
  typing: boolean
  onRetry: (messageId: string) => void
}

/** Messages closer than this (same sender & account) render as one run. */
const RUN_GAP_MS = 5 * 60 * 1000
/** Auto-scroll only if the reader is already near the bottom. */
const STICKY_THRESHOLD_PX = 120

function sameRun(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.role === b.role &&
    a.accountId === b.accountId &&
    Math.abs(b.createdAt - a.createdAt) < RUN_GAP_MS &&
    isSameDay(a.createdAt, b.createdAt)
  )
}

export const MessageList = memo(function MessageList({ bot, messages, accounts, typing, onRetry }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLOListElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const stickToBottom = useRef(true)
  // GOXF: coming back to a conversation always lands on the newest message (user asked 2026-11-24).
  const switchedAt = useRef(0)
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.displayName])), [accounts])
  const showAccount = bot.accountIds.length > 1
  const lastMessage = messages[messages.length - 1]

  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const previous = useRef({ bot, lastMessage, count: messages.length })

  const followBottom = useCallback(() => {
    if (!stickToBottom.current || scrollFrame.current !== null) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      const el = scrollRef.current
      if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
    })
  }, [])

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    const view = scrollRef.current
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(followBottom)
    if (transcript) observer?.observe(transcript)
    if (view) observer?.observe(view)
    return () => {
      observer?.disconnect()
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
    }
  }, [followBottom])

  useLayoutEffect(() => {
    const old = previous.current
    previous.current = { bot, lastMessage, count: messages.length }
    const switched = old.bot.id !== bot.id || old.bot.activeAccountId !== bot.activeAccountId ||
      old.bot.selectedAgentId !== bot.selectedAgentId || old.bot.hermesSessionKey !== bot.hermesSessionKey ||
      (old.bot.activeSessionId !== bot.activeSessionId && old.bot.activeSessionId !== undefined)
    const added = messages.length - old.count
    if (switched) switchedAt.current = Date.now()
    if (switched || (lastMessage?.role === 'user' && added > 0 && lastMessage.id !== old.lastMessage?.id)) {
      stickToBottom.current = true
      setAway(false)
      setUnseen(0)
    } else if (added > 0 && !stickToBottom.current && lastMessage?.role === 'bot') {
      setUnseen((count) => count + added)
    }
    followBottom()
  }, [bot, messages.length, lastMessage, typing, followBottom])

  const jumpToLatest = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
    stickToBottom.current = false
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    setUnseen(0)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const el = event.currentTarget
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD_PX
        // Right after a switch the scroll events come from layout, not the reader.
        if (!atBottom && Date.now() - switchedAt.current < 800) return
        stickToBottom.current = atBottom
        setAway(!atBottom)
        if (atBottom) setUnseen(0)
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <ol ref={transcriptRef} className="mx-auto flex max-w-[860px] flex-col px-8 py-6" aria-label={`Conversation with ${bot.name}`}>
        {messages.map((message, index) => {
          const prev = messages[index - 1]
          const next = messages[index + 1]
          const newDay = !prev || !isSameDay(prev.createdAt, message.createdAt)
          const isFirstInRun = !sameRun(prev, message)
          const isLastInRun = !sameRun(message, next)
          const isBot = message.role === 'bot'

          return (
            <Fragment key={message.id}>
              {newDay && (
                <li className="my-5 flex items-center justify-center gap-3 text-caption text-ink-muted first:mt-0" role="separator">
                  {formatDayLabel(message.createdAt)}
                </li>
              )}
              <li data-message-id={message.id} className={cn('group/msg rounded-xl', isFirstInRun && !newDay ? 'mt-3' : 'mt-1')}>
                <div className="flex items-start gap-2.5">
                  {isBot && (
                    <span className="mt-0.5 w-7 shrink-0">
                      {isFirstInRun && (
                        <BotAvatar
                          emoji={bot.emoji}
                          seed={bot.id}
                          avatar={bot.avatar}
                          avatarShape={bot.avatarShape}
                          avatarColor={bot.avatarColor}
                          platformId={bot.platformId}
                          size="sm"
                        />
                      )}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <MessageBubble
                      message={message}
                      isFirstInRun={isFirstInRun}
                      isLastInRun={isLastInRun}
                      accountLabel={showAccount ? accountNames.get(message.accountId) : undefined}
                      onRetry={onRetry}
                    />
                  </div>
                </div>
              </li>
            </Fragment>
          )
        })}
        {typing && (
          <li className="mt-4">
            <TypingIndicator bot={bot} />
          </li>
        )}
      </ol>
    </div>
      {away && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={unseen > 0 ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : t('Jump to latest')}
          className={cn(
            'press absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 animate-pop-lift items-center gap-1.5 rounded-full shadow-float',
            unseen > 0
              ? 'bg-accent-600 px-3 text-[13px] text-white hover:bg-accent-700'
              : 'w-8 justify-center border-[0.5px] border-line-strong bg-main text-ink-secondary hover:text-ink'
          )}
        >
          <ArrowDown className="size-4" aria-hidden />
          {unseen > 0 && <span className="tabular-nums">{unseen > 1 ? `${t('{n} new messages', { n: unseen })}` : t('New message')}</span>}
        </button>
      )}
    </div>
  )
})
