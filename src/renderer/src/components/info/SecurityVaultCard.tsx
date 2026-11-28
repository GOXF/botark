import { desktopNotice, useDesktopLocale } from '@/lib/desktopCopy'
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
import { t, useT } from '@/lib/i18n'
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
  const tr = useT()
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
                : 'border-line bg-surface text-ink hover:bg-hover'
            )}
          >
            <Users className="size-3.5 text-ink-secondary" aria-hidden />
            {tr("Manage all bots")}
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
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
                ? 'border-accent-600/40 bg-accent-50 text-accent-600'
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
const vaultLabels: Record<string, string> = {
  "proxy": "Per-account proxy vault",
  "proxy-pool": "Global proxy pool vault",
  "grok-tokens": "Grok Sand token vault",
  "dot-tokens": "Dot OAuth credential vault",
  "cue-tokens": "Cue session credential vault",
  "hermes-accounts": "Hermes gateway key vault",
  "dsbot-accounts": "DS Bot credential and key vault",
  "mcp-registry": "MCP service key vault",
  "mobile-sync": "iOS paired-device token hash store",
  "secrets-vault": "Memory snapshot and private data vault",
}

export function SecurityVaultCenter() {
  useDesktopLocale()
  const tr = useT()
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
            ? tr("Set {n} vault files to owner-only read and write (0600).", { n: res.repaired })
            : tr("All encrypted vault files already have owner-only permissions (0600).")
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
            <h3 className="text-[14px] font-semibold text-ink">{tr("System Keychain and encrypted vault")}</h3>
            <p className="text-[12px] text-ink-secondary">
              {tr("Platform credentials are encrypted and stored using system secure storage.")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void handleHarden()}>
            <KeyRound className="size-3.5" /> {tr("Set owner-only permissions")}
          </Button>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {hint && (
        <div className="border-b border-line bg-status-online/8 px-4 py-2 text-[12px] text-status-online-ink">
          {desktopNotice(hint)}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2.5 p-4 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="text-[11.5px] text-ink-muted">{tr("Keychain encryption")}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <span
              className={cn(
                'size-2 rounded-full',
                status?.keychainAvailable ? 'bg-status-online' : 'bg-status-attention'
              )}
            />
            {status?.keychainAvailable ? tr("AES-256-GCM active") : tr("Browser preview mode")}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">
            {status?.cipherSuite ?? 'macOS Keychain · Electron safeStorage'}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="text-[11.5px] text-ink-muted">{tr("Process and network isolation")}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <CheckCircle2 className="size-3.5 text-status-online-ink" />
            Sandbox + Fail-Closed
          </p>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            {tr("Each bot has a separate partition. Traffic stops if its proxy fails.")}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="text-[11.5px] text-ink-muted">{tr("App signing and integrity")}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <span
              className={cn(
                'size-2 rounded-full',
                status?.codeSigned ? 'bg-status-online' : 'bg-ink-muted'
              )}
            />
            {status?.codeSigned ? tr("Signed with Apple Developer ID") : tr("Local development build")}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">
            {status?.signingAuthority ?? tr("Release builds use Hardened Runtime and notarization")}
          </p>
        </div>
      </div>

      {status?.stores && status.stores.length > 0 && (
        <div className="border-t border-line">
          <ul className="divide-y divide-line text-[12.5px]">
            {status.stores.map((store) => (
              <li key={store.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{vaultLabels[store.id] ? tr(vaultLabels[store.id]) : store.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-muted">{store.fileName}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {store.exists ? (
                    <>
                      <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] tabular-nums text-ink-secondary">
                        {tr("Encrypted entries: {n}", { n: store.entryCount })}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 font-mono text-[11px] font-medium',
                          store.ownerOnly
                            ? 'bg-status-online/10 text-status-online-ink'
                            : 'bg-status-attention/15 text-status-attention'
                        )}
                      >
                        {store.modeOctal ?? '0600'} {store.ownerOnly ? tr("Owner only") : tr("Needs attention")}
                      </span>
                    </>
                  ) : (
                    <span className="text-[11.5px] text-ink-muted">{tr("Not created yet")}</span>
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
