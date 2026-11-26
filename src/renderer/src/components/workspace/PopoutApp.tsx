import { useEffect } from 'react'
import { SquareArrowDownLeft } from 'lucide-react'
import { ChatArea } from '@/components/chat/ChatArea'
import { IconButton } from '@/components/ui/IconButton'
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
      <IconButton size="sm" label="放回主窗口" onClick={() => void getBridge()?.goxfPopout?.dock(botId)}>
        <SquareArrowDownLeft />
      </IconButton>
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
