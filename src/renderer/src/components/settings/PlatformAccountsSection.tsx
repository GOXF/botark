import { desktopCopy, desktopNotice, useDesktopLocale } from '@/lib/desktopCopy'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Globe, KeyRound, LogOut, Plus, RefreshCw, Shuffle, Trash2 } from 'lucide-react'
import type { ConnectionStatus, PlatformId } from '@adapters/types'
import { createId } from '@shared/id'
import { keepMuseBatchProxyAssignments, MuseBatchImport } from '@/components/add-bot/MuseBatchImport'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { Dialog } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { importHarkCredentialsForAccount } from '@/lib/harkCredentialImport'
import { useT, t } from '@/lib/i18n'
import { proxyPoolArgsForAccounts, useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'
import type { useProxyPool } from './ProxyPoolSection'
import type { SettingsActivity, SettingsTab } from './SettingsView'

interface AccountListProps {
  accounts: readonly BotAccount[]
  botsByAccountId: ReadonlyMap<string, Bot[]>
}

interface AccountTabProps extends AccountListProps {
  active: boolean
  activity: SettingsActivity
}

interface AccountImportProps extends AccountTabProps {
  credentialRevision: number
}

export interface DotStoredMeta {
  accountId: string
  handle?: string
  planType?: string
  mode?: 'dot' | 'native'
  model?: string
  hasRefreshToken?: boolean
}

const EMPTY_ACCOUNTS: readonly BotAccount[] = []

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  'meta-muse': 'Meta Muse',
  dot: 'ChatGPT Dot',
  grok: 'Grok Bot',
  hark: 'Hark Pro',
  gemini: 'Google Gemini',
  hermes: 'Hermes',
  antigravity: 'Antigravity',
  cue: 'Cue (Manus)',
  'ds-bot': 'DS Bot'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isOnlineStatus(status: ConnectionStatus | undefined): boolean {
  return status === 'online' || status === 'busy' || status === 'attention'
}

export function indexBotsByAccount(bots: readonly Bot[]): Map<string, Bot[]> {
  const indexed = new Map<string, Bot[]>()
  for (const bot of bots) {
    for (const id of bot.accountIds) {
      const owners = indexed.get(id)
      if (owners) owners.push(bot)
      else indexed.set(id, [bot])
    }
  }
  return indexed
}

export function useDotStoredMeta(
  settingsTab: SettingsTab,
  accountCount: number,
  cleaning: RefObject<boolean>
) {
  const [dotMetaMap, setDotMetaMap] = useState<Record<string, DotStoredMeta>>({})
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const { settingsOpen, settingsTab } = useBotStore.getState()
    if (cleaning.current || !settingsOpen || (settingsTab !== 'overview' && settingsTab !== 'dot-accounts')) return
    const dot = getBridge()?.dot
    if (!dot?.rpc) return
    const request = ++requestId.current
    try {
      const res = await dot.rpc({ accountId: '_', op: 'listStoredAccounts' })
      const current = useBotStore.getState()
      if (!current.settingsOpen || current.settingsTab !== settingsTab || requestId.current !== request) return
      if (res.ok && Array.isArray(res.data)) {
        const map: Record<string, DotStoredMeta> = {}
        for (const item of res.data as DotStoredMeta[]) {
          if (item && typeof item.accountId === 'string') {
            map[item.accountId] = item
          }
        }
        setDotMetaMap(map)
      }
    } catch {
      /* ignore */
    }
  }, [cleaning])

  const invalidate = useCallback(() => {
    requestId.current++
  }, [])
  useLayoutEffect(() => invalidate, [invalidate, settingsTab])
  useEffect(() => {
    void refresh()
  }, [refresh, settingsTab, accountCount])

  return { dotMetaMap, refresh, invalidate, clear: () => setDotMetaMap({}) }
}

async function quickAddProxyAccount(
  platformId: 'meta-muse' | 'hark' | 'cue',
  baseName: string,
  { busy, setBusy }: SettingsActivity
) {
  if (busy) return
  setBusy(true)
  const { accounts, bots, addBot } = useBotStore.getState()
  const index = bots.filter((bot) => bot.platformId === platformId).length + 1
  const accountId = createId(platformId === 'cue' ? 'acc_cue' : 'acc')
  const name = platformId === 'cue' && index === 1 ? baseName : `${baseName} ${index}`
  try {
    const muse = getBridge()?.muse
    if (muse?.assignProxyPool) {
      const args = proxyPoolArgsForAccounts(accounts, [accountId])
      await muse.assignProxyPool(args.accountIds, keepMuseBatchProxyAssignments(args.keepIds)).catch(() => undefined)
    }
    addBot({
      id: createId('bot'),
      platformId,
      name,
      accounts: [{ key: accountId, accountId, displayName: name, handle: '' }],
      background: true
    })
    return accountId
  } finally {
    setBusy(false)
  }
}

type MuseProxyPool = Pick<ReturnType<typeof useProxyPool>, 'pool' | 'accountProxies' | 'refresh' | 'assignMuseProxies'>

function MuseAccountsSection({
  active, accounts: museAccounts, botsByAccountId, activity, proxyPool
}: AccountTabProps & { proxyPool: MuseProxyPool }) {
  useDesktopLocale()
  const tr = useT()
  const { busy } = activity
  const { pool, accountProxies, refresh: refreshProxiesAndPool, assignMuseProxies } = proxyPool
  const [batchOpen, setBatchOpen] = useState(false)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const selectBot = useBotStore((s) => s.selectBot)
  const openMuseLogin = useBotStore((s) => s.openMuseLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)

  const handleQuickAddMuseAccount = async () => {
    const accountId = await quickAddProxyAccount('meta-muse', 'Muse', activity)
    if (!accountId) return
    void refreshProxiesAndPool()
    void openMuseLogin(accountId)
  }

  return (
    <>
      {active && (
        <div className="flex flex-col gap-5 animate-veil-in">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight text-ink">{desktopCopy("Muse 账号", "Muse Account")}</h2>
              <p className="mt-1 text-[13px] text-ink-secondary">{desktopCopy("独立隔离多账号会话，支持批量导入与自动分配代理。", "Accounts use separate sessions. Bulk import and automatic proxy assignment are supported.")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setBatchOpen(true)}>{desktopCopy("批量导入账号 (邮箱 | 收件箱)", "Bulk import accounts (email | inbox URL)")}</Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddMuseAccount()}>
                <Plus className="size-3.5" />{desktopCopy(" 新增 Muse 账号", " Add Muse Account")}</Button>
            </div>
          </div>

          {/* Quick Summary Bar */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
              <p className="text-[12px] text-ink-muted">{desktopCopy("Muse 账号总数", "Total Muse accounts")}</p>
              <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{museAccounts.length}</p>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
              <p className="text-[12px] text-ink-muted">{desktopCopy("在线就绪", "Ready")}</p>
              <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
                {museAccounts.filter((account) => isOnlineStatus(account.status)).length}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
              <p className="text-[12px] text-ink-muted">{desktopCopy("已绑定独立代理", "Dedicated proxy assigned")}</p>
              <p className="mt-1 flex items-baseline justify-between">
                <span className="text-[22px] font-semibold tabular-nums text-ink">
                  {Object.values(accountProxies).filter((p) => p && p.mode !== 'direct').length}
                </span>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true, 'proxy-pool')}
                  className="text-[12px] font-medium text-accent-600 hover:underline"
                >
                  {tr('Configure proxy pool')} →
                </button>
              </p>
            </div>
          </div>

          {/* Accounts List */}
          {museAccounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-12 text-center">
              <p className="text-[14px] font-medium text-ink">{desktopCopy("暂无 Muse 账号", "No Muse accounts yet")}</p>
              <p className="max-w-md text-[12.5px] text-ink-muted">{desktopCopy("你可以先在「代理池与自动分配」导入一批代理，然后点击「批量导入账号」或「新增 Muse 账号」，系统会自动实现一号一代理。", "Import proxies in Proxy pool before adding or importing Muse accounts if you want automatic assignment.")}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true, 'proxy-pool')}>{desktopCopy("先导入代理池", "Import proxy pool first")}</Button>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => setBatchOpen(true)}>{desktopCopy("批量导入 Muse 账号", "Import Muse accounts in bulk")}</Button>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
              <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                <span>{desktopCopy("账号与对应 Bot", "Accounts and bots")}</span>
                <div className="flex items-center gap-2">
                  {pool.length > 0 && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void assignMuseProxies()}>
                      <Shuffle className="size-3.5" />{desktopCopy(" 一键按代理池重新一对一匹配", " Rematch accounts and proxies")}</Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void refreshProxiesAndPool()}>
                    <RefreshCw className="size-3.5" />{desktopCopy(" 刷新", " Refresh")}</Button>
                </div>
              </div>
              <ul className="divide-y divide-line">
                {museAccounts.map((acc) => {
                  const ownerBot = botsByAccountId.get(acc.id)?.[0]
                  const px = accountProxies[acc.id]
                  const hasProxy = px && px.mode !== 'direct' && px.host && px.port
                  return (
                    <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                      <div className="flex min-w-0 items-center gap-3">
                        <BotAvatar
                          seed={ownerBot?.id ?? acc.id}
                          avatar={ownerBot?.avatar}
                          avatarShape={ownerBot?.avatarShape}
                          avatarColor={ownerBot?.avatarColor}
                          status={acc.status}
                          size="md"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-ink">
                              {ownerBot?.name || acc.displayName}
                            </span>
                            <StatusBadge status={acc.status} />
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                            <span className="font-mono text-[11px]">{acc.handle || acc.id}</span>
                            <span>·</span>
                            {hasProxy ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-accent-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent-600">
                                <Globe className="size-3" />
                                {px.mode}://{px.username ? `${px.username}@` : ''}
                                {px.host}:{px.port}
                              </span>
                            ) : (
                              <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-muted">{desktopCopy("直连 (无代理)", "Direct connection (no proxy)")}</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {ownerBot && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => selectBot(ownerBot.id)}
                          >{desktopCopy("进入对话", "Open conversation")}</Button>
                        )}
                        {acc.status === 'offline' ? (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={acc.pending}
                            onClick={() => void openMuseLogin(acc.id)}
                          >{desktopCopy("登录", "Login")}</Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={acc.pending}
                            onClick={() => void connectAccount(acc.id)}
                          >{desktopCopy("重连", "Reconnect")}</Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={acc.pending}
                          onClick={() => void signOutAccount(acc.id)}
                          title={desktopCopy("退出登录", "Sign out")}
                        >
                          <LogOut className="size-3.5" />
                        </Button>
                        {ownerBot && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeBot(ownerBot.id)}
                            title={desktopCopy("删除该账号与 Bot", "Remove this account and its bots")}
                          >
                            <Trash2 className="size-3.5 text-status-error" />
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        title={t('Batch import Muse accounts')}
      >
        <MuseBatchImport
          onDone={() => {
            setBatchOpen(false)
            void refreshProxiesAndPool()
          }}
        />
      </Dialog>
    </>
  )
}

function DotAccountsSection({
  active, accounts: dotAccounts, botsByAccountId, activity, credentialRevision, dotMetaMap, refreshDotStoredMeta
}: AccountImportProps & { dotMetaMap: Record<string, DotStoredMeta>; refreshDotStoredMeta: () => Promise<void> }) {
  useDesktopLocale()
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const openDotLogin = useBotStore((s) => s.openDotLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const renameBot = useBotStore((s) => s.renameBot)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const [dotRawInput, setDotRawInput] = useState('')
  const [dotRefreshInput, setDotRefreshInput] = useState('')
  const [dotTargetAccountId, setDotTargetAccountId] = useState<string>('__new__')
  const [dotMigrateMemory, setDotMigrateMemory] = useState(true)
  const dotInputRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    setDotRawInput('')
    setDotRefreshInput('')
    setDotTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddDotAccount = () => {
    const accountId = createId('acc_dot')
    const botId = createId('bot')
    const index = useBotStore.getState().bots.filter((bot) => bot.platformId === 'dot').length + 1
    addBot({
      id: botId,
      platformId: 'dot',
      name: `Dot ${index}`,
      emoji: '🪐',
      accounts: [{ key: accountId, accountId, displayName: `Dot ${index}`, handle: '' }],
      background: true
    })
    void openDotLogin(accountId)
  }

  const handleImportDotCredentials = async () => {
    const dot = getBridge()?.dot
    if (!dot?.importCredentials) return
    const raw = dotRawInput.trim()
    const rt = dotRefreshInput.trim()
    if (!raw && !rt) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = dotTargetAccountId === '__new__' || !accounts[dotTargetAccountId]

      // Support batch multi-line AT/RT or JSON array when creating new Dot Bots
      if (isNew && !rt) {
        let batchItems: string[] = []
        if (raw.startsWith('[')) {
          try {
            const arr = JSON.parse(raw) as unknown[]
            if (Array.isArray(arr) && arr.length > 1) {
              batchItems = arr.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
            }
          } catch {
            /* single payload */
          }
        } else if (!raw.startsWith('{')) {
          const lines = raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
          if (lines.length > 1) {
            batchItems = lines
          }
        }

        if (batchItems.length > 1) {
          let okCount = 0
          const importedNames: string[] = []
          for (const item of batchItems) {
            try {
              const accId = createId('acc_dot')
              const st = await dot.importCredentials({ accountId: accId, rawInput: item })
              const label = st.handle || st.displayName || accId
              addBot({
                id: `bot_${accId}`,
                platformId: 'dot',
                name: `Dot · ${label}`,
                emoji: '🪐',
                accounts: [{ key: accId, accountId: accId, displayName: label, handle: st.handle ?? label }],
                background: true
              })
              okCount++
              importedNames.push(label)
            } catch {
              /* continue remaining items */
            }
          }
          setDotRawInput('')
          await refreshDotStoredMeta()
          if (okCount === 0) {
            setError(desktopCopy("批量导入未成功，请检查每行 AT / RT 或 JSON 格式是否正确", "Couldn’t import accounts. Check each line’s credentials or JSON format."))
          } else {
            setHint(desktopCopy("已批量导入 {0} / {1} 个 Dot 账号：{2}", "Imported {0} of {1} Dot accounts: {2}", [(okCount), (batchItems.length), (importedNames.join('、'))]))
          }
          return
        }
      }

      const accountId = isNew ? createId('acc_dot') : dotTargetAccountId
      const st = await dot.importCredentials({
        accountId,
        rawInput: raw,
        refreshToken: rt || undefined,
        migrateDataFromAccountId: !isNew && dotMigrateMemory ? accountId : undefined
      })
      const label = st.handle || st.displayName || accountId
      if (isNew) {
        const botId = `bot_${accountId}`
        addBot({
          id: botId,
          platformId: 'dot',
          name: `Dot · ${label}`,
          emoji: '🪐',
          accounts: [
            {
              key: accountId,
              accountId,
              displayName: label,
              handle: st.handle ?? label
            }
          ],
          background: true
        })
      } else {
        renameAccount(accountId, label)
        const ownerBot = botsByAccountId.get(accountId)?.[0]
        if (ownerBot && ownerBot.name.startsWith('Dot')) {
          renameBot(ownerBot.id, `Dot · ${label}`)
        }
        await connectAccount(accountId)
      }
      setDotRawInput('')
      setDotRefreshInput('')
      setDotTargetAccountId('__new__')
      await refreshDotStoredMeta()
      const migratedMsg = st.migration
        ? desktopCopy("（已迁移目标 {0}、记忆 {1} 条）", " (goal migrated: {0}; memories migrated: {1})", [(st.migration.goalCopied ? '✓' : '—'), (st.migration.memoriesCopied)])
        : ''
      setHint(
        desktopCopy("已成功导入 Dot 账号：{0}{1} {2}", "Imported Dot account: {0}{1} {2}", [(label), (st.planType ? ` (${st.planType})` : ''), (migratedMsg)])
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{desktopCopy("ChatGPT Dot 账号", "ChatGPT Dot Account")}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">{desktopCopy("支持网页登录或导入凭据，自动加密保存与续期。", "Sign in on the web or import credentials. Saved credentials are encrypted.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={handleQuickAddDotAccount}>
            <Plus className="size-3.5" />{desktopCopy(" 网页登录新增 Dot 账号", " Add a Dot account in the sign-in window")}</Button>
        </div>
      </div>

      {/* Quick Summary Bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
          <p className="text-[12px] text-ink-muted">{desktopCopy("Dot 账号总数", "Total Dot accounts")}</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{dotAccounts.length}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
          <p className="text-[12px] text-ink-muted">{desktopCopy("在线就绪", "Ready")}</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
            {dotAccounts.filter((account) => isOnlineStatus(account.status)).length}
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
          <p className="text-[12px] text-ink-muted">{desktopCopy("RT 自动续期就绪", "Refresh token available")}</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">
            {Object.values(dotMetaMap).filter((m) => m.hasRefreshToken).length}
            <span className="text-[13px] font-normal text-ink-muted"> / {dotAccounts.length}</span>
          </p>
        </div>
      </div>

      {/* AT / RT / JSON Single & Batch Import Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <KeyRound className="size-3.5 text-accent-600" />{desktopCopy("导入 ChatGPT AT / RT / JSON 凭据（支持多行批量导入）", "Import ChatGPT credentials (one account per line)")}</span>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <span>{desktopCopy("导入目标：", "Import destination:")}</span>
            <Select
              size="xs"
              variant="pill"
              value={dotTargetAccountId}
              onValueChange={(next) => setDotTargetAccountId(next)}
              className="max-w-64"
              options={[
                { value: '__new__', label: desktopCopy("+ 新建独立 Dot Bot（支持多行批量导入）", "+ New Independent Dot Bot (supports multi-line batch import)") },
                ...dotAccounts.map((acc) => {
                  const ownerBot = botsByAccountId.get(acc.id)?.[0]
                  return {
                    value: acc.id,
                    label: desktopCopy("替换凭据：{0} ({1})", "Replace credentials: {0} ({1})", [(ownerBot?.name || acc.displayName), (acc.handle || acc.id)])
                  }
                })
              ]}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            ref={dotInputRef}
            value={dotRawInput}
            onChange={(e) => setDotRawInput(e.target.value)}
            placeholder={desktopCopy("粘贴单条或多行（每行一个）ChatGPT access_token (eyJ...)、refresh_token (rt_...) 或 JSON (auth.json / JSON 数组)…", "Paste ChatGPT credentials or JSON (one account per line)…")}
            rows={3}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={dotRefreshInput}
              onChange={(e) => setDotRefreshInput(e.target.value)}
              placeholder={desktopCopy("可选：单账号导入时单独填写 refresh_token (rt_...) 用于自动续期", "Optional: add a refresh token to renew a single imported session.")}
              className="h-8 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || (!dotRawInput.trim() && !dotRefreshInput.trim())}
              onClick={() => void handleImportDotCredentials()}
            >
              {busy
                ? desktopCopy("正在验证…", "Authenticating…")
                : dotTargetAccountId === '__new__'
                  ? desktopCopy("导入并创建 Dot Bot", "Import and create Dot Bot")
                  : desktopCopy("更新该 Bot 凭据", "Update bot credentials")}
            </Button>
          </div>
          {dotTargetAccountId !== '__new__' && (
            <div className="mt-0.5 flex items-center justify-between gap-3 rounded-xl bg-main px-3 py-2 ring-1 ring-line/50 text-[12px] text-ink-secondary">
              <span>{desktopCopy("替换账号时自动迁移当前目标与记忆", "Transfer goals and memories when replacing the account")}</span>
              <SwitchPill checked={dotMigrateMemory} onCheckedChange={setDotMigrateMemory} />
            </div>
          )}
        </div>
      </div>

      {/* Dot Accounts List */}
      {dotAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">{desktopCopy("暂无 Dot 账号", "No Dot accounts yet")}</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">{desktopCopy("点击上方「网页登录新增 Dot 账号」或在上方卡片中粘贴 ChatGPT AT / RT 凭据即可创建 Dot Bot。", "Add a Dot account using the sign-in window or import credentials above.")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
            <span>{desktopCopy("Dot 账号与对应 Bot (", "Dot accounts and bots (")}{dotAccounts.length})</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                for (const acc of dotAccounts) {
                  void connectAccount(acc.id)
                }
                void refreshDotStoredMeta()
              }}
            >
              <RefreshCw className="size-3.5" />{desktopCopy(" 全部重连检验", " Reconnect and check all")}</Button>
          </div>
          <ul className="divide-y divide-line">
            {dotAccounts.map((acc) => {
              const ownerBot = botsByAccountId.get(acc.id)?.[0]
              const meta = dotMetaMap[acc.id]
              return (
                <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                  <div className="flex min-w-0 items-center gap-3">
                    <BotAvatar
                      seed={ownerBot?.id ?? acc.id}
                      avatar={ownerBot?.avatar}
                      avatarShape={ownerBot?.avatarShape}
                      avatarColor={ownerBot?.avatarColor}
                      emoji={ownerBot?.emoji ?? '🪐'}
                      platformId="dot"
                      status={acc.status}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">
                          {ownerBot?.name || acc.displayName}
                        </span>
                        <StatusBadge status={acc.status} />
                        {meta?.planType && (
                          <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[10.5px] uppercase text-ink-secondary">
                            {meta.planType}
                          </span>
                        )}
                        {meta?.hasRefreshToken ? (
                          <span className="rounded bg-status-online/10 px-1.5 py-0.5 text-[10.5px] font-medium text-status-online-ink">{desktopCopy("RT 自动续期已开启", "Automatic refresh enabled")}</span>
                        ) : (
                          <span className="rounded bg-sunken px-1.5 py-0.5 text-[10.5px] text-ink-muted">{desktopCopy("仅 AT 会话", "Access token only")}</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                        <span className="font-mono text-[11px]">{acc.handle || meta?.handle || acc.id}</span>
                        {meta?.mode && (
                          <>
                            <span>·</span>
                            <span>{meta.mode === 'native' ? `Native (${meta.model || 'gpt-6-astra'})` : 'Calpico Room'}</span>
                          </>
                        )}
                        {acc.statusDetail && (
                          <>
                            <span>·</span>
                            <span className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                              {desktopNotice(acc.statusDetail)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {ownerBot && (
                      <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>{desktopCopy("进入对话", "Open conversation")}</Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={acc.pending}
                      onClick={() => void openDotLogin(acc.id)}
                    >{desktopCopy("网页登录", "Sign in on the web")}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDotTargetAccountId(acc.id)
                        dotInputRef.current?.focus()
                      }}
                    >{desktopCopy("替换 AT/RT", "Replace AT/RT")}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void connectAccount(acc.id)}
                    >{desktopCopy("重连", "Reconnect")}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void signOutAccount(acc.id)}
                      title={desktopCopy("退出登录", "Sign out")}
                    >
                      <LogOut className="size-3.5" />
                    </Button>
                    {ownerBot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeBot(ownerBot.id)}
                        title={desktopCopy("删除该账号与 Bot", "Remove this account and its bots")}
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function GrokAccountsSection({
  active, accounts: grokAccounts, botsByAccountId, activity, credentialRevision
}: AccountImportProps) {
  useDesktopLocale()
  const tr = useT()
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const setGrokAccessToken = useBotStore((s) => s.setGrokAccessToken)
  const syncGrokAccountBots = useBotStore((s) => s.syncGrokAccountBots)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const [grokTokenInput, setGrokTokenInput] = useState('')
  const [grokRefreshInput, setGrokRefreshInput] = useState('')
  const [grokTargetAccountId, setGrokTargetAccountId] = useState<string>('__new__')

  useLayoutEffect(() => {
    setGrokTokenInput('')
    setGrokRefreshInput('')
    setGrokTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddGrokAccount = (openInBrowser = false) => {
    // Explicitly adding an account always starts a fresh login partition.
    const accountId = createId('acc')
    const botId = createId('bot')
    addBot({
      id: botId,
      platformId: 'grok',
      name: 'Grok Bot',
      accounts: [{ key: accountId, accountId, displayName: 'Grok Bot', handle: '' }],
      background: true
    })
    void openGrokLogin(accountId, openInBrowser)
  }

  const handleImportGrokToken = async () => {
    const token = grokTokenInput.trim()
    const rt = grokRefreshInput.trim() || undefined
    if (!token) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = grokTargetAccountId === '__new__' || !accounts[grokTargetAccountId]
      const accountId = isNew ? createId('acc') : grokTargetAccountId
      await setGrokAccessToken(accountId, token, undefined, undefined, rt)
      const latestAcc = useBotStore.getState().accounts[accountId]
      if (latestAcc?.status === 'error') {
        setError(latestAcc.statusDetail || tr("Credentials are invalid or expired. Check them and try again."))
        return
      }
      const totalBots = await syncGrokAccountBots(accountId, {
        includeDismissed: true,
        selectFirst: isNew
      })
      setGrokTokenInput('')
      setGrokRefreshInput('')
      setGrokTargetAccountId('__new__')
      setHint(
        isNew
          ? tr("Grok account connected. Bots synced to the sidebar: {n}.", { n: totalBots })
          : tr("Credentials updated. Bots synced: {n}.", { n: totalBots })
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr("Grok Bot accounts")}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            {tr("Sign in to list the bots from your Grok account in the sidebar.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => handleQuickAddGrokAccount(false)}>
            <Plus className="size-3.5" /> {tr("Add account in sign-in window")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleQuickAddGrokAccount(true)}>
            <Globe className="size-3.5" /> {tr("Sign in with your browser")}
          </Button>
        </div>
      </div>

      {/* Credential Import Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">{tr("Import credentials (token, cookie, JSON, or API key)")}</span>
          <Select
            size="xs"
            variant="pill"
            value={grokTargetAccountId}
            onValueChange={(next) => setGrokTargetAccountId(next)}
            className="max-w-64"
            options={[
              { value: '__new__', label: tr("+ Connect a new Grok account") },
              ...grokAccounts.map((acc) => ({
                value: acc.id,
                label: tr("Update credentials: {account}", { account: acc.handle || acc.displayName || acc.id })
              }))
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            value={grokTokenInput}
            onChange={(e) => setGrokTokenInput(e.target.value)}
            placeholder={tr("Paste credentials…")}
            rows={2}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex gap-2">
            <input
              value={grokRefreshInput}
              onChange={(e) => setGrokRefreshInput(e.target.value)}
              placeholder={tr("Optional refresh token")}
              className="h-8 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none focus:border-accent-600"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !grokTokenInput.trim()}
              onClick={() => void handleImportGrokToken()}
            >
              {busy ? tr("Verifying…") : grokTargetAccountId === '__new__' ? tr("Import and sync bots") : tr("Update credentials")}
            </Button>
          </div>
        </div>
      </div>

      {/* Grok Accounts List */}
      {grokAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">{tr("No Grok Bot accounts yet")}</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">
            {tr("Sign in or import credentials to see your bots in the sidebar.")}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {grokAccounts.map((acc) => {
              const accountBots = (botsByAccountId.get(acc.id) ?? []).filter((b) => b.platformId === 'grok')
              const ownerBot = accountBots[0]
              return (
                <li key={acc.id} className="flex flex-col gap-2.5 px-4 py-3.5 hover:bg-hover/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <BotAvatar
                        seed={ownerBot?.id ?? acc.id}
                        avatar={ownerBot?.avatar}
                        avatarShape={ownerBot?.avatarShape}
                        avatarColor={ownerBot?.avatarColor}
                        platformId="grok"
                        status={acc.status}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {acc.handle || acc.displayName || tr("Grok Bot account")}
                          </span>
                          <StatusBadge status={acc.status} />
                          <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary">
                            {tr("Bots: {n}", { n: accountBots.length })}
                          </span>
                        </div>
                        {acc.statusDetail && (
                          <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                            {desktopNotice(acc.statusDetail)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={acc.pending}
                        onClick={() => void openGrokLogin(acc.id, false)}
                      >
                        {tr("Sign-in window")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={acc.pending}
                        onClick={() => void openGrokLogin(acc.id, true)}
                      >
                        {tr("Browser sign-in")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending || busy}
                        onClick={() => {
                          void connectAccount(acc.id).then(() =>
                            syncGrokAccountBots(acc.id, { includeDismissed: true })
                          )
                        }}
                      >
                        {tr("Sync all bots")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending}
                        onClick={() => void signOutAccount(acc.id)}
                        title={tr("Sign out")}
                      >
                        <LogOut className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          for (const b of accountBots) {
                            await removeBot(b.id)
                          }
                        }}
                        title={tr("Remove this account and its bots")}
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    </div>
                  </div>

                  {accountBots.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pl-12">
                      {accountBots.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => selectBot(b.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1 text-[12px] text-ink transition-colors hover:border-line-strong hover:bg-hover"
                        >
                          <BotAvatar
                            seed={b.id}
                            avatar={b.avatar}
                            avatarShape={b.avatarShape}
                            avatarColor={b.avatarColor}
                            platformId="grok"
                            size="xs"
                          />
                          <span className="max-w-[160px] truncate">{b.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function HarkAccountsSection({
  active, accounts: harkAccounts, botsByAccountId, activity, credentialRevision
}: AccountImportProps) {
  useDesktopLocale()
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const openHarkLogin = useBotStore((s) => s.openHarkLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const [harkRawInput, setHarkRawInput] = useState('')
  const [harkTargetAccountId, setHarkTargetAccountId] = useState<string>('__new__')

  useLayoutEffect(() => {
    setHarkRawInput('')
    setHarkTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddHarkAccount = async () => {
    const accountId = await quickAddProxyAccount('hark', 'Hark', activity)
    if (accountId) void openHarkLogin(accountId)
  }

  const handleImportHarkCredentials = async () => {
    const hark = getBridge()?.hark
    if (!hark?.importCredentials || !harkRawInput.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = harkTargetAccountId === '__new__' || !accounts[harkTargetAccountId]
      const targetId = isNew ? createId('acc_hark') : harkTargetAccountId
      const st = await importHarkCredentialsForAccount(hark, targetId, harkRawInput)
      const botCount = useBotStore.getState().bots.filter((bot) => bot.platformId === 'hark').length
      const label = st.displayName || st.handle || `Hark ${botCount + 1}`
      if (isNew) {
        addBot({
          id: `bot_${targetId}`,
          platformId: 'hark',
          name: `Hark · ${label}`,
          emoji: '✨',
          accounts: [{ key: targetId, accountId: targetId, displayName: label, handle: st.handle ?? '' }],
          background: true
        })
      } else {
        renameAccount(targetId, label)
        await connectAccount(targetId)
      }
      setHarkRawInput('')
      setHarkTargetAccountId('__new__')
      setHint(desktopCopy("已成功导入 Hark 账号：{0} ({1}) 并同步对话历史", "Successfully imported Hark account: {0} ({1}) and synchronized conversation history", [(label), (st.handle || targetId)]))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{desktopCopy("Hark 账号", "Hark Account")}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">{desktopCopy("支持内置窗口登录或直接粘贴会话凭据接入。", "Sign in in the built-in window or import session credentials.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddHarkAccount()}>
            <Plus className="size-3.5" />{desktopCopy(" 网页登录新增 Hark 账号", " Add a Hark account in the sign-in window")}</Button>
        </div>
      </div>

      {/* Hark Cookie / Token Import Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">{desktopCopy("导入 Hark Session Cookie / Token", "Import a Hark session cookie or token")}</span>
          <Select
            size="xs"
            variant="pill"
            value={harkTargetAccountId}
            onValueChange={(next) => setHarkTargetAccountId(next)}
            className="max-w-64"
            options={[
              { value: '__new__', label: desktopCopy("+ 新建独立 Hark Bot", "+ New Independent Hark Bot") },
              ...harkAccounts.map((acc) => {
                const ownerBot = botsByAccountId.get(acc.id)?.[0]
                return {
                  value: acc.id,
                  label: desktopCopy("更新会话：{0} ({1})", "Update session: {0} ({1})", [(ownerBot?.name || acc.displayName), (acc.handle || acc.id)])
                }
              })
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            value={harkRawInput}
            onChange={(e) => setHarkRawInput(e.target.value)}
            placeholder={desktopCopy("粘贴 Hark Cookie 字符串（如 __Secure-hark.session_token=...）、JSON Cookie 数组或原始 Session Token…", "Paste a Hark session cookie, token, or JSON…")}
            rows={2}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !harkRawInput.trim()}
              onClick={() => void handleImportHarkCredentials()}
            >
              {busy
                ? desktopCopy("正在验证会话…", "Verifying session…")
                : harkTargetAccountId === '__new__'
                  ? desktopCopy("导入并新建 Hark Bot", "Import and create Hark bot")
                  : desktopCopy("更新该账号会话", "Update this account’s session")}
            </Button>
          </div>
        </div>
      </div>

      {harkAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">{desktopCopy("暂无 Hark 账号", "No Hark accounts yet")}</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">{desktopCopy("点击上方「网页登录新增 Hark 账号」或在卡片中粘贴 Cookie / Session Token 即可接入。", "Add a Hark account using the sign-in window or import credentials above.")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {harkAccounts.map((acc) => {
              const ownerBot = botsByAccountId.get(acc.id)?.[0]
              return (
                <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                  <div className="flex min-w-0 items-center gap-3">
                    <BotAvatar
                      seed={ownerBot?.id ?? acc.id}
                      avatar={ownerBot?.avatar}
                      avatarShape={ownerBot?.avatarShape}
                      avatarColor={ownerBot?.avatarColor}
                      status={acc.status}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">
                          {ownerBot?.name || acc.displayName}
                        </span>
                        <StatusBadge status={acc.status} />
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                        {acc.handle || acc.id}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {ownerBot && (
                      <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>{desktopCopy("进入对话", "Open conversation")}</Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={acc.pending}
                      onClick={() => void openHarkLogin(acc.id)}
                    >{desktopCopy("登录窗口", "Sign-in window")}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void connectAccount(acc.id)}
                    >{desktopCopy("刷新会话", "Refresh Session")}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void signOutAccount(acc.id)}
                      title={desktopCopy("退出登录", "Sign out")}
                    >
                      <LogOut className="size-3.5" />
                    </Button>
                    {ownerBot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeBot(ownerBot.id)}
                        title={desktopCopy("删除", "Delete")}
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function AntigravityAccountsSection({ accounts: antigravityAccounts, botsByAccountId }: AccountListProps) {
  useDesktopLocale()
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{desktopCopy("Antigravity 账号", "Antigravity Account")}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">{desktopCopy("独立隔离登录 Google Antigravity，支持多账号、模型切换与流式对话。", "Connect Antigravity accounts separately, switch models, and stream chat.")}</p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => useBotStore.getState().setAddBotOpen(true, 'antigravity')}
        >{desktopCopy("添加 Antigravity 账号", "Add Antigravity Account")}</Button>
      </div>

      {antigravityAccounts.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <p className="text-[13.5px] font-medium text-ink">{desktopCopy("尚未添加 Google Antigravity 账号", "No Google Antigravity account added yet")}</p>
          <p className="mt-1 text-[12px] text-ink-muted">{desktopCopy("点击右上角「添加 Antigravity 账号」，在弹出的安全登录窗口完成 Google 登录即可。", "Choose Add Antigravity account, then sign in to Google.")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {antigravityAccounts.map((acc) => {
              const bot = botsByAccountId.get(acc.id)?.find((b) => b.platformId === 'antigravity')
              const online = isOnlineStatus(acc.status)
              return (
                <li
                  key={acc.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-ink">
                        {bot?.name || acc.displayName}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          online
                            ? 'bg-status-online/15 text-status-online-ink'
                            : 'bg-sunken text-ink-muted'
                        )}
                      >
                        {online ? desktopCopy("在线", "Online") : desktopCopy("离线", "Offline")}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-muted">
                      {acc.handle || acc.id}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void useBotStore.getState().openAntigravityLogin(acc.id)}
                    >
                      {online ? desktopCopy("重新登录", "Sign in again") : desktopCopy("登录", "Login")}
                    </Button>
                    {bot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          useBotStore.getState().selectBot(bot.id)
                          setSettingsOpen(false)
                        }}
                      >{desktopCopy("打开对话", "Open conversation")}</Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function CueAccountsSection({
  active, accounts: cueAccounts, botsByAccountId, activity, credentialRevision
}: AccountImportProps) {
  useDesktopLocale()
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const selectBot = useBotStore((s) => s.selectBot)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const importCueCredentials = useBotStore((s) => s.importCueCredentials)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const [cueCredentialInput, setCueCredentialInput] = useState('')
  const [cueTargetAccountId, setCueTargetAccountId] = useState('__new__')

  useLayoutEffect(() => {
    setCueCredentialInput('')
    setCueTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddCueAccount = async (openInBrowser = false) => {
    const accountId = await quickAddProxyAccount('cue', 'Cue', activity)
    if (accountId) void openCueLogin(accountId, openInBrowser)
  }


  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{desktopCopy("Cue 账号", "Cue Account")}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">{desktopCopy("独立隔离登录 Cue（cue.im），通过 Cue 桌面端原生协议同步各 Agent 与历史消息并直连流式对话；亦可选填 Manus API Key（sk-...）。", "Sign in to Cue to sync agents, history, and streamed conversations. A Manus API key is optional.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddCueAccount(false)}>
            <Plus className="size-3.5" />{desktopCopy(" 网页登录新增 Cue 账号", " Add a Cue account in the sign-in window")}</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleQuickAddCueAccount(true)}>
            <Globe className="size-3.5" />{desktopCopy(" 系统浏览器登录", " Sign in with your browser")}</Button>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">{desktopCopy("导入 Cue 会话 Cookie / Token / 凭据（可选）", "Import Cue Session Cookie / Token / Credentials (optional)")}</span>
          <Select
            size="xs"
            variant="pill"
            value={cueTargetAccountId}
            onValueChange={(next) => setCueTargetAccountId(next)}
            className="max-w-64"
            options={[
              { value: '__new__', label: desktopCopy("+ 新建独立 Cue 账号", "+ New Independent Cue Account") },
              ...cueAccounts.map((acc) => ({
                value: acc.id,
                label: desktopCopy("更新会话：{0}", "Update Session: {0}", [(acc.handle || acc.displayName || acc.id)])
              }))
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={desktopCopy("Cue 会话凭据", "Cue session credentials")}
            value={cueCredentialInput}
            onChange={(e) => setCueCredentialInput(e.target.value)}
            placeholder={desktopCopy("粘贴 Manus API Key（sk-...）、Cue Cookie（cue_session_id=...）或 Bearer Token (eyJ...)…", "Paste Manus API Key (sk-...), Cue Cookie (cue_session_id=...) or Bearer Token (eyJ...)…")}
            rows={2}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !cueCredentialInput.trim()}
              onClick={async () => {
                setBusy(true)
                setError(undefined)
                setHint(undefined)
                try {
                  const isNew = cueTargetAccountId === '__new__' || !accounts[cueTargetAccountId]
                  const targetId = isNew ? createId('acc_cue') : cueTargetAccountId
                  await importCueCredentials(targetId, cueCredentialInput.trim())
                  setCueCredentialInput('')
                  setCueTargetAccountId('__new__')
                  setHint(isNew ? desktopCopy("已导入并新建 Cue 账号，可在侧栏进入会话", "Imported a Cue account. Open its conversation in the sidebar.") : desktopCopy("已更新 Cue 账号会话", "Cue Account Session updated"))
                } catch (err) {
                  setError(errorMessage(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? desktopCopy("正在验证会话…", "Verifying session…") : cueTargetAccountId === '__new__' ? desktopCopy("导入并新建 Cue Bot", "Import and create Cue bot") : desktopCopy("更新该账号会话", "Update this account’s session")}
            </Button>
          </div>
        </div>
      </div>

      {cueAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">{desktopCopy("暂无 Cue 账号", "No Cue accounts yet")}</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">{desktopCopy("点击上方「网页登录新增 Cue 账号」在内置隔离窗口登录，或在卡片中粘贴 Cookie / Token 即可接入。", "Add a Cue account using the sign-in window or import credentials above.")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {cueAccounts.map((acc) => {
              const accountBots = (botsByAccountId.get(acc.id) ?? []).filter((b) => b.platformId === 'cue')
              const ownerBot = accountBots[0]
              return (
                <li key={acc.id} className="flex flex-col gap-2.5 px-4 py-3.5 hover:bg-hover/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <BotAvatar
                        seed={ownerBot?.id ?? acc.id}
                        platformId="cue"
                        status={acc.status}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {ownerBot?.name || acc.handle || acc.displayName || desktopCopy("Cue 账号", "Cue Account")}
                          </span>
                          <StatusBadge status={acc.status} />
                          <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary">
                            {accountBots.length}{desktopCopy(" 个 Bot", " bots")}</span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                          {acc.handle || acc.id}
                        </p>
                        {acc.statusDetail && (
                          <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                            {desktopNotice(acc.statusDetail)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {ownerBot && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            selectBot(ownerBot.id)
                            setSettingsOpen(false)
                          }}
                        >{desktopCopy("进入对话", "Open conversation")}</Button>
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={acc.pending || busy}
                        onClick={() => void openCueLogin(acc.id, false)}
                      >{desktopCopy("登录窗口", "Sign-in window")}</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending || busy}
                        onClick={() => void connectAccount(acc.id)}
                      >{desktopCopy("刷新会话", "Refresh Session")}</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending || busy}
                        onClick={() => void syncCueAccountBots(acc.id)}
                      >{desktopCopy("同步 Bot", "Sync bots")}</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending}
                        onClick={() => void signOutAccount(acc.id)}
                        title={desktopCopy("退出登录", "Sign out")}
                      >
                        <LogOut className="size-3.5" />
                      </Button>
                      {ownerBot && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeBot(ownerBot.id)}
                          title={desktopCopy("删除", "Delete")}
                        >
                          <Trash2 className="size-3.5 text-status-error" />
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

interface PlatformAccountsSectionProps {
  tab: SettingsTab
  accountsByPlatform: ReadonlyMap<PlatformId, BotAccount[]>
  botsByAccountId: ReadonlyMap<string, Bot[]>
  activity: SettingsActivity
  credentialRevision: number
  proxyPool: MuseProxyPool
  dot: Pick<ReturnType<typeof useDotStoredMeta>, 'dotMetaMap' | 'refresh'>
}

export function PlatformAccountsSection({
  tab, accountsByPlatform, botsByAccountId, activity, credentialRevision, proxyPool, dot
}: PlatformAccountsSectionProps) {
  const importProps = { botsByAccountId, activity, credentialRevision }

  // Keep import drafts across tab switches while only rendering the active account panel.
  return (
    <>
      <MuseAccountsSection
        active={tab === 'muse-accounts'}
        accounts={accountsByPlatform.get('meta-muse') ?? EMPTY_ACCOUNTS}
        botsByAccountId={botsByAccountId}
        activity={activity}
        proxyPool={proxyPool}
      />
      <DotAccountsSection
        {...importProps}
        active={tab === 'dot-accounts'}
        accounts={accountsByPlatform.get('dot') ?? EMPTY_ACCOUNTS}
        dotMetaMap={dot.dotMetaMap}
        refreshDotStoredMeta={dot.refresh}
      />
      <GrokAccountsSection
        {...importProps}
        active={tab === 'grok-accounts'}
        accounts={accountsByPlatform.get('grok') ?? EMPTY_ACCOUNTS}
      />
      <HarkAccountsSection
        {...importProps}
        active={tab === 'hark-accounts'}
        accounts={accountsByPlatform.get('hark') ?? EMPTY_ACCOUNTS}
      />
      {tab === 'antigravity-accounts' && (
        <AntigravityAccountsSection
          accounts={accountsByPlatform.get('antigravity') ?? EMPTY_ACCOUNTS}
          botsByAccountId={botsByAccountId}
        />
      )}
      <CueAccountsSection
        {...importProps}
        active={tab === 'cue-accounts'}
        accounts={accountsByPlatform.get('cue') ?? EMPTY_ACCOUNTS}
      />
    </>
  )
}
