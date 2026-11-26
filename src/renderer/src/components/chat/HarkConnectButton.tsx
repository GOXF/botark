import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { ConnectorIcon } from '@/components/ui/ConnectorIcon'
import { connectHarkProvider, isHarkProviderConnected } from '@/lib/harkConnect'
import { useBotStore } from '@/store/botStore'

const DONE_KEY = 'botark:hark-connected-cards'
const readDone = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(DONE_KEY) || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
const markDone = (key: string) => {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...readDone().filter((k) => k !== key), key].slice(-300)))
  } catch {
    /* storage full: the card just shows the button again */
  }
}

/**
 * GOXF: a Hark "连接 X" card button. Opens the provider's auth page in a BotArk window; once the
 * page returns to Hark and the provider shows as connected, the card turns into 已连接 and Hark is
 * told to carry on (Hark's web app resumes the agent itself; BotArk has no such call, so it says so).
 */
export function HarkConnectButton({
  botId,
  accountId,
  provider,
  label,
  cardKey
}: {
  botId: string
  accountId: string
  provider: string
  label: string
  cardKey: string
}) {
  const sendMessage = useBotStore((s) => s.sendMessage)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'retry'>(() => (readDone().includes(cardKey) ? 'done' : 'idle'))
  const name = label.replace(/^(连接|重新连接|Connect)\s*/i, '') || provider

  // A card shown again after the provider was connected elsewhere still reads as done.
  useEffect(() => {
    if (state !== 'idle') return
    let live = true
    void isHarkProviderConnected(accountId, provider).then((ok) => {
      if (live && ok) setState('done')
    })
    return () => {
      live = false
    }
  }, [accountId, provider, state])

  const run = async (external?: boolean) => {
    setState('busy')
    const res = await connectHarkProvider(accountId, provider, { origin: 'chat', external })
    if (res === 'connected') {
      setState('done')
      markDone(cardKey)
      void sendMessage(botId, `${name} 已连接好了，继续吧。`)
    } else {
      setState(res === 'external' ? 'idle' : 'retry')
    }
  }

  if (state === 'done') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-sunken px-3 py-1 text-[12px] font-medium text-ink-secondary">
        <ConnectorIcon id={provider} name={label} className="size-4 border-0 bg-transparent shadow-none" />
        已连接 {name}
        <Check className="size-3.5 text-emerald-600" />
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={state === 'busy'}
        onClick={() => void run()}
        className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1 text-[12px] font-medium text-ink hover:bg-hover disabled:opacity-60"
      >
        {state === 'busy' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ConnectorIcon id={provider} name={label} className="size-4 border-0 bg-transparent shadow-none" />
        )}
        {state === 'busy' ? `正在连接 ${name}…` : label}
      </button>
      {state === 'retry' && (
        <>
          <span className="text-[12px] text-ink-muted">还没连上。</span>
          <button type="button" onClick={() => void run(true)} className="text-[12px] text-accent-600 hover:underline">
            改用浏览器打开
          </button>
        </>
      )}
    </span>
  )
}
