import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MessageList } from '@/components/chat/MessageList'
import { PaneHeader } from '@/components/layout/PaneHeader'
import { BotAvatar } from '@/components/ui/Avatar'
import { cn } from '@/lib/cn'
import { getBridge } from '@/lib/bridge'
import { getBotAccounts } from '@/lib/selectors'
import { useConversationTitles } from '@/services/workspaceSync'
import { harkHistory, useBotStore } from '@/store/botStore'
import type { Bot, ChatMessage } from '@/types'

/**
 * GOXF Issue #7: a tab pinned to a conversation that is not the bot's active
 * one (another pane or tab holds that). The bot's store keeps one
 * conversation's messages, so this pane reads its own through the platform's
 * history call; Hark projects also stay live. Clicking into the pane makes it
 * the bot's active conversation again, with the composer.
 */
export function ConversationMirror({ bot, conversationId, leading, extra }: { bot: Bot; conversationId: string; leading?: ReactNode; extra?: ReactNode }) {
  const accountId = bot.activeAccountId
  const accountMap = useBotStore((s) => s.accounts)
  const accounts = useMemo(() => getBotAccounts(bot, accountMap), [bot, accountMap])
  const title = useConversationTitles((s) => s[conversationId])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const live = { got: false }
    void useBotStore.getState().loadConversation(bot.id, conversationId).then(
      (rows) => {
        if (!alive) return
        if (rows) setMessages((m) => (live.got ? m : rows))
        else setError('读不到这个对话的记录')
      },
      (e) => alive && setError(String(e instanceof Error ? e.message : e))
    )
    const hark = bot.platformId === 'hark' ? getBridge()?.hark : undefined
    if (!hark) return () => { alive = false }
    const subscription = crypto.randomUUID()
    const off = hark.onEvent((e) => {
      if (!alive || e.type !== 'projectHistory' || e.subscription !== subscription) return
      live.got = true
      setMessages(harkHistory({ messages: e.messages }, bot.id, accountId))
      if (e.live) setBusy(e.live.busy)
    })
    void hark.rpc({ op: 'observeProject', accountId, conversationId, subscription }).catch(() => {})
    return () => {
      alive = false
      off()
      void hark.rpc({ op: 'leaveProject', accountId, subscription }).catch(() => {})
    }
  }, [accountId, bot.id, bot.platformId, conversationId])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader className={cn('gap-2 px-3', leading && 'border-b border-line pl-2')}>
        {leading && <div className="flex min-w-0 flex-1 items-center">{leading}</div>}
        <span className={cn('flex min-w-0 items-center gap-2', leading && 'shrink-0 rounded-full border-[0.5px] border-line-strong px-2 py-1 pr-3 shadow-float')}>
        <BotAvatar
          emoji={bot.emoji}
          seed={bot.id}
          avatar={bot.avatar}
          avatarShape={bot.avatarShape}
          avatarColor={bot.avatarColor}
          platformId={bot.platformId}
          size="sm"
        />
        <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">{bot.name}</span>
        </span>
        {leading ? (
          <div className="flex min-w-0 flex-1 items-center justify-end">{extra}</div>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">{title ?? '对话'}</span>
        )}
      </PaneHeader>
      {error && messages.length === 0 ? (
        <p role="alert" className="mx-6 my-4 text-[13px] text-status-error">{error}</p>
      ) : (
        <MessageList bot={bot} messages={messages} accounts={accounts} typing={busy} onRetry={() => {}} />
      )}
      <p className="shrink-0 border-t border-line px-4 py-2.5 text-center text-[12px] text-ink-muted">
        点一下这一格，就在这个对话里继续
      </p>
    </div>
  )
}
