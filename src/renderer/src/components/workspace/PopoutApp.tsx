import { useEffect } from 'react'
import { SquareArrowDownLeft } from 'lucide-react'
import { ChatArea } from '@/components/chat/ChatArea'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { getBridge } from '@/lib/bridge'
import { startPopoutClient } from '@/services/popoutSync'
import { useBotStore } from '@/store/botStore'
import { startPrefsSync } from '@/store/prefsStore'

/** GOXF: a session popped out into its own window (`?popout=<botId>`): just its chat and composer. */
export function PopoutApp({ botId }: { botId: string }) {
  const name = useBotStore((s) => s.bots.find((b) => b.id === botId)?.name)
  useEffect(() => startPopoutClient(botId), [botId])
  useEffect(() => startPrefsSync(), [])
  useEffect(() => {
    document.title = name ? `${name} · BotArk` : 'BotArk'
  }, [name])

  const dock = (
    <span className="no-drag flex items-center gap-0.5 border-l border-line pl-1">
      <button
        type="button"
        title="放回主窗口"
        aria-label="放回主窗口"
        onClick={() => void getBridge()?.goxfPopout?.dock(botId)}
        className="grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
      >
        <SquareArrowDownLeft className="size-3.5" />
      </button>
    </span>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-main">
      <ErrorBoundary surface="独立窗口" resetKey={botId}>
        <ChatArea botId={botId} headerExtra={dock} />
      </ErrorBoundary>
    </div>
  )
}
