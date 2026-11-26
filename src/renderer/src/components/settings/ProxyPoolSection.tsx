import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Activity, FileUp, Loader2, Shuffle, Trash2 } from 'lucide-react'
import type { MuseProxyPoolItemView, MuseProxyScheme, MuseProxyTestResult, MuseProxyView } from '@shared/ipc'
import type { PlatformId } from '@adapters/types'
import { getPlatform } from '@adapters/platforms'
import { Button } from '@/components/ui/Button'
import { NumberStepper } from '@/components/ui/Controls'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { autoAssignProxyPool, useBotStore } from '@/store/botStore'
import { usePrefsStore } from '@/store/prefsStore'
import type { Bot } from '@/types'
import { errorMessage } from './PlatformAccountsSection'
import type { SettingsActivity, SettingsTab } from './SettingsView'

const PROXY_PLACEHOLDER = `# 支持每行一个代理（自动识别格式）：
https://user:pass@proxy.example.com:443
http://user:pass@127.0.0.1:7890
socks5://user:pass@127.0.0.1:1080
socks5h://127.0.0.1:1080
192.168.1.10:1080:username:password
127.0.0.1:7890`

export function useProxyPool(
  settingsTab: SettingsTab,
  museAccountCount: number,
  cleaning: RefObject<boolean>,
  { setBusy, setError, setHint }: SettingsActivity
) {
  const [pool, setPool] = useState<MuseProxyPoolItemView[]>([])
  const [accountProxies, setAccountProxies] = useState<Record<string, MuseProxyView>>({})
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const { settingsOpen, settingsTab, accounts } = useBotStore.getState()
    if (cleaning.current || !settingsOpen || !['overview', 'muse-accounts', 'proxy-pool'].includes(settingsTab)) return
    const muse = getBridge()?.muse
    if (!muse) return
    const request = ++requestId.current
    const isCurrent = () => {
      const state = useBotStore.getState()
      return state.settingsOpen && state.settingsTab === settingsTab && requestId.current === request
    }
    try {
      if (muse.listProxyPool) {
        const items = await muse.listProxyPool()
        if (!isCurrent()) return
        setPool(items)
      }
      if (settingsTab === 'muse-accounts' && muse.getProxy) {
        const ids = Object.values(accounts)
          .filter((account) => account.platformId === 'meta-muse')
          .map((account) => account.id)
        const results = await Promise.allSettled(ids.map(async (id) => [id, await muse.getProxy(id)] as const))
        if (!isCurrent()) return
        setAccountProxies(Object.fromEntries(
          results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
        ))
      }
    } catch (err) {
      if (isCurrent()) setError(errorMessage(err))
    }
  }, [cleaning, setError])

  const invalidate = useCallback(() => {
    requestId.current++
  }, [])
  useLayoutEffect(() => invalidate, [invalidate, settingsTab])
  useEffect(() => {
    void refresh()
  }, [refresh, settingsTab, museAccountCount])

  const clear = () => {
    setPool([])
    setAccountProxies({})
  }

  // GOXF fork (cbd4890): assign by the platforms ticked in the pool settings and the per-proxy limit.
  const assignMuseProxies = async () => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await autoAssignProxyPool()
      if (res) setPool(res.items)
      setHint(`已为勾选平台的 ${res?.assignedCount ?? 0} 个账号分配代理`)
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return { pool, accountProxies, setPool, refresh, invalidate, clear, assignMuseProxies }
}

interface ProxyPoolSectionProps {
  active: boolean
  credentialRevision: number
  museAccountCount: number
  botsByAccountId: ReadonlyMap<string, Bot[]>
  activity: SettingsActivity
  proxyPool: ReturnType<typeof useProxyPool>
}

export function ProxyPoolSection({
  active, credentialRevision, activity, proxyPool
}: ProxyPoolSectionProps) {
  const tr = useT()
  const accounts = useBotStore((s) => s.accounts)
  const bots = useBotStore((s) => s.bots)
  const { busy, setBusy, setError, setHint } = activity
  const { pool, setPool, refresh, assignMuseProxies } = proxyPool
  const [rawProxyText, setRawProxyText] = useState('')
  const [defaultMode, setDefaultMode] = useState<MuseProxyScheme>('socks5')
  const proxyAssignPlatforms = usePrefsStore((s) => s.proxyAssignPlatforms)
  const setProxyAssignPlatforms = usePrefsStore((s) => s.setProxyAssignPlatforms)
  const proxyPerProxyLimit = usePrefsStore((s) => s.proxyPerProxyLimit)
  const setProxyPerProxyLimit = usePrefsStore((s) => s.setProxyPerProxyLimit)
  const accountPlatformIds = useMemo(
    () => [...new Set(Object.values(accounts).map((a) => a.platformId))] as PlatformId[],
    [accounts]
  )
  const [testResults, setTestResults] = useState<Record<string, MuseProxyTestResult>>({})
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set())
  const [testingAll, setTestingAll] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    setRawProxyText('')
    setTestResults({})
    setTestingIds(new Set())
    setTestingAll(false)
  }, [credentialRevision])

  if (!active) return null

  const accountLabel = (accId: string) =>
    bots.find((b) => b.accountIds.includes(accId))?.name || accounts[accId]?.displayName || accId

  const latencyBadgeClass = (ms: number | undefined): string => {
    if (typeof ms !== 'number') return 'bg-status-online/10 text-status-online-ink'
    if (ms < 300) return 'bg-status-online/10 text-status-online-ink'
    if (ms < 800) return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    return 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
  }

  const handleTestPool = async (ids?: string[]) => {
    const muse = getBridge()?.muse
    if (!muse?.testProxyPool || pool.length === 0) return
    const targetIds = ids && ids.length > 0 ? ids : pool.map((item) => item.id)
    const isAll = !ids || ids.length === 0
    if (isAll) setTestingAll(true)
    setTestingIds((prev) => {
      const next = new Set(prev)
      for (const id of targetIds) next.add(id)
      return next
    })
    setError(undefined)
    if (isAll) setHint(undefined)
    try {
      const res = await muse.testProxyPool(isAll ? undefined : targetIds)
      setTestResults((prev) => ({ ...prev, ...res }))
      // GOXF fork: main remembers the result as `lastTest` (timed-out proxies are skipped by auto-assign).
      setPool(await muse.listProxyPool())
      if (isAll) {
        const values = Object.values(res)
        const okValues = values.filter((r) => r.ok)
        const avgMs =
          okValues.length > 0
            ? Math.round(
                okValues.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / okValues.length
              )
            : null
        setHint(
          avgMs !== null
            ? `代理检测完成：${okValues.length} / ${values.length} 可用（平均延迟 ${avgMs} ms）`
            : `代理检测完成：0 / ${values.length} 可用`
        )
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      if (isAll) setTestingAll(false)
      setTestingIds((prev) => {
        const next = new Set(prev)
        for (const id of targetIds) next.delete(id)
        return next
      })
    }
  }

  const failedIds = pool.filter((item) => testResults[item.id]?.ok === false).map((item) => item.id)

  const handleRemoveFailed = async () => {
    const muse = getBridge()?.muse
    if (!muse?.removeProxyPoolItem || failedIds.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      let next = pool
      for (const id of failedIds) {
        next = await muse.removeProxyPoolItem(id)
      }
      setPool(next)
      setTestResults((prev) => {
        const copy = { ...prev }
        for (const id of failedIds) delete copy[id]
        return copy
      })
      setHint(`已移除 ${failedIds.length} 个失效代理`)
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleImportPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.importProxyPool || !rawProxyText.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await muse.importProxyPool(rawProxyText, defaultMode)
      setRawProxyText('')
      setPool(res.items)
      const assigned = await autoAssignProxyPool()
      if (assigned) setPool(assigned.items)
      setHint(
        `已导入 ${res.added} 个代理（池共 ${res.total} 个）` +
          (assigned ? `，已为勾选平台的 ${assigned.assignedCount} 个账号分配代理` : '；勾选平台的新账号会自动分配')
      )
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRemovePoolItem = async (id: string) => {
    const muse = getBridge()?.muse
    if (!muse?.removeProxyPoolItem) return
    const next = await muse.removeProxyPoolItem(id)
    setPool(next)
    setTestResults((prev) => {
      if (!(id in prev)) return prev
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    await refresh()
  }

  const handleClearPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.clearProxyPool) return
    const next = await muse.clearProxyPool()
    setPool(next)
    setTestResults({})
    setHint('已清空代理池，用过池中代理的账号已改回跟随系统')
    await refresh()
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('Proxy pool')}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            批量导入代理，按勾选的平台和每个代理的账号上限自动分配；密码用系统钥匙串加密。
          </p>
        </div>
        {pool.length > 0 && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void assignMuseProxies()}>
            <Shuffle className="size-3.5" /> 按设置分配给现有账号
          </Button>
        )}
      </div>

      {/* Proxy Pool Importer Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-ink">导入代理</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
              <span>无协议前缀时默认：</span>
              <Select
                size="xs"
                variant="pill"
                value={defaultMode}
                onValueChange={(next) => setDefaultMode(next)}
                className="w-40"
                options={[
                  { value: 'socks5', label: 'SOCKS5' },
                  { value: 'socks5h', label: 'SOCKS5H (远程 DNS)' },
                  { value: 'http', label: 'HTTP' },
                  { value: 'https', label: 'HTTPS (TLS)' }
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-canvas px-2.5 text-[12px] text-ink-secondary hover:bg-hover hover:text-ink"
            >
              <FileUp className="size-3.5" /> 从 .txt 导入
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              hidden
              onChange={(ev) => {
                const file = ev.target.files?.[0]
                ev.target.value = ''
                if (file) {
                  void file.text().then((txt) =>
                    setRawProxyText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${txt}` : txt))
                  )
                }
              }}
            />
          </div>
        </div>
        <textarea
          value={rawProxyText}
          onChange={(e) => setRawProxyText(e.target.value)}
          placeholder={PROXY_PLACEHOLDER}
          rows={5}
          spellCheck={false}
          className="block w-full resize-none rounded-xl border border-line bg-canvas p-3 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
        />
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="mr-1 text-ink-secondary">分配给</span>
          {accountPlatformIds.length === 0 && <span className="text-ink-muted">还没有账号</span>}
          {accountPlatformIds.map((pid) => {
            const on = proxyAssignPlatforms.includes(pid)
            return (
              <button
                key={pid}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setProxyAssignPlatforms(on ? proxyAssignPlatforms.filter((x) => x !== pid) : [...proxyAssignPlatforms, pid])
                }
                className={cn(
                  'press h-7 rounded-full border px-3 text-[12px] transition-colors',
                  on ? 'border-accent-300 bg-accent-50 text-accent-600' : 'border-line text-ink-secondary hover:bg-hover hover:text-ink'
                )}
              >
                {getPlatform(pid).name}
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <span>每个代理最多</span>
            <NumberStepper
              value={proxyPerProxyLimit}
              onChange={setProxyPerProxyLimit}
              min={0}
              max={99}
              aria-label="每个代理最多账号数"
            />
            <span className="text-ink-muted">
              {proxyPerProxyLimit === 0 ? '0 = 不限，平均分摊' : '个账号 · 1 就是一号一代理'}
            </span>
          </div>
          <Button variant="primary" size="sm" disabled={busy || !rawProxyText.trim()} onClick={() => void handleImportPool()}>
            导入并分配
          </Button>
        </div>
      </div>

      {/* Current Pool List */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
          <span>代理池列表 ({pool.length})</span>
          {pool.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {getBridge()?.muse?.testProxyPool && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || testingAll}
                  onClick={() => void handleTestPool()}
                >
                  {testingAll ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Activity className="size-3.5" aria-hidden />
                  )}
                  {testingAll ? '测速中…' : '全部测速'}
                </Button>
              )}
              {failedIds.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || testingAll}
                  onClick={() => void handleRemoveFailed()}
                >
                  移除失效 ({failedIds.length})
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy || testingAll} onClick={() => void handleClearPool()}>
                清空代理池
              </Button>
            </div>
          )}
        </div>
        {pool.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-muted">代理池为空，请在上方粘贴导入代理</p>
        ) : (
          <ul className="divide-y divide-line">
            {pool.map((item, idx) => {
              const n = item.assignedAccountIds.length
              // Session result from this screen first; else the last result main remembered.
              const probe: MuseProxyTestResult | undefined =
                testResults[item.id] ??
                (item.lastTest
                  ? { ok: item.lastTest.ok, latencyMs: item.lastTest.ms, exitIp: item.lastTest.ip, error: item.lastTest.error, checkedAt: 0 }
                  : undefined)
              const isTestingItem = testingIds.has(item.id)
              const probeTooltip = probe
                ? probe.ok
                  ? [
                      typeof probe.latencyMs === 'number' ? `延迟 ${probe.latencyMs} ms` : null,
                      probe.country ? `地区 ${probe.country}` : null,
                      probe.exitIp ? `出口 IP ${probe.exitIp}` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : probe.error || '代理不可用'
                : undefined
              return (
                <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="w-6 font-mono text-[11px] text-ink-muted">#{idx + 1}</span>
                    <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] uppercase text-ink-secondary">
                      {item.mode}
                    </span>
                    <span className="truncate font-mono text-[13px] text-ink">
                      {item.username ? `${item.username}${item.hasPassword ? ':***' : ''}@` : ''}
                      {item.host}:{item.port}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isTestingItem ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                        检测中…
                      </span>
                    ) : probe ? (
                      probe.ok ? (
                        <span
                          title={probeTooltip}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${latencyBadgeClass(probe.latencyMs)}`}
                        >
                          {typeof probe.latencyMs === 'number' ? `${probe.latencyMs} ms` : '可用'}
                          {probe.country ? ` · ${probe.country}` : ''}
                        </span>
                      ) : (
                        <span
                          title={probeTooltip}
                          className="inline-flex items-center rounded-full bg-status-error/10 px-2 py-0.5 text-[11px] font-medium text-status-error"
                        >
                          不可用
                        </span>
                      )
                    ) : null}
                    <span className="flex min-w-0 max-w-[320px] flex-wrap items-center justify-end gap-1">
                      {item.assignedAccountIds.map((accId) => (
                        <span key={accId} className="max-w-[120px] truncate rounded-full bg-status-online/10 px-2 py-0.5 text-[11.5px] font-medium text-status-online-ink">
                          {accountLabel(accId)}
                        </span>
                      ))}
                      {n === 0 ? (
                        <span className="rounded-full bg-sunken px-2.5 py-0.5 text-[11.5px] text-ink-muted">空闲待分配</span>
                      ) : proxyPerProxyLimit > 0 ? (
                        <span className="text-[11.5px] tabular-nums text-ink-muted">{`${n}/${proxyPerProxyLimit}`}</span>
                      ) : null}
                    </span>
                    {getBridge()?.muse?.testProxyPool && (
                      <button
                        type="button"
                        disabled={isTestingItem || testingAll}
                        onClick={() => void handleTestPool([item.id])}
                        className="rounded-full p-1 text-ink-muted hover:bg-hover hover:text-ink disabled:opacity-40"
                        title="测试可用性与延迟"
                      >
                        <Activity className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleRemovePoolItem(item.id)}
                      className="rounded-full p-1 text-ink-muted hover:bg-hover hover:text-status-error"
                      title="移除代理（用它的账号改回跟随系统）"
                      aria-label="移除代理"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <p className="text-[12px] text-ink-muted">
        超时的代理不参与自动分配；勾选的平台会记住，之后新加的账号自动分配。手动在账号侧栏「网络代理」里选的代理不受上限限制。
      </p>
    </div>
  )
}
