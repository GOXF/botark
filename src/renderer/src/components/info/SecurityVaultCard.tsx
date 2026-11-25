import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Globe,
  KeyRound,
  MessageSquarePlus,
  RefreshCw,
  Sparkles,
  Users
} from 'lucide-react'
import type { SecurityVaultStatus } from '@shared/ipc'
import { ArkShieldVaultSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { fetchSecurityVaultStatus, hardenSecurityVaultPermissions } from '@/lib/vaultClient'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'
import type { InspectorTabId } from './platformInspector'

export function InspectorProtocolCard({
  bot,
  activeTab,
  onSelectTab
}: {
  bot: Bot
  activeTab: InspectorTabId
  onSelectTab: (tab: InspectorTabId) => void
}) {
  const webSessionOpen = useBotStore((s) => s.webSessionOpen)
  const toggleWebSession = useBotStore((s) => s.toggleWebSession)
  const startNewMuseSession = useBotStore((s) => s.startNewMuseSession)
  const startNewHermesSession = useBotStore((s) => s.startNewHermesSession)
  const setSelectedAgent = useBotStore((s) => s.setSelectedAgent)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const pending = useBotStore((s) =>
    bot.activeAccountId ? Boolean(s.accounts[bot.activeAccountId]?.pending) : false
  )
  const [busyAction, setBusyAction] = useState(false)

  const handleFreshGrokChat = async () => {
    if (!bot.activeAccountId || !bot.selectedAgentId) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    setBusyAction(true)
    try {
      await grok.rpc({
        accountId: bot.activeAccountId,
        op: 'call',
        method: 'StartFreshGrokBotConversation',
        params: { agent_id: bot.selectedAgentId }
      })
      setSelectedAgent(bot.id, bot.selectedAgentId)
    } finally {
      setBusyAction(false)
    }
  }

  return (
    <div className="mx-4 mb-2.5 flex items-center gap-1.5">
      {bot.platformId === 'meta-muse' && (
        <>
          <button
            type="button"
            onClick={() => void startNewMuseSession(bot.id)}
            className="press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-hover"
          >
            <MessageSquarePlus className="size-3.5 text-ink-secondary" aria-hidden />
            {t('New session')}
          </button>
          <button
            type="button"
            onClick={toggleWebSession}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              webSessionOpen
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Globe className="size-3.5 text-ink-secondary" aria-hidden />
            {webSessionOpen ? t('Chat view') : t('Web view')}
          </button>
        </>
      )}

      {bot.platformId === 'grok' && (
        <>
          <button
            type="button"
            disabled={busyAction || !bot.activeAccountId || !bot.selectedAgentId}
            onClick={() => void handleFreshGrokChat()}
            className="press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-hover disabled:opacity-50"
          >
            <MessageSquarePlus className="size-3.5 text-ink-secondary" aria-hidden />
            {t('New conversation')}
          </button>
          <button
            type="button"
            onClick={() => onSelectTab(activeTab === 'members' ? 'overview' : 'members')}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              activeTab === 'members'
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Users className="size-3.5 text-ink-secondary" aria-hidden />
            管理全部 Bot
          </button>
        </>
      )}

      {bot.platformId === 'hark' && (
        <>
          <button
            type="button"
            disabled={pending || !bot.activeAccountId}
            onClick={() => bot.activeAccountId && void connectAccount(bot.activeAccountId)}
            className="press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-hover disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5 text-ink-secondary', pending && 'animate-spin')} aria-hidden />
            {t('Sync session')}
          </button>
          <button
            type="button"
            onClick={toggleWebSession}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              webSessionOpen
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Globe className="size-3.5 text-ink-secondary" aria-hidden />
            {webSessionOpen ? t('Chat view') : t('Web view')}
          </button>
        </>
      )}

      {bot.platformId === 'dot' && (
        <>
          <button
            type="button"
            onClick={() => onSelectTab(activeTab === 'memory' ? 'overview' : 'memory')}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              activeTab === 'memory'
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Sparkles className="size-3.5 text-ink-secondary" aria-hidden />
            {t('Memory vault')}
          </button>
          <button
            type="button"
            onClick={toggleWebSession}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              webSessionOpen
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Globe className="size-3.5 text-ink-secondary" aria-hidden />
            {webSessionOpen ? t('Chat view') : t('Web view')}
          </button>
        </>
      )}

      {bot.platformId === 'hermes' && (
        <>
          <button
            type="button"
            disabled={busyAction}
            onClick={() => {
              setBusyAction(true)
              void startNewHermesSession(bot.id).finally(() => setBusyAction(false))
            }}
            className="press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-hover disabled:opacity-50"
          >
            <MessageSquarePlus className="size-3.5 text-ink-secondary" aria-hidden />
            {t('New session')}
          </button>
          <button
            type="button"
            onClick={() => onSelectTab(activeTab === 'computer' ? 'overview' : 'computer')}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              activeTab === 'computer'
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Sparkles className="size-3.5 text-ink-secondary" aria-hidden />
            {t('Tools & Skills')}
          </button>
        </>
      )}

      {bot.platformId === 'antigravity' && (
        <>
          <button
            type="button"
            onClick={() => useBotStore.getState().startNewAntigravitySession(bot.id)}
            className="press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-hover"
          >
            <MessageSquarePlus className="size-3.5 text-ink-secondary" aria-hidden />
            {t('New session')}
          </button>
          <button
            type="button"
            onClick={toggleWebSession}
            className={cn(
              'press inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
              webSessionOpen
                ? 'border-accent bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Globe className="size-3.5 text-ink-secondary" aria-hidden />
            {webSessionOpen ? t('Chat view') : t('Web view')}
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Full Security & Vault audit card rendered in `SettingsView` (`general` tab).
 */
export function SecurityVaultCenter() {
  const [status, setStatus] = useState<SecurityVaultStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [hint, setHint] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetchSecurityVaultStatus()
      setStatus(next)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleHarden = async () => {
    setLoading(true)
    setHint(undefined)
    try {
      const res = await hardenSecurityVaultPermissions()
      if (res) {
        setStatus(res.status)
        setHint(
          res.repaired > 0
            ? `已自动修复并锁定 ${res.repaired} 个保险箱文件为 0600 仅本人可读写权限`
            : '全部密文保险箱文件均已验证为 0600 严格权限'
        )
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 bg-sunken/30 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-status-online/12 text-status-online-ink">
            <ArkShieldVaultSvg className="size-4" />
          </span>
          <div>
            <h3 className="text-[14px] font-semibold text-ink">系统钥匙串与加密保险箱</h3>
            <p className="text-[12px] text-ink-secondary">
              全平台凭据由系统钥匙串 AES-256-GCM 硬件加密隔离存储
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void handleHarden()}>
            <KeyRound className="size-3.5" /> 加固 0600
          </Button>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {hint && (
        <div className="border-b border-line bg-status-online/8 px-4 py-2 text-[12px] text-status-online-ink">
          {hint}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2.5 p-4 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="text-[11.5px] text-ink-muted">钥匙串加密引擎</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <span
              className={cn(
                'size-2 rounded-full',
                status?.keychainAvailable ? 'bg-status-online' : 'bg-status-attention'
              )}
            />
            {status?.keychainAvailable ? 'AES-256-GCM 已激活' : '浏览器预览模式'}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">
            {status?.cipherSuite ?? 'macOS Keychain · Electron safeStorage'}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="text-[11.5px] text-ink-muted">进程隔离与网络防泄漏</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <CheckCircle2 className="size-3.5 text-status-online-ink" />
            Sandbox + Fail-Closed
          </p>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            1 Bot = 1 独立分区 · 代理异常自动黑洞断流
          </p>
        </div>

        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="text-[11.5px] text-ink-muted">应用签名与完整性</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <span
              className={cn(
                'size-2 rounded-full',
                status?.codeSigned ? 'bg-status-online' : 'bg-ink-muted'
              )}
            />
            {status?.codeSigned ? 'Apple Developer ID 已签名' : '本地开发模式'}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">
            {status?.signingAuthority ?? '正式构建启用 Hardened Runtime + 公证'}
          </p>
        </div>
      </div>

      {status?.stores && status.stores.length > 0 && (
        <div className="border-t border-line">
          <ul className="divide-y divide-line text-[12.5px]">
            {status.stores.map((store) => (
              <li key={store.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{store.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-muted">{store.fileName}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {store.exists ? (
                    <>
                      <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] tabular-nums text-ink-secondary">
                        {store.entryCount} 项密文
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 font-mono text-[11px] font-medium',
                          store.ownerOnly
                            ? 'bg-status-online/10 text-status-online-ink'
                            : 'bg-status-attention/15 text-status-attention'
                        )}
                      >
                        {store.modeOctal ?? '0600'} {store.ownerOnly ? '仅本人' : '待加固'}
                      </span>
                    </>
                  ) : (
                    <span className="text-[11.5px] text-ink-muted">尚未创建（按需加密落盘）</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
