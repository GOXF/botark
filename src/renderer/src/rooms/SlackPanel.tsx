import { desktopCopy, desktopNotice, useDesktopLocale } from '@/lib/desktopCopy'
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Trash2, Unlink } from 'lucide-react'
import type { SlackRequest, SlackState } from '@shared/slack'
import { ArkSlackWeaveSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { applySlackConnection } from './slackRooms'

export interface SlackPanelProps {
  id: string
  variant?: 'inspector' | 'inline'
}

export function SlackPanel({ id, variant = 'inspector' }: SlackPanelProps) {
  useDesktopLocale()
  const bridge = getBridge()?.slack
  const [open, setOpen] = useState(variant === 'inspector')
  const [state, setState] = useState<SlackState>()
  const [app, setApp] = useState('')
  const [bot, setBot] = useState('')
  const [channel, setChannel] = useState('')
  const [thread, setThread] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!bridge) return
    void bridge
      .request({ op: 'status' })
      .then((next) => setState(next))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [bridge])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  if (!bridge) return null

  const binding = state?.bindings.find((b) => b.roomId === id)

  async function run(req: SlackRequest) {
    setBusy(true)
    setError('')
    try {
      const next = await bridge!.request(req)
      applySlackConnection(bridge!, next)
      setState(next)
      if (req.op === 'connect') {
        setApp('')
        setBot('')
      }
      if (req.op === 'bind') {
        setChannel('')
        setThread('')
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <div className="flex flex-col gap-2.5 text-[12px]">
      {/* Compact Status Bar */}
      <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-sunken/45 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              state?.connected
                ? 'bg-status-online'
                : state?.saved
                  ? 'bg-status-attention'
                  : 'bg-ink-faint'
            )}
          />
          <span className="truncate text-[12.5px] font-medium text-ink">
            {state?.connected
              ? desktopCopy("Socket Mode 已连接", "Socket Mode Connected")
              : state?.saved
                ? desktopCopy("已保存凭据", "Saved credentials")
                : desktopCopy("未连接 Slack", "Not connected to Slack")}
          </span>
        </div>
        {state?.connected && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run({ op: 'disconnect' })}
            className="h-6 px-2 text-[11px]"
          >{desktopCopy("断开", "Disconnect")}</Button>
        )}
      </div>

      {/* Connect Form */}
      {!state?.connected && (
        <div className="flex flex-col gap-2">
          {!state?.saved && (
            <>
              <TextInput
                aria-label="App Token"
                type="password"
                autoComplete="off"
                placeholder="App Token (xapp-...)"
                value={app}
                onChange={(e) => setApp(e.target.value)}
                className="h-8 font-mono text-[12px]"
              />
              <TextInput
                aria-label="Bot Token"
                type="password"
                autoComplete="off"
                placeholder="Bot Token (xoxb-...)"
                value={bot}
                onChange={(e) => setBot(e.target.value)}
                className="h-8 font-mono text-[12px]"
              />
            </>
          )}

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || (!state?.saved && (!app.trim() || !bot.trim()))}
              onClick={() =>
                void run({
                  op: 'connect',
                  appToken: app.trim() || undefined,
                  botToken: bot.trim() || undefined
                })
              }
              className="flex-1"
            >
              {busy ? <Loader2 className="animate-spin" /> : <ArkSlackWeaveSvg />}
              {state?.saved ? desktopCopy("重连 Slack", "Reconnect Slack") : desktopCopy("连接 Slack", "Connect Slack")}
            </Button>
            {state?.saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run({ op: 'forget' })}
                title={desktopCopy("清除保存的 Slack 凭据", "Clear saved Slack credentials")}
                className="press-icon grid size-7 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-status-error"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Channel Binding */}
      {binding ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-accent-200/70 bg-accent-50/45 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <ArkSlackWeaveSvg className="size-3.5 text-accent-600" />
            <div className="min-w-0">
              <p className="truncate font-mono text-[12px] font-semibold text-ink">
                {binding.channel}
              </p>
              {binding.thread && (
                <p className="truncate font-mono text-[10.5px] text-ink-muted">
                  ts {binding.thread}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ op: 'unbind', roomId: id })}
            title={desktopCopy("解除频道绑定", "Unlink channel")}
            className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-status-error"
          >
            <Unlink className="size-3.5" />
          </button>
        </div>
      ) : (
        state?.connected && (
          <div className="flex flex-col gap-1.5">
            <TextInput
              aria-label={desktopCopy("Slack 频道 ID", "Slack Channel ID")}
              placeholder={desktopCopy("频道 ID（如 C07ABC123）", "Channel ID (e.g. C07ABC123)")}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="h-8 font-mono text-[12px]"
            />
            <TextInput
              aria-label={desktopCopy("Slack 线程时间戳", "Slack Thread Timestamp")}
              placeholder={desktopCopy("线程 ts（选填）", "Thread timestamp (optional)")}
              value={thread}
              onChange={(e) => setThread(e.target.value)}
              className="h-8 font-mono text-[12px]"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !channel.trim()}
              onClick={() =>
                void run({
                  op: 'bind',
                  roomId: id,
                  channel: channel.trim(),
                  thread: thread.trim() || undefined
                })
              }
              className="w-full"
            >{desktopCopy("绑定频道", "Link channel")}</Button>
          </div>
        )
      )}

      {error && (
        <p role="alert" className="text-[11px] text-status-error">
          {desktopNotice(error)}
        </p>
      )}
    </div>
  )

  if (variant === 'inspector') {
    return <div className="px-4 py-3">{content}</div>
  }

  return (
    <div className="shrink-0">
      <Button
        size="sm"
        variant="secondary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2.5 text-[11.5px]"
      >
        <ArkSlackWeaveSvg className="size-3.5" />
        Slack{binding ? ` · ${binding.channel}` : ''}
      </Button>
      {open && <div className="mt-2">{content}</div>}
    </div>
  )
}
